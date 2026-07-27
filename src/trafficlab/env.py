"""PettingZoo-style parallel multi-agent environment: one agent per intersection.

No pettingzoo/gymnasium dependency — the tiny Space classes below cover what the
in-repo RL code needs. Agent ids are stringified intersection ids.

Observation (float32): [queue×4, density×4, phase one-hot×P, time-since-change×1]
  queues normalized by 30 veh, densities by 200 veh/km, time by 60 s (capped 1).
  Approach slots beyond an intersection's actual approach count are zero.
Action: Discrete(P) — target phase index. Illegal requests (during transitions /
  before min-green) are safely ignored by the signal unit; infos carry
  "action_mask" so algorithms can mask instead of learning the hard way.
Reward variants: "pressure" (default, negative intersection pressure),
  "queue", "wait", "throughput".
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .network import Network
from .simulator import Simulator

QUEUE_NORM = 30.0
DENSITY_NORM = 200.0
TIME_NORM = 60.0
MAX_APPROACHES = 4
REWARDS = ("pressure", "queue", "wait", "throughput")


class Discrete:
    def __init__(self, n: int):
        self.n = int(n)

    def sample(self, rng: np.random.Generator) -> int:
        return int(rng.integers(self.n))

    def __repr__(self):
        return f"Discrete({self.n})"


class Box:
    def __init__(self, low: float, high: float, shape: tuple[int, ...]):
        self.low, self.high, self.shape = low, high, shape

    def sample(self, rng: np.random.Generator) -> np.ndarray:
        return rng.uniform(self.low, self.high, self.shape).astype(np.float32)

    def __repr__(self):
        return f"Box({self.low}, {self.high}, {self.shape})"


class TrafficEnv:
    def __init__(self, network_cfg: dict, demand_cfg: dict, *,
                 reward: str = "pressure", decision_interval: float = 5.0,
                 episode_seconds: float = 3600.0, dt: float = 0.5,
                 network_name: str = ""):
        if reward not in REWARDS:
            raise ValueError(f"reward must be one of {REWARDS}")
        self.network_cfg = network_cfg
        self.demand_cfg = demand_cfg
        self.reward_kind = reward
        self.dt = dt
        self.decision_ticks = max(1, int(round(decision_interval / dt)))
        self.episode_ticks = int(round(episode_seconds / dt))
        self.network_name = network_name
        net = Network.from_config(network_cfg)
        self.ix_ids = sorted(net.intersections)
        self.agents = [str(i) for i in self.ix_ids]
        self.n_phases = {str(i): len(net.intersections[i].phases) for i in self.ix_ids}
        self.max_phases = max(self.n_phases.values())
        self._approach_idx: dict[str, list[int]] = {str(i): [] for i in self.ix_ids}
        for ai, ap in enumerate(net.approaches()):
            self._approach_idx[str(ap["intersection"])].append(ai)
        self.obs_dim = 2 * MAX_APPROACHES + self.max_phases + 1
        # Static neighbor graph (for GAT): intersections sharing a link.
        self.neighbors: dict[str, list[str]] = {str(i): [] for i in self.ix_ids}
        node2ix = {net.intersections[i].node: i for i in self.ix_ids}
        for link in net.links.values():
            a, b = node2ix.get(link.from_node), node2ix.get(link.to_node)
            if a is not None and b is not None and a != b:
                if str(b) not in self.neighbors[str(a)]:
                    self.neighbors[str(a)].append(str(b))
                if str(a) not in self.neighbors[str(b)]:
                    self.neighbors[str(b)].append(str(a))
        self.sim: Simulator | None = None
        self._record_path: str | Path | None = None
        self._policy_label = "rl"
        self._prev_wait: np.ndarray | None = None
        self._prev_cross: dict[int, int] | None = None
        self._elapsed = 0

    # ------------------------------------------------------------------ spaces
    def observation_space(self, agent: str) -> Box:
        return Box(0.0, np.inf, (self.obs_dim,))

    def action_space(self, agent: str) -> Discrete:
        return Discrete(self.n_phases[agent])

    # ------------------------------------------------------------------ recording
    def record_next_episode(self, path: str | Path, policy_label: str = "rl") -> None:
        self._record_path = path
        self._policy_label = policy_label

    # ------------------------------------------------------------------ core API
    def reset(self, seed: int = 0) -> tuple[dict, dict]:
        if self.sim is not None:
            self.sim.close()
        net = Network.from_config(self.network_cfg)
        self.sim = Simulator(net, self.demand_cfg, seed=seed, dt=self.dt,
                             network_name=self.network_name)
        if self._record_path is not None:
            self.sim.attach_writer(self._record_path, policy=self._policy_label)
            self._record_path = None
        self._elapsed = 0
        self._prev_wait = self.sim.wait_by_approach.copy()
        self._prev_cross = dict(self.sim.crossings)
        return self._observe(), self._infos()

    def step(self, actions: dict[str, int]) -> tuple[dict, dict, dict, dict, dict]:
        assert self.sim is not None, "call reset() first"
        self.sim.request_phases({int(a): int(p) for a, p in actions.items()})
        if self.reward_kind == "pressure":
            self.sim.set_frame_rewards(None)        # default_rewards already = -pressure
        for _ in range(self.decision_ticks):
            self.sim.step()
        self._elapsed += self.decision_ticks
        rewards = self._rewards()
        truncated = self._elapsed >= self.episode_ticks
        truncations = {a: truncated for a in self.agents}
        truncations["__all__"] = truncated
        terminations = {a: False for a in self.agents}
        terminations["__all__"] = False
        return self._observe(), rewards, terminations, truncations, self._infos()

    def close(self) -> None:
        if self.sim is not None:
            self.sim.close()
            self.sim = None

    # ------------------------------------------------------------------ internals
    def _observe(self) -> dict[str, np.ndarray]:
        queues = self.sim.queues_by_approach()
        dens = self.sim.density_by_approach()
        obs = {}
        for a in self.agents:
            vec = np.zeros(self.obs_dim, dtype=np.float32)
            idxs = self._approach_idx[a][:MAX_APPROACHES]
            for slot, ai in enumerate(idxs):
                vec[slot] = queues[ai] / QUEUE_NORM
                vec[MAX_APPROACHES + slot] = dens[ai] / DENSITY_NORM
            unit = self.sim.units[int(a)]
            vec[2 * MAX_APPROACHES + unit.phase] = 1.0
            vec[-1] = min(unit.traj_time_in_phase / TIME_NORM, 1.0)
            obs[a] = vec
        return obs

    def _infos(self) -> dict[str, dict]:
        infos = {}
        for a in self.agents:
            unit = self.sim.units[int(a)]
            mask = np.asarray(unit.action_mask(self.n_phases[a]), dtype=bool)
            infos[a] = {"action_mask": mask}
        return infos

    def _rewards(self) -> dict[str, float]:
        kind = self.reward_kind
        rewards = {}
        if kind == "wait":
            wait = self.sim.wait_by_approach
        if kind == "queue":
            q = self.sim.queues_by_approach()
        for a in self.agents:
            ix = int(a)
            if kind == "pressure":
                r = -self.sim.intersection_pressure(ix)
            elif kind == "queue":
                r = -float(sum(q[ai] for ai in self._approach_idx[a]))
            elif kind == "wait":
                idxs = self._approach_idx[a]
                r = -float(sum(wait[ai] - self._prev_wait[ai] for ai in idxs))
            else:  # throughput
                r = float(self.sim.crossings[ix] - self._prev_cross[ix])
            rewards[a] = r
        if kind == "wait":
            self._prev_wait = self.sim.wait_by_approach.copy()
        if kind == "throughput":
            self._prev_cross = dict(self.sim.crossings)
        if kind != "pressure":
            # Make recorded frames carry the reward actually being optimized.
            # Note: interval-summarizing rewards are only known at the END of a
            # decision window, so recorded per-frame values lag by one interval
            # (the default -pressure kind has no lag; it is recomputed per tick).
            self.sim.set_frame_rewards(
                np.array([rewards[str(i)] for i in self.ix_ids], dtype=np.float32))
        return rewards


def make_env(network: str, demand: str, root: str | Path | None = None, **kwargs) -> TrafficEnv:
    root = Path(root) if root else Path(__file__).resolve().parents[2]
    net_cfg = json.loads((root / "configs/networks" / f"{network}.json").read_text())
    dem_cfg = json.loads((root / "configs/demand" / f"{demand}.json").read_text())
    return TrafficEnv(net_cfg, dem_cfg, network_name=network, **kwargs)
