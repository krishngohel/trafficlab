"""Tests for signals.py: SignalUnit state machine and FixedCycleController."""
from itertools import groupby
from types import SimpleNamespace

import numpy as np
import pytest

from trafficlab.signals import ALL_RED, GREEN, YELLOW, FixedCycleController, SignalUnit

DT = 0.5
P0_CONNS = (0, 1, 2)
P1_CONNS = (10, 11, 12)


def make_ix(yellow=3.0, all_red=2.0, min_green=6.0):
    """Stub Intersection: only the duck-typed attrs SignalUnit needs."""
    phases = [
        SimpleNamespace(name="P0", connections=P0_CONNS),
        SimpleNamespace(name="P1", connections=P1_CONNS),
    ]
    return SimpleNamespace(phases=phases, yellow=yellow, all_red=all_red, min_green=min_green)


def run_fixed_cycle(greens, n_ticks):
    """Step controller-then-unit n_ticks times; return [(phase, state, traj_tip)]
    including the initial pre-step observation."""
    unit = SignalUnit(make_ix(), dt=DT)
    ctrl = FixedCycleController(unit, greens)
    history = [(unit.phase, unit.state, unit.traj_time_in_phase)]
    for _ in range(n_ticks):
        ctrl.step()
        unit.step()
        history.append((unit.phase, unit.state, unit.traj_time_in_phase))
    return history


def green_runs(history):
    """[(phase, ticks)] for each maximal run of GREEN observations."""
    return [(k[0], sum(1 for _ in g))
            for k, g in groupby(history, key=lambda h: (h[0], h[1])) if k[1] == GREEN]


def test_transition_timing_exact():
    unit = SignalUnit(make_ix(), dt=DT)
    assert (unit.phase, unit.state) == (0, GREEN)
    for _ in range(12):                 # exactly min_green = 6.0 s of green
        unit.step()
    assert unit.can_switch()
    unit.request_phase(1)
    states = []
    for _ in range(11):
        unit.step()
        states.append((unit.phase, unit.state))
    assert states[:6] == [(0, YELLOW)] * 6      # exactly yellow = 3.0 s
    assert states[6:10] == [(0, ALL_RED)] * 4   # exactly all_red = 2.0 s
    assert states[10] == (1, GREEN)             # new phase begins
    assert unit.time_in_phase == 0.0


def test_request_during_transition_ignored():
    unit = SignalUnit(make_ix(), dt=DT)
    for _ in range(12):
        unit.step()
    unit.request_phase(1)
    unit.step()
    assert unit.state == YELLOW
    unit.request_phase(0)               # ignored during yellow
    for _ in range(6):
        unit.step()
    assert unit.state == ALL_RED
    unit.request_phase(0)               # ignored during all-red
    for _ in range(4):
        unit.step()
    assert (unit.phase, unit.state) == (1, GREEN)
    for _ in range(50):                 # ignored requests never fire later
        unit.step()
        assert (unit.phase, unit.state) == (1, GREEN)


def test_request_before_min_green_queued_fires_at_min_green():
    unit = SignalUnit(make_ix(), dt=DT)
    for _ in range(4):                  # 2.0 s of green
        unit.step()
    assert not unit.can_switch()
    unit.request_phase(1)
    for _ in range(7):                  # green through 5.5 s: still queued
        unit.step()
        assert unit.state == GREEN
    unit.step()                         # tick 12: green time hits min_green
    assert (unit.phase, unit.state) == (0, YELLOW)
    assert unit.traj_time_in_phase == 0.0


def test_request_current_phase_noop():
    unit = SignalUnit(make_ix(), dt=DT)
    for _ in range(20):
        unit.step()
    assert unit.can_switch()
    unit.request_phase(0)
    for _ in range(50):
        unit.step()
        assert (unit.phase, unit.state) == (0, GREEN)


