"""Private stub Trainer for harness tests. Not a real algorithm.

Lives in the package (rather than tests/) only so multiprocessing sweep
subprocesses can import it via the standard ``trafficlab.rl.<algo>`` dispatch
(``cfg.algo == "_stub_test_algo"``). Acts randomly-but-seeded when exploring,
picks the lowest legal phase when greedy, and emits a fake loss every
``LOSS_EVERY`` observe() calls.
"""
from __future__ import annotations

import numpy as np
import torch

LOSS_EVERY = 10


class Trainer:
    def __init__(self, cfg, env):
        self.env = env
        self.n_actions = {a: env.action_space(a).n for a in env.agents}
        self.rng = np.random.default_rng(cfg.seed + 987)
        self.observe_count = 0
        self.weight = torch.zeros(2)

    def act(self, obs, infos, explore: bool) -> dict[str, int]:
        actions: dict[str, int] = {}
        for a in self.env.agents:
            mask = np.asarray(infos[a]["action_mask"], dtype=bool)
            legal = np.flatnonzero(mask)
            if legal.size == 0:
                legal = np.arange(self.n_actions[a])
            if explore:
                actions[a] = int(legal[self.rng.integers(len(legal))])
            else:
                actions[a] = int(legal[0])      # deterministic greedy
        return actions

    def observe(self, obs, actions, rewards, next_obs, next_infos,
                truncated: bool) -> dict[str, float]:
        self.observe_count += 1
        self.weight += 0.001                    # pretend to learn
        if self.observe_count % LOSS_EVERY == 0:
            return {"loss": 1.0 / self.observe_count}
        return {}

    def state_dict(self) -> dict:
        return {"model": {"weight": self.weight.clone()},
                "optimizer": {},
                "numpy_rng": self.rng.bit_generator.state,
                "observe_count": self.observe_count}

    def load_state_dict(self, sd: dict) -> None:
        self.weight = sd["model"]["weight"].clone()
        self.rng.bit_generator.state = sd["numpy_rng"]
        self.observe_count = int(sd["observe_count"])
