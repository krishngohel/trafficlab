"""GAT-PPO: PPO with a graph-attention actor-critic over the whole network.

The PPO loop is identical to ppo.py (this Trainer subclasses ppo.Trainer),
but the policy is a GATActorCritic evaluated over every intersection at once:
one forward per env step covers the full node graph, and updates batch over
time (minibatch elements are whole graph-steps). Node order is
``sorted(env.agents)``; adjacency comes from ``env.neighbors`` plus
self-loops. The rollout stores the per-node obs matrix for every graph-step
as one aligned row per node buffer (row t across node buffers is the
[N, obs_dim] matrix of graph-step t). Default rollout 1024 graph-steps;
all other defaults as in ppo.py.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import torch
import torch.nn.functional as F

from . import ppo
from .nets import GATActorCritic

if TYPE_CHECKING:
    from ..env import TrafficEnv

ROLLOUT_STEPS = 1024        # graph-steps


class Trainer(ppo.Trainer):
    """GAT-PPO over the intersection neighbor graph of a TrafficEnv."""

    DEFAULT_ROLLOUT = ROLLOUT_STEPS

    # ------------------------------------------------------------------ hooks
    def _agent_order(self, env: "TrafficEnv") -> list[str]:
        return sorted(env.agents)

    def _build_net(self, env: "TrafficEnv") -> torch.nn.Module:
        n = len(self.agents)
        idx = {a: i for i, a in enumerate(self.agents)}
        adj = torch.eye(n, dtype=torch.bool)
        for a in self.agents:
            for b in env.neighbors[a]:
                adj[idx[a], idx[b]] = True
                adj[idx[b], idx[a]] = True
        self.adj = adj
        return GATActorCritic(self.obs_dim, self.n_actions)

    def _steps_per_agent(self) -> int:
        return self.rollout_steps    # every node buffer holds all graph-steps

    def _forward(self, obs: torch.Tensor, mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        return self.net(obs, self.adj, mask)

    # ------------------------------------------------------------------ learning
    def _update(self) -> dict[str, float]:
        """Epochs of minibatches over shuffled graph-steps (batch dim = time)."""
        t_total = len(self.buffers[self.agents[0]])

        def stacked(attr: str) -> np.ndarray:    # [T, N, ...] node-aligned
            return np.stack([getattr(self.buffers[a], attr)[:t_total]
                             for a in self.agents], axis=1)

        obs, masks = stacked("obs"), stacked("masks")
        actions, old_logp = stacked("actions"), stacked("logprobs")
        advantages, returns = stacked("advantages"), stacked("returns")
        totals: dict[str, float] = {}
        count = 0
        for _ in range(self.epochs):
            order = self.rng.permutation(t_total)
            for start in range(0, t_total, self.minibatch):
                idx = order[start:start + self.minibatch]
                logits, values = self._forward(torch.from_numpy(obs[idx]),
                                               torch.from_numpy(masks[idx]))
                logp_all = F.log_softmax(logits, dim=-1)
                new_logp = logp_all.gather(
                    -1, torch.from_numpy(actions[idx]).unsqueeze(-1)).squeeze(-1)
                entropy = torch.distributions.Categorical(logits=logits).entropy()
                metrics = self._step_minibatch(
                    new_logp.flatten(), torch.from_numpy(old_logp[idx]).flatten(),
                    torch.from_numpy(advantages[idx]).flatten(), values.flatten(),
                    torch.from_numpy(returns[idx]).flatten(), entropy.flatten())
                for k, v in metrics.items():
                    totals[k] = totals.get(k, 0.0) + v
                count += 1
        return {k: v / count for k, v in totals.items()}