def test_signal_for_per_state():
    unit = SignalUnit(make_ix(), dt=DT)
    assert all(unit.signal_for(c) == GREEN for c in P0_CONNS)
    assert all(unit.signal_for(c) == ALL_RED for c in P1_CONNS)
    assert unit.signal_for(999) == ALL_RED      # unknown connection
    for _ in range(12):
        unit.step()
    unit.request_phase(1)
    unit.step()
    assert unit.state == YELLOW                 # yellow only for outgoing phase
    assert all(unit.signal_for(c) == YELLOW for c in P0_CONNS)
    assert all(unit.signal_for(c) == ALL_RED for c in P1_CONNS)
    for _ in range(6):
        unit.step()
    assert unit.state == ALL_RED
    assert all(unit.signal_for(c) == ALL_RED for c in (*P0_CONNS, *P1_CONNS))
    for _ in range(4):
        unit.step()
    assert (unit.phase, unit.state) == (1, GREEN)
    assert all(unit.signal_for(c) == GREEN for c in P1_CONNS)
    assert all(unit.signal_for(c) == ALL_RED for c in P0_CONNS)


def test_action_mask():
    unit = SignalUnit(make_ix(), dt=DT)
    m = unit.action_mask(2)
    assert m.dtype == np.bool_
    assert m.tolist() == [True, False]          # before min_green: current only
    for _ in range(12):
        unit.step()
    assert unit.action_mask(2).tolist() == [True, True]
    unit.request_phase(1)
    unit.step()
    assert unit.state == YELLOW                 # transition: locked to outgoing
    assert unit.action_mask(2).tolist() == [True, False]
    for _ in range(10):
        unit.step()
    assert (unit.phase, unit.state) == (1, GREEN)
    assert unit.action_mask(2).tolist() == [False, True]


def test_traj_time_in_phase_semantics():
    ix = make_ix()
    unit = SignalUnit(ix, dt=DT)
    assert unit.traj_time_in_phase == 0.0
    for k in range(1, 13):                      # green: since green start
        unit.step()
        assert unit.traj_time_in_phase == pytest.approx(k * DT)
    unit.request_phase(1)
    unit.step()
    assert unit.state == YELLOW
    assert unit.traj_time_in_phase == 0.0       # resets at transition start
    for k in range(1, 6):
        unit.step()
        assert unit.state == YELLOW
        assert unit.traj_time_in_phase == pytest.approx(k * DT)
        assert unit.time_in_phase == pytest.approx(k * DT)
    unit.step()
    assert unit.state == ALL_RED
    assert unit.traj_time_in_phase == pytest.approx(ix.yellow)  # runs through all-red
    assert unit.time_in_phase == 0.0            # segment clock resets
    for k in range(1, 4):
        unit.step()
        assert unit.traj_time_in_phase == pytest.approx(ix.yellow + k * DT)
    unit.step()
    assert (unit.phase, unit.state) == (1, GREEN)
    assert unit.traj_time_in_phase == 0.0       # new green restarts the clock


def test_fixed_cycle_green_durations_three_cycles():
    greens = [10.0, 8.0]
    cycle_ticks = round((10.0 + 8.0 + 2 * (3.0 + 2.0)) / DT)    # 56
    history = run_fixed_cycle(greens, 3 * cycle_ticks)
    runs = green_runs(history)
    assert [p for p, _ in runs[:6]] == [0, 1, 0, 1, 0, 1]       # 3 full cycles
    for phase, n_ticks in runs[:6]:
        assert n_ticks * DT == pytest.approx(greens[phase])


def test_no_drift_over_1000_steps():
    greens = [10.0, 8.0]
    pattern = ([(0, GREEN)] * 20 + [(0, YELLOW)] * 6 + [(0, ALL_RED)] * 4
               + [(1, GREEN)] * 16 + [(1, YELLOW)] * 6 + [(1, ALL_RED)] * 4)
    traj = ([k * DT for k in range(20)] + [k * DT for k in range(6)]
            + [3.0 + k * DT for k in range(4)] + [k * DT for k in range(16)]
            + [k * DT for k in range(6)] + [3.0 + k * DT for k in range(4)])
    assert len(pattern) == len(traj) == 56
    history = run_fixed_cycle(greens, 1000)
    for i, (phase, state, tip) in enumerate(history):
        j = i % 56
        assert (phase, state) == pattern[j], f"drift at tick {i}"
        assert tip == pytest.approx(traj[j]), f"traj drift at tick {i}"
