"""Tests for baselines.py: Webster fixed-time, actuated, and max-pressure
controllers plus the build() factory. Controllers are stepped once per tick
before sim.step(), matching the FixedCycleController convention.
"""
import json
import math
from pathlib import Path

import pytest

from trafficlab.baselines import (
    MAX_CYCLE, MIN_CYCLE, ActuatedController, MaxPressureController,
    WebsterController, build, webster_greens,
)
from trafficlab.network import Network
from trafficlab.signals import GREEN, FixedCycleController
from trafficlab.simulator import Simulator

ROOT = Path(__file__).resolve().parents[1]
KINDS = ("fixed", "webster", "actuated", "max_pressure")


def load(kind, name):
    return json.loads((ROOT / "configs" / kind / f"{name}.json").read_text())


def make_sim(network="single", demand="rush", seed=0):
    net = Network.from_config(load("networks", network))
    return Simulator(net, load("demand", demand), seed=seed, network_name=network)


# ---------------------------------------------------------------- webster
@pytest.mark.parametrize("network,demand", [
    ("single", "rush"),
    ("single", "heavy"),
    ("grid2x2", "light"),
])
def test_webster_greens_sane(network, demand):
    sim = make_sim(network, demand)
    for ix_id in sorted(sim.units):
        ix = sim.net.intersections[ix_id]
        greens = webster_greens(sim, ix_id)
        assert len(greens) == len(ix.phases)
        for g in greens:
            assert math.isfinite(g)
            assert g >= ix.min_green
        lost = len(ix.phases) * (ix.yellow + ix.all_red)
        implied_cycle = sum(greens) + lost
        # The design cycle is clipped to [MIN_CYCLE, MAX_CYCLE]; min-green
        # flooring can only stretch it, by at most one min_green per phase.
        assert MIN_CYCLE <= implied_cycle <= MAX_CYCLE + len(ix.phases) * ix.min_green


# ---------------------------------------------------------------- build()
@pytest.mark.parametrize("kind,cls", [
    ("fixed", FixedCycleController),
    ("webster", WebsterController),
    ("actuated", ActuatedController),
    ("max_pressure", MaxPressureController),
])
def test_build_one_controller_per_intersection(kind, cls):
    sim = make_sim("grid2x2", "rush")
    ctrls = build(kind, sim)
    assert len(ctrls) == len(sim.units) == 4
    assert all(isinstance(c, cls) for c in ctrls)
    # One controller per unit, in sorted intersection-id order.
    assert [c.unit for c in ctrls] == [sim.units[i] for i in sorted(sim.units)]


def test_build_unknown_kind_raises():
    sim = make_sim("single", "rush")
    with pytest.raises(ValueError):
        build("nonsense", sim)


# ---------------------------------------------------------------- throughput
@pytest.mark.parametrize("kind", KINDS)
def test_baseline_moves_traffic(kind):
    sim = make_sim("single", "rush", seed=1)
    ctrls = build(kind, sim)
    sim.run(1200, ctrls)                        # 10 sim-minutes
    assert sim.spawned > 50, "rush demand produced almost nothing"
    assert sim.departed > 0.3 * sim.spawned, (
        f"{kind}: only {sim.departed}/{sim.spawned} vehicles made it through")


# ---------------------------------------------------------------- max-pressure
def test_max_pressure_requests_only_when_switchable():
    sim = make_sim("single", "rush", seed=1)
    ix_id = sorted(sim.units)[0]
    unit = sim.units[ix_id]
    ctrl = MaxPressureController(sim, ix_id)
    calls = []
    original = unit.request_phase

    def spying_request(p):
        calls.append((p, unit.can_switch(), unit.state, unit.phase))
        return original(p)

    unit.request_phase = spying_request
    for _ in range(900):
        ctrl.step()
        sim.step()
    assert calls, "max-pressure never requested a switch in 450 s of rush demand"
    for p, could_switch, state, phase in calls:
        assert could_switch, "request_phase called while the unit could not switch"
        assert state == GREEN
        assert p != phase                       # only strictly-better phases


# ---------------------------------------------------------------- actuated
def test_actuated_rests_on_green_without_demand():
    net = Network.from_config(load("networks", "single"))
    sim = Simulator(net, {"base_rate": 0.0}, seed=0, network_name="single")
    ix_id = sorted(sim.units)[0]
    unit = sim.units[ix_id]
    ctrl = ActuatedController(sim, ix_id)
    # Settle well past min-green + gap time, then the green must rest forever.
    settle = int(round((unit.ix.min_green + ctrl.gap_time + 5.0) / sim.dt))
    for _ in range(settle):
        ctrl.step()
        sim.step()
    phase = unit.phase
    assert unit.state == GREEN
    for _ in range(400):
        ctrl.step()
        sim.step()
        assert unit.phase == phase, "actuated switched away with zero demand"
        assert unit.state == GREEN
    assert sim.spawned == 0


# ---------------------------------------------------------------- determinism
def test_baseline_run_deterministic():
    stats = []
    for _ in range(2):
        sim = make_sim("grid2x2", "rush", seed=9)
        ctrls = build("max_pressure", sim)
        sim.run(600, ctrls)
        stats.append((sim.spawned, sim.departed, sim.cum_delay, dict(sim.crossings)))
    assert stats[0] == stats[1], "same seed produced different run statistics"
