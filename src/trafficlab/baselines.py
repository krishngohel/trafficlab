"""Classical signal-control baselines: fixed-time (Webster), fully actuated,
and max-pressure. Each controller owns one intersection; call .step() every
tick BEFORE sim.step() (same convention as FixedCycleController).
"""
from __future__ import annotations

import math

import numpy as np

from .signals import FixedCycleController, SignalUnit
from .simulator import Simulator

SATURATION_FLOW = 1800.0    # veh/h per lane
MIN_CYCLE, MAX_CYCLE = 40.0, 120.0


def _mean_profile_multiplier(demand_cfg: dict) -> float:
    profile = demand_cfg.get("profile")
    if not profile:
        return 1.0
    return float(np.mean([m for _, m in profile]))


def webster_greens(sim: Simulator, ix_id: int) -> list[float]:
    """Webster's method with flows estimated from the demand config.

    Approximation (documented in docs/EXPERIMENT_LOG.md): every approach link is
    assumed to carry base_rate x mean profile multiplier veh/h (interior links
    inherit the entry rate), split across movements by the turning probabilities.
    """
    net = sim.net
    ix = net.intersections[ix_id]
    demand_cfg = sim.demand.cfg if hasattr(sim.demand, "cfg") else {}
    base = float(demand_cfg.get("base_rate", 500.0)) * _mean_profile_multiplier(demand_cfg)
    turning = demand_cfg.get("turning", {"left": 0.2, "through": 0.65, "right": 0.15})

    # Connections serving each (link, movement) across the whole intersection —
    # a movement's flow splits evenly over the lanes that serve it.
    serving: dict[tuple[int, str], int] = {}
    for conn in net.connections.values():
        if conn.intersection != ix_id:
            continue
        key = (net.lanes[conn.from_lane].link, conn.movement)
        serving[key] = serving.get(key, 0) + 1

    ys: list[float] = []
    for phase in ix.phases:
        # Critical flow ratio must aggregate per PHYSICAL lane: in 2-lane
        # configs through and right depart from the same lane, so that lane
        # carries the sum of both movements' flows.
        lane_flow: dict[int, float] = {}
        for cid in phase.connections:
            conn = net.connections[cid]
            key = (net.lanes[conn.from_lane].link, conn.movement)
            flow = base * float(turning.get(conn.movement, 0.2)) / serving[key]
            lane_flow[conn.from_lane] = lane_flow.get(conn.from_lane, 0.0) + flow
        ys.append(max(lane_flow.values()) / SATURATION_FLOW if lane_flow else 0.0)

    lost = len(ix.phases) * (ix.yellow + ix.all_red)
    y_total = min(sum(ys), 0.85)
    cycle = (1.5 * lost + 5.0) / max(1.0 - y_total, 0.15)
    cycle = float(np.clip(cycle, MIN_CYCLE, MAX_CYCLE))
    effective = cycle - lost
    y_sum = max(sum(ys), 1e-6)
    return [max(ix.min_green, effective * y / y_sum) for y in ys]


class WebsterController(FixedCycleController):
    def __init__(self, sim: Simulator, ix_id: int):
        super().__init__(sim.units[ix_id], webster_greens(sim, ix_id))


class ActuatedController:
    """Gap-out actuation: extend the green while a presence detector 30 m
    upstream of any served stop line keeps firing; gap-out after `gap_time`
    with no presence (post min-green) or hit `max_green`; then advance to the
    next phase with waiting demand (skipping empty phases)."""

    def __init__(self, sim: Simulator, ix_id: int, gap_time: float = 3.0,
                 max_green: float = 45.0, detector: float = 30.0):
        self.sim = sim
        self.ix = sim.net.intersections[ix_id]
        self.unit: SignalUnit = sim.units[ix_id]
        self.gap_time = gap_time
        self.max_green = max_green
        self.detector = detector
        self._quiet = 0.0

    def _presence(self, phase_idx: int, dist: float) -> bool:
        for cid in self.ix.phases[phase_idx].connections:
            lane = self.sim.net.connections[cid].from_lane
            if self.sim.vehicles_near_stop(lane, dist) > 0:
                return True
        return False

    def step(self) -> None:
        unit = self.unit
        if not unit.can_switch():
            self._quiet = 0.0
            return
        if self._presence(unit.phase, self.detector):
            self._quiet = 0.0
        else:
            self._quiet += self.sim.dt
        green_len = unit.traj_time_in_phase
        if green_len < self.max_green and self._quiet < self.gap_time:
            return
        n = len(self.ix.phases)
        for k in range(1, n + 1):
            cand = (unit.phase + k) % n
            if cand != unit.phase and self._presence(cand, 100.0):
                unit.request_phase(cand)
                self._quiet = 0.0
                return
        # Nobody waiting anywhere: rest on the current green.


class MaxPressureController:
    """Every `period` seconds, switch to the phase with maximal pressure.

    Default period 15 s: with 6 s min-green + 5 s clearance, faster switching
    burns capacity in yellow/all-red (measured on grid2x2/rush: 205-214 s/veh
    at period 5 vs 190-196 at period 15).

    `max_green` is an anti-starvation cap: pressure can stay pinned on a phase
    whose queue cannot discharge (e.g. head-of-line blocking), so after
    max_green seconds of green the controller must serve the best OTHER phase
    (measured on arterial6: without the cap, max-pressure gridlocks at ~2600
    s/veh with 95% of time on one phase)."""

    def __init__(self, sim: Simulator, ix_id: int, period: float = 15.0,
                 max_green: float = 60.0):
        self.sim = sim
        self.ix_id = ix_id
        self.unit: SignalUnit = sim.units[ix_id]
        self.period_ticks = max(1, int(round(period / sim.dt)))
        self.max_green = max_green
        self._t = 0

    def step(self) -> None:
        if self._t % self.period_ticks == 0 and self.unit.can_switch():
            pressures = self.sim.phase_pressures(self.ix_id)
            if self.unit.traj_time_in_phase >= self.max_green and len(pressures) > 1:
                others = [(p, i) for i, p in enumerate(pressures) if i != self.unit.phase]
                self.unit.request_phase(max(others)[1])
            else:
                best = int(np.argmax(pressures))
                if pressures[best] > pressures[self.unit.phase]:
                    self.unit.request_phase(best)
        self._t += 1


def build(kind: str, sim: Simulator) -> list:
    """Factory used by scripts/simulate.py and the eval suite."""
    ids = sorted(sim.units)
    if kind == "fixed":
        return [FixedCycleController(
            sim.units[i],
            [8.0 if ph.name.endswith("L") else 20.0 for ph in sim.net.intersections[i].phases])
            for i in ids]
    if kind == "webster":
        return [WebsterController(sim, i) for i in ids]
    if kind == "actuated":
        return [ActuatedController(sim, i) for i in ids]
    if kind == "max_pressure":
        return [MaxPressureController(sim, i) for i in ids]
    raise ValueError(f"unknown controller '{kind}'")
