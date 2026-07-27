"""Experience buffers for the RL stack (see docs/RL_DESIGN.md).

ReplayBuffer    Fixed-capacity uniform ring buffer for DQN.
RolloutBuffer   Fixed-size on-policy rollout with GAE(lambda) for PPO.

Storage is preallocated numpy; sampling converts fresh copies to torch
tensors. All randomness comes from the caller's `numpy.random.Generator`,
so behavior is reproducible from a single seed.
"""
from __future__ import annotations

from typing import Iterator

import numpy as np
import torch


class ReplayBuffer:
    """Ring buffer of (obs, action, reward, next_obs, next_mask, truncated).

    Oldest transitions are overwritten once `capacity` is reached. The mask
    array is allocated on the first add(), when the action count is first
    known. `truncated` is stored for completeness; the continuing-task DQN
    bootstraps through truncation regardless.
    """

    def __init__(self, capacity: int, obs_dim: int):
        self.capacity = int(capacity)
        self.obs_dim = int(obs_dim)
        self.obs = np.zeros((self.capacity, self.obs_dim), dtype=np.float32)
        self.actions = np.zeros(self.capacity, dtype=np.int64)
        self.rewards = np.zeros(self.capacity, dtype=np.float32)
        self.next_obs = np.zeros((self.capacity, self.obs_dim), dtype=np.float32)
        self.next_masks: np.ndarray | None = None
        self.truncated = np.zeros(self.capacity, dtype=bool)
        self._pos = 0
        self._size = 0

    def __len__(self) -> int:
        return self._size

    def add(self, obs, action: int, reward: float, next_obs, next_mask,
            truncated: bool) -> None:
        next_mask = np.asarray(next_mask, dtype=bool)
        if self.next_masks is None:
            self.next_masks = np.zeros((self.capacity, next_mask.shape[-1]), dtype=bool)
        i = self._pos
        self.obs[i] = obs
        self.actions[i] = action
        self.rewards[i] = reward
        self.next_obs[i] = next_obs
        self.next_masks[i] = next_mask
        self.truncated[i] = truncated
        self._pos = (i + 1) % self.capacity
        self._size = min(self._size + 1, self.capacity)

    def sample(self, batch: int, rng: np.random.Generator) -> dict[str, torch.Tensor]:
        """Uniform sample (with replacement) of `batch` transitions as torch tensors."""
        if self._size == 0:
            raise ValueError("cannot sample from an empty buffer")
        idx = rng.integers(0, self._size, size=batch)
        return {
            "obs": torch.from_numpy(self.obs[idx]),
            "action": torch.from_numpy(self.actions[idx]),
            "reward": torch.from_numpy(self.rewards[idx]),
            "next_obs": torch.from_numpy(self.next_obs[idx]),
            "next_mask": torch.from_numpy(self.next_masks[idx]),
            "truncated": torch.from_numpy(self.truncated[idx]),
        }


class RolloutBuffer:
    """On-policy rollout of (obs, mask, action, logprob, value, reward, truncated).

    compute_gae() fills `advantages` and `returns`. minibatches() yields raw
    shuffled rows; advantage normalization is the consumer's job (per
    minibatch, per the PPO defaults in RL_DESIGN.md).
    """

    def __init__(self, size: int, obs_dim: int, n_actions: int):
        self.size = int(size)
        self.obs = np.zeros((self.size, int(obs_dim)), dtype=np.float32)
        self.masks = np.zeros((self.size, int(n_actions)), dtype=bool)
        self.actions = np.zeros(self.size, dtype=np.int64)
        self.logprobs = np.zeros(self.size, dtype=np.float32)
        self.values = np.zeros(self.size, dtype=np.float32)
        self.rewards = np.zeros(self.size, dtype=np.float32)
        self.truncated = np.zeros(self.size, dtype=bool)
        self.bootstraps = np.full(self.size, np.nan, dtype=np.float32)
        self.advantages = np.zeros(self.size, dtype=np.float32)
        self.returns = np.zeros(self.size, dtype=np.float32)
        self._n = 0

    def __len__(self) -> int:
        return self._n

    @property
    def full(self) -> bool:
        return self._n == self.size

    def add(self, obs, mask, action: int, logprob: float, value: float,
            reward: float, truncated: bool,
            bootstrap_value: float | None = None) -> None:
        if self._n >= self.size:
            raise ValueError("rollout buffer is full")
        i = self._n
        self.obs[i] = obs
        self.masks[i] = np.asarray(mask, dtype=bool)
        self.actions[i] = action
        self.logprobs[i] = logprob
        self.values[i] = value
        self.rewards[i] = reward
        self.truncated[i] = truncated
        self.bootstraps[i] = np.nan if bootstrap_value is None else bootstrap_value
        self._n = i + 1

    def reset(self) -> None:
        self._n = 0
        self.bootstraps[:] = np.nan

    def compute_gae(self, last_values, gamma: float, lam: float) -> None:
        """Fill advantages and returns with GAE(lambda) over the stored rows.

        A truncated row ends an episode: its one-step delta bootstraps from the
        row's stored `bootstrap_value` — V(the episode's actual next obs) — when
        the producer recorded one (falling back to the stored next value), and
        the lambda-trace is cut there so advantages never mix episodes.
        `last_values` is the value estimate for the state after the final row.
        """
        next_value = float(last_values)
        gae = 0.0
        for t in range(self._n - 1, -1, -1):
            nv = next_value
            if self.truncated[t] and np.isfinite(self.bootstraps[t]):
                nv = float(self.bootstraps[t])
            delta = float(self.rewards[t]) + gamma * nv - float(self.values[t])
            if self.truncated[t]:
                gae = delta
            else:
                gae = delta + gamma * lam * gae
            self.advantages[t] = gae
            next_value = float(self.values[t])
        self.returns[:self._n] = self.advantages[:self._n] + self.values[:self._n]

    def minibatches(self, minibatch_size: int, epochs: int,
                    rng: np.random.Generator) -> Iterator[dict[str, torch.Tensor]]:
        """Yield shuffled minibatches for `epochs` full passes over stored rows.

        Rows are yielded raw (advantages unnormalized). A final smaller
        minibatch is yielded when the row count is not divisible.
        """
        n = self._n
        for _ in range(epochs):
            order = rng.permutation(n)
            for start in range(0, n, minibatch_size):
                idx = order[start:start + minibatch_size]
                yield {
                    "obs": torch.from_numpy(self.obs[idx]),
                    "mask": torch.from_numpy(self.masks[idx]),
                    "action": torch.from_numpy(self.actions[idx]),
                    "logprob": torch.from_numpy(self.logprobs[idx]),
                    "value": torch.from_numpy(self.values[idx]),
                    "advantage": torch.from_numpy(self.advantages[idx]),
                    "return": torch.from_numpy(self.returns[idx]),
                }
