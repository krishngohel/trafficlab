"""IPPO: clipped PPO with GAE over one actor-critic shared by every agent.

Implements the Trainer protocol from docs/RL_DESIGN.md. Parameter sharing:
a single ActorCritic serves all agents, and every agent's transition at every
decision step becomes a row of the shared rollout (kept as one GAE chain per
agent so advantages never mix agents' reward streams). When the rollout is
full, the policy takes ``epochs`` passes of clipped-surrogate updates over
shuffled minibatches that combine rows from all agents, with advantages
normalized per minibatch. Value bootstraps across episode truncation
(continuing task).

Defaults (overridable through ``cfg.algo_kwargs``): rollout 2048 agent-steps,
4 epochs, minibatch 256, clip 0.2, GAE lambda 0.95, entropy coef 0.01,
value coef 0.5, grad clip 0.5.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import torch
import torch.nn.functional as F

from .buffers import RolloutBuffer
from .nets import ActorCritic

if TYPE_CHECKING:
    from ..env import TrafficEnv
    from .harness import RunConfig

ROLLOUT_STEPS = 2048        # agent-steps in the shared rollout
EPOCHS = 4
MINIBATCH = 256             # rows per PPO minibatch (across all agents)
CLIP = 0.2
GAE_LAMBDA = 0.95
ENTROPY_COEF = 0.01
VALUE_COEF = 0.5
GRAD_CLIP = 0.5


def ppo_loss(new_logp: torch.Tensor, old_logp: torch.Tensor,
             advantages: torch.Tensor, values: torch.Tensor,
             returns: torch.Tensor, entropy: torch.Tensor, *,
             clip: float = CLIP, value_coef: float = VALUE_COEF,
             entropy_coef: float = ENTROPY_COEF) -> tuple[torch.Tensor, dict[str, float]]:
    """Clipped-surrogate PPO loss over one minibatch of rows.

    loss = -mean(min(r*A, clamp(r, 1-clip, 1+clip)*A))
           + value_coef * mean((V - R)^2) - entropy_coef * mean(H)
    with r = exp(new_logp - old_logp). Advantages are used as given
    (normalization, when wanted, happens before this call).
    """
    ratio = torch.exp(new_logp - old_logp)
    surrogate = torch.minimum(ratio * advantages,
                              torch.clamp(ratio, 1.0 - clip, 1.0 + clip) * advantages)
    policy_loss = -surrogate.mean()
    value_loss = ((values - returns) ** 2).mean()
    ent = entropy.mean()
    loss = policy_loss + value_coef * value_loss - entropy_coef * ent
    metrics = {
        "policy_loss": float(policy_loss.detach()),
        "value_loss": float(value_loss.detach()),
        "entropy": float(ent.detach()),
        "clip_frac": float(((ratio - 1.0).abs() > clip).float().mean()),
    }
    return loss, metrics


class Trainer:
    """IPPO with parameter sharing over all agents of a TrafficEnv."""

    DEFAULT_ROLLOUT = ROLLOUT_STEPS

    def __init__(self, cfg: "RunConfig", env: "TrafficEnv"):
        torch.manual_seed(cfg.seed)
        kw = cfg.algo_kwargs
        self.gamma = float(cfg.gamma)
        self.rollout_steps = int(kw.get("rollout_steps", self.DEFAULT_ROLLOUT))
        self.epochs = int(kw.get("epochs", EPOCHS))
        self.minibatch = int(kw.get("minibatch", MINIBATCH))
        self.clip = float(kw.get("clip", CLIP))
        self.gae_lambda = float(kw.get("gae_lambda", GAE_LAMBDA))
        self.entropy_coef = float(kw.get("entropy_coef", ENTROPY_COEF))
        self.value_coef = float(kw.get("value_coef", VALUE_COEF))
        self.grad_clip = float(kw.get("grad_clip", GRAD_CLIP))
        # Traffic rewards are O(10..100); unscaled they blow up the value loss,
        # whose gradients wreck the shared trunk (measured: value_loss ~4.5e5,
        # policy collapse to a constant action). Scale to O(1).
        self.reward_scale = float(kw.get("reward_scale", 1.0))

        self.agents = self._agent_order(env)
        self.obs_dim = int(env.obs_dim)
        self.n_actions = int(env.max_phases)
        self.net = self._build_net(env)
        self.opt = torch.optim.Adam(self.net.parameters(), lr=cfg.lr)
        steps = self._steps_per_agent()
        self.buffers = {a: RolloutBuffer(steps, self.obs_dim, self.n_actions)
                        for a in self.agents}
        self.rng = np.random.default_rng(cfg.seed)          # minibatch shuffling
        self.sampler = torch.Generator().manual_seed(int(cfg.seed))  # action sampling
        self.env_steps = 0
        self._cache: tuple[np.ndarray, torch.Tensor, torch.Tensor, torch.Tensor] | None = None

    # ------------------------------------------------------------------ hooks
    # gat.Trainer overrides these; the PPO loop itself is shared.
    def _agent_order(self, env: "TrafficEnv") -> list[str]:
        return list(env.agents)

    def _build_net(self, env: "TrafficEnv") -> torch.nn.Module:
        return ActorCritic(self.obs_dim, self.n_actions)

    def _steps_per_agent(self) -> int:
        return max(1, self.rollout_steps // len(self.agents))

    def _forward(self, obs: torch.Tensor, mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        return self.net.dist_value(obs, mask)

    # ------------------------------------------------------------------ policy
    def _stack_obs(self, obs: dict[str, np.ndarray]) -> np.ndarray:
        return np.stack([np.asarray(obs[a], dtype=np.float32) for a in self.agents])

    def _stack_masks(self, infos: dict) -> torch.Tensor:
        """Per-agent action masks padded to the widest action space."""
        out = torch.zeros(len(self.agents), self.n_actions, dtype=torch.bool)
        for i, a in enumerate(self.agents):
            m = torch.as_tensor(np.asarray(infos[a]["action_mask"], dtype=bool))
            out[i, :m.shape[0]] = m
        return out

    def act(self, obs: dict[str, np.ndarray], infos: dict, explore: bool) -> dict[str, int]:
        obs_mat = self._stack_obs(obs)
        mask = self._stack_masks(infos)
        with torch.no_grad():
            logits, values = self._forward(torch.from_numpy(obs_mat), mask)
        if explore:
            probs = torch.softmax(logits, dim=-1)   # masked logits -> exactly 0 prob
            acts = torch.multinomial(probs, 1, generator=self.sampler).squeeze(-1)
        else:
            acts = torch.argmax(logits, dim=-1)
        self._cache = (obs_mat, mask, logits, values)
        return {a: int(acts[i]) for i, a in enumerate(self.agents)}

    # ------------------------------------------------------------------ learning
    def observe(self, obs, actions, rewards, next_obs, next_infos,
                truncated: bool) -> dict[str, float]:
        if self._cache is None:
            raise RuntimeError("observe() must follow act() on the same observation")
        obs_mat, mask, logits, values = self._cache
        if not np.array_equal(obs_mat, self._stack_obs(obs)):
            raise RuntimeError("observe() obs does not match the last act() call")
        acts = torch.tensor([int(actions[a]) for a in self.agents], dtype=torch.int64)
        logp = F.log_softmax(logits, dim=-1).gather(-1, acts.unsqueeze(-1)).squeeze(-1)
        mask_np = mask.numpy()
        for i, a in enumerate(self.agents):
            self.buffers[a].add(obs_mat[i], mask_np[i], int(acts[i]), float(logp[i]),
                                float(values[i]),
                                float(rewards[a]) * self.reward_scale, bool(truncated))
        self.env_steps += 1
        self._cache = None
        if not self.buffers[self.agents[0]].full:
            return {}
        next_mask = self._stack_masks(next_infos)
        with torch.no_grad():
            _, last_values = self._forward(
                torch.from_numpy(self._stack_obs(next_obs)), next_mask)
        for i, a in enumerate(self.agents):
            self.buffers[a].compute_gae(float(last_values[i]), self.gamma, self.gae_lambda)
        metrics = self._update()
        for buf in self.buffers.values():
            buf.reset()
        return metrics

    def _step_minibatch(self, new_logp, old_logp, advantages, values, returns,
                        entropy) -> dict[str, float]:
        """Normalize advantages, take one clipped-PPO gradient step."""
        if advantages.numel() > 1:
            advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)
        loss, metrics = ppo_loss(new_logp, old_logp, advantages, values, returns,
                                 entropy, clip=self.clip, value_coef=self.value_coef,
                                 entropy_coef=self.entropy_coef)
        self.opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.net.parameters(), self.grad_clip)
        self.opt.step()
        metrics["loss"] = float(loss.detach())
        return metrics

    def _update(self) -> dict[str, float]:
        """Epochs of shared minibatches; each concatenates rows from every agent."""
        per_agent = max(1, self.minibatch // len(self.agents))
        iters = [self.buffers[a].minibatches(per_agent, self.epochs, self.rng)
                 for a in self.agents]
        totals: dict[str, float] = {}
        count = 0
        for parts in zip(*iters):
            batch = {k: torch.cat([p[k] for p in parts]) for k in parts[0]}
            logits, values = self._forward(batch["obs"], batch["mask"])
            logp_all = F.log_softmax(logits, dim=-1)
            new_logp = logp_all.gather(-1, batch["action"].unsqueeze(-1)).squeeze(-1)
            entropy = torch.distributions.Categorical(logits=logits).entropy()
            metrics = self._step_minibatch(new_logp, batch["logprob"],
                                           batch["advantage"], values,
                                           batch["return"], entropy)
            for k, v in metrics.items():
                totals[k] = totals.get(k, 0.0) + v
            count += 1
        return {k: v / count for k, v in totals.items()}

    # ------------------------------------------------------------------ state
    def state_dict(self) -> dict:
        return {
            "env_steps": self.env_steps,
            "model": self.net.state_dict(),
            "optim": self.opt.state_dict(),
            "np_rng": self.rng.bit_generator.state,
            "sampler": self.sampler.get_state(),
        }

    def load_state_dict(self, sd: dict) -> None:
        self.env_steps = int(sd["env_steps"])
        self.net.load_state_dict(sd["model"])
        self.opt.load_state_dict(sd["optim"])
        self.rng.bit_generator.state = sd["np_rng"]
        self.sampler.set_state(sd["sampler"])
