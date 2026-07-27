"""Signal controllers: per-intersection phase state machines.

See docs/SIM_DESIGN.md (signals.py section). A SignalUnit advances one
intersection through GREEN -> YELLOW -> ALL_RED -> GREEN in fixed dt ticks;
all timing is integer-tick based, so repeated stepping never drifts.
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from .network import Intersection

GREEN, YELLOW, ALL_RED = 0, 1, 2


class SignalUnit:
    """Phase state machine for one intersection.

    GREEN -> (request) -> YELLOW (yellow s) -> ALL_RED (all_red s) -> GREEN(new).
    Requests during a transition are ignored; a request before min_green has
    elapsed is queued and honored when it elapses. Re-requesting the current
    phase while GREEN cancels any queued pending switch (so a controller's
    latest request is always the one that fires — a stale queued request never
    fires after a later "stay" decision). All transitions happen inside step().
    """

    def __init__(self, ix: Intersection, dt: float, initial_phase: int = 0):
        if not 0 <= initial_phase < len(ix.phases):
            raise ValueError(f"initial_phase {initial_phase} out of range")
        self.ix = ix
        self.dt = float(dt)
        self.phase = initial_phase      # current phase (outgoing during transition)
        self.state = GREEN
        self._phase_conns = [frozenset(p.connections) for p in ix.phases]
        self._yellow_ticks = self._ticks(ix.yellow)
        self._all_red_ticks = self._ticks(ix.all_red)
        self._min_green_ticks = self._ticks(ix.min_green)
        self._state_ticks = 0           # ticks in the current (phase, state) segment
        self._traj_ticks = 0            # ticks since green start / transition start
        self._pending: int | None = None    # request queued while GREEN
        self._target: int | None = None     # incoming phase during a transition

    def _ticks(self, seconds: float) -> int:
        return max(0, math.ceil(seconds / self.dt - 1e-9))

    @property
    def time_in_phase(self) -> float:
        """Seconds since the current (phase, state) segment began."""
        return self._state_ticks * self.dt

    @property
    def traj_time_in_phase(self) -> float:
        """.traj value: seconds since this phase's green began; during
        YELLOW/ALL_RED, seconds since the transition (yellow) began."""
        return self._traj_ticks * self.dt

    def request_phase(self, p: int) -> None:
        if not 0 <= p < len(self._phase_conns):
            raise ValueError(f"phase {p} out of range")
        if self.state != GREEN:
            return
        if p == self.phase:
            self._pending = None    # re-request of current phase cancels a queued switch
            return
        self._pending = p

    def can_switch(self) -> bool:
        return self.state == GREEN and self._state_ticks >= self._min_green_ticks

    def step(self) -> None:
        self._state_ticks += 1
        self._traj_ticks += 1
        if self.state == GREEN:
            if self._pending is not None and self._state_ticks >= self._min_green_ticks:
                self._target = self._pending
                self._pending = None
                self._enter_yellow()
        elif self.state == YELLOW:
            if self._state_ticks >= self._yellow_ticks:
                self._enter_all_red()
        elif self._state_ticks >= self._all_red_ticks:      # ALL_RED
            self._enter_green()

    def _enter_yellow(self) -> None:
        self.state = YELLOW
        self._state_ticks = 0
        self._traj_ticks = 0
        if self._yellow_ticks == 0:
            self._enter_all_red()

    def _enter_all_red(self) -> None:
        self.state = ALL_RED
        self._state_ticks = 0           # traj clock keeps running through all-red
        if self._all_red_ticks == 0:
            self._enter_green()

    def _enter_green(self) -> None:
        assert self._target is not None
        self.phase = self._target
        self._target = None
        self.state = GREEN
        self._state_ticks = 0
        self._traj_ticks = 0

    def signal_for(self, conn_id: int) -> int:
        """GREEN/YELLOW for connections of the current (outgoing) phase,
        ALL_RED (treat as red) for everything else."""
        if conn_id in self._phase_conns[self.phase]:
            if self.state == GREEN:
                return GREEN
            if self.state == YELLOW:
                return YELLOW
        return ALL_RED

    def action_mask(self, n_actions: int) -> np.ndarray[bool]:
        if self.can_switch():
            return np.ones(n_actions, dtype=bool)
        mask = np.zeros(n_actions, dtype=bool)
        mask[self.phase] = True
        return mask


class FixedCycleController:
    """M2 testing controller: cycles phases in order, holding phase p green
    for greens[p] seconds (extended to min_green if shorter).

    Call step() once per tick, before unit.step(): the request is placed one
    tick early so the switch lands exactly when the green time elapses.
    """

    def __init__(self, unit: SignalUnit, greens: list[float]):
        if len(greens) != len(unit.ix.phases):
            raise ValueError(f"need {len(unit.ix.phases)} green durations, got {len(greens)}")
        self.unit = unit
        self.greens = [float(g) for g in greens]

    def step(self) -> None:
        u = self.unit
        if u.state == GREEN and u.time_in_phase + u.dt >= self.greens[u.phase] - 1e-9:
            u.request_phase((u.phase + 1) % len(self.greens))
