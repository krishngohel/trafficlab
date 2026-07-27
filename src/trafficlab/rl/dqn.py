"""IDQN: independent double-DQN per agent, with optional weight sharing.

Implements the Trainer protocol from docs/RL_DESIGN.md. Each agent owns a
QNet, a target QNet, an Adam optimizer, and a ReplayBuffer;
``algo_kwargs["share_weights"] = True`` switches every agent onto a single
shared QNet/target/optimizer (decisions and replay stay per-agent, with masks
padded to the widest action space).

Defaults (overridable through ``cfg.algo_kwargs``): buffer 50k per agent,
batch 64, target sync every 500 updates, one update per env step per agent
once that agent's buffer holds ``warmup`` (500) transitions, epsilon
1.0 -> 0.05 linear over 40% of ``cfg.total_steps``, Huber loss, gradient
clip 10. Bootstrap continues through episode truncation (continuing task).
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import torch
import torch.nn.functional as F

from .buffers import ReplayBuffer
from .nets import QNet

if TYPE_CHECKING:
    from ..env import TrafficEnv
    from .harness import RunConfig

BUFFER_SIZE = 50_000
BATCH_SIZE = 64
TARGET_SYNC = 500
WARMUP = 500
GRAD_CLIP = 10.0
EPS_START = 1.0
EPS_FINAL = 0.05
EPS_DECAY_FRAC = 0.4
MASK_FILL = -1e9

_SHARED = "__shared__"


def linear_epsilon(step: int, total_steps: int, *, start: float = EPS_START,
                   final: float = EPS_FINAL, frac: float = EPS_DECAY_FRAC) -> float:
    """Linear decay start -> final over ``frac * total_steps`` env steps, then flat."""
    decay_steps = max(1, int(round(frac * total_steps)))
    t = min(max(int(step), 0), decay_steps) / decay_steps
    return start + (final - start) * t


class Trainer:
    """Independent double-DQN over all agents of a TrafficEnv."""

    def __init__(self, cfg: "RunConfig", env: "TrafficEnv"):
        torch.manual_seed(cfg.seed)
        kw = cfg.algo_kwargs
        self.gamma = float(cfg.gamma)
        self.total_steps = int(cfg.total_steps)
        self.agents = list(env.agents)
        self.obs_dim = int(env.obs_dim)
        self.n_phases = {a: int(env.n_phases[a]) for a in self.agents}

        self.share_weights = bool(kw.get("share_weights", False))
        self.buffer_size = int(kw.get("buffer_size", BUFFER_SIZE))
        self.batch_size = int(kw.get("batch_size", BATCH_SIZE))
        self.target_sync = int(kw.get("target_sync", TARGET_SYNC))
        self.warmup = int(kw.get("warmup", WARMUP))
        self.grad_clip = float(kw.get("grad_clip", GRAD_CLIP))
        self.eps_start = float(kw.get("eps_start", EPS_START))
        self.eps_final = float(kw.get("eps_final", EPS_FINAL))
        self.eps_decay_frac = float(kw.get("eps_decay_frac", EPS_DECAY_FRAC))

        if self.share_weights:
            width = max(self.n_phases.values())
            self.n_actions = {a: width for a in self.agents}
            self._key_of = {a: _SHARED for a in self.agents}
            self._keys = [_SHARED]
            widths = {_SHARED: width}
        else:
            self.n_actions = dict(self.n_phases)
            self._key_of = {a: a for a in self.agents}
            self._keys = list(self.agents)
            widths = dict(self.n_phases)

        self.nets: dict[str, QNet] = {}
        self.targets: dict[str, QNet] = {}
        self.optims: dict[str, torch.optim.Adam] = {}
        self.update_counts: dict[str, int] = {}
        for key in self._keys:
            net = QNet(self.obs_dim, widths[key])
            target = QNet(self.obs_dim, widths[key])
            target.load_state_dict(net.state_dict())
            for p in target.parameters():
                p.requires_grad_(False)
            self.nets[key] = net
            self.targets[key] = target
            self.optims[key] = torch.optim.Adam(net.parameters(), lr=cfg.lr)
            self.update_counts[key] = 0

        self.buffers = {a: ReplayBuffer(self.buffer_size, self.obs_dim)
                        for a in self.agents}
        self.rng = np.random.default_rng(cfg.seed)
        self.env_steps = 0          # env decision steps seen (drives epsilon)

    # ------------------------------------------------------------------ policy
    def epsilon(self) -> float:
        return linear_epsilon(self.env_steps, self.total_steps, start=self.eps_start,
                              final=self.eps_final, frac=self.eps_decay_frac)

    def act(self, obs: dict[str, np.ndarray], infos: dict, explore: bool) -> dict[str, int]:
        eps = self.epsilon()
        actions: dict[str, int] = {}
        for a in self.agents:
            mask = self._padded_mask(a, infos[a]["action_mask"])
            if explore and self.rng.random() < eps:
                legal = np.flatnonzero(mask)
                actions[a] = int(legal[self.rng.integers(len(legal))])
            else:
                q = self._q_values(a, obs[a])
                q = q.masked_fill(~torch.as_tensor(mask), MASK_FILL)
                actions[a] = int(torch.argmax(q).item())
        return actions

    def _q_values(self, agent: str, ob: np.ndarray) -> torch.Tensor:
        net = self.nets[self._key_of[agent]]
        with torch.no_grad():
            return net(torch.as_tensor(ob, dtype=torch.float32).unsqueeze(0)).squeeze(0)

    def _padded_mask(self, agent: str, mask) -> np.ndarray:
        out = np.zeros(self.n_actions[agent], dtype=bool)
        m = np.asarray(mask, dtype=bool)
        out[:m.shape[0]] = m
        return out

    # ------------------------------------------------------------------ learning
    def observe(self, obs, actions, rewards, next_obs, next_infos,
                truncated: bool) -> dict[str, float]:
        eps = self.epsilon()
        for a in self.agents:
            next_mask = self._padded_mask(a, next_infos[a]["action_mask"])
            self.buffers[a].add(obs[a], int(actions[a]), float(rewards[a]),
                                next_obs[a], next_mask, bool(truncated))
        losses = [self._update(a) for a in self.agents
                  if len(self.buffers[a]) >= self.warmup]
        self.env_steps += 1
        if not losses:
            return {}
        return {"loss": float(np.mean(losses)), "epsilon": eps}

    def _td_targets(self, agent: str, rewards: torch.Tensor, next_obs: torch.Tensor,
                    next_mask: torch.Tensor) -> torch.Tensor:
        """Double-DQN target: r + gamma * Q_target(s', argmax_legal Q_online(s', .))."""
        key = self._key_of[agent]
        with torch.no_grad():
            next_online = self.nets[key](next_obs).masked_fill(~next_mask, MASK_FILL)
            a_star = next_online.argmax(dim=1, keepdim=True)
            next_q = self.targets[key](next_obs).gather(1, a_star).squeeze(1)
            return rewards + self.gamma * next_q

    def _update(self, agent: str) -> float:
        key = self._key_of[agent]
        net, opt = self.nets[key], self.optims[key]
        batch = self.buffers[agent].sample(self.batch_size, self.rng)

        target = self._td_targets(agent, batch["reward"], batch["next_obs"],
                                  batch["next_mask"])
        q = net(batch["obs"]).gather(1, batch["action"].unsqueeze(1)).squeeze(1)
        loss = F.smooth_l1_loss(q, target)
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), self.grad_clip)
        opt.step()

        self.update_counts[key] += 1
        if self.update_counts[key] % self.target_sync == 0:
            self.targets[key].load_state_dict(net.state_dict())
        return float(loss.item())

    # ------------------------------------------------------------------ state
    def state_dict(self) -> dict:
        return {
            "env_steps": self.env_steps,
            "update_counts": dict(self.update_counts),
            "nets": {k: self.nets[k].state_dict() for k in self._keys},
            "targets": {k: self.targets[k].state_dict() for k in self._keys},
            "optims": {k: self.optims[k].state_dict() for k in self._keys},
            "np_rng": self.rng.bit_generator.state,
        }

    def load_state_dict(self, sd: dict) -> None:
        self.env_steps = int(sd["env_steps"])
        self.update_counts = {k: int(v) for k, v in sd["update_counts"].items()}
        for key in self._keys:
            self.nets[key].load_state_dict(sd["nets"][key])
            self.targets[key].load_state_dict(sd["targets"][key])
            self.optims[key].load_state_dict(sd["optims"][key])
        self.rng.bit_generator.state = sd["np_rng"]
