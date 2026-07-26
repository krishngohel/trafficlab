"""Property-based integration tests for the simulation engine.

Invariants: no vehicle overlaps, no backward motion, flow conservation,
red lights actually block movements, byte-level determinism under a seed.
"""
import json
from pathlib import Path

import numpy as np
import pytest

from trafficlab.network import Network
from trafficlab.signals import FixedCycleController
from trafficlab.simulator import ON_CONN, ON_LANE, Simulator
from trafficlab.trajectory import TrajectoryReader, validate_file

ROOT = Path(__file__).resolve().parents[1]


def load(kind, name):
    return json.loads((ROOT / "configs" / kind / f"{name}.json").read_text())


def make_sim(network="single", demand="rush", seed=0):
    net = Network.from_config(load("networks", network))
    return Simulator(net, load("demand", demand), seed=seed, network_name=network)


def default_controllers(sim):
    return [FixedCycleController(sim.units[i],
            [8.0 if ph.name.endswith("L") else 20.0 for ph in sim.net.intersections[i].phases])
            for i in sorted(sim.units)]


def run_with_invariants(sim, ticks):
    controllers = default_controllers(sim)
    for tk in range(ticks):
        before = {vid: (v.kind, v.elem, v.s) for vid, v in sim.vehicles.items()}
        for c in controllers:
            c.step()
        sim.step()
        # No overlaps, ever.
        problems = sim.check_no_overlap()
        assert problems == [], f"tick {tk}: {problems[:3]}"
        # Flow conservation and non-negative speeds.
        assert sim.spawned == sim.departed + len(sim.vehicles), f"tick {tk}: conservation"
        for vid, veh in sim.vehicles.items():
            assert veh.v >= 0.0, f"tick {tk}: vehicle {vid} negative speed {veh.v}"
            if vid in before:
                kind0, elem0, s0 = before[vid]
                if (veh.kind, veh.elem) == (kind0, elem0):
                    assert veh.s >= s0 - 1e-9, f"tick {tk}: vehicle {vid} moved backward"


@pytest.mark.parametrize("network,demand,seed", [
    ("single", "heavy", 0),
    ("single", "rush", 3),
    ("grid2x2", "rush", 1),
    ("grid2x2", "light", 7),
    ("arterial6", "rush", 2),
])
def test_invariants(network, demand, seed):
    run_with_invariants(make_sim(network, demand, seed), ticks=360)


def test_invariants_grid4x4_short():
    run_with_invariants(make_sim("grid4x4", "heavy", 5), ticks=160)


def test_vehicles_flow_through():
    sim = make_sim("single", "heavy", 0)
    controllers = default_controllers(sim)
    for _ in range(1200):
        for c in controllers:
            c.step()
        sim.step()
    assert sim.spawned > 100, "demand produced almost nothing"
    assert sim.departed > 0.4 * sim.spawned, (
        f"only {sim.departed}/{sim.spawned} vehicles made it through in 10 min")


def test_red_light_blocks():
    """Pin the signal on phase 0 (NS); westbound entries must never cross."""
    net = Network.from_config(load("networks", "single"))
    demand_cfg = dict(load("demand", "heavy"))
    # Restrict demand to entry links pointing east/westbound only via per_entry.
    entry_links = sorted({net.lanes[l].link for l in net.entry_lanes})
    # Find the link whose entry heads toward the intersection along +X (west arm).
    per_entry = {}
    for link_id in entry_links:
        lane = net.lanes[net.links[link_id].lanes[0]]
        (x0, y0), (x1, y1) = lane.polyline[0], lane.polyline[-1]
        heads_east = abs(x1 - x0) > abs(y1 - y0) and x1 > x0
        per_entry[str(link_id)] = 900 if heads_east else 0
    demand_cfg["per_entry"] = per_entry
    sim = Simulator(net, demand_cfg, seed=0, network_name="single")
    ix_id = sorted(sim.units)[0]
    phases = sim.net.intersections[ix_id].phases
    ns_idx = next(i for i, ph in enumerate(phases) if ph.name.startswith("NS"))
    pinned = FixedCycleController(sim.units[ix_id], [3600.0] * len(phases))
    assert sim.units[ix_id].phase == 0
    # If phase 0 isn't NS, request it once and let it settle before spawning matters.
    sim.units[ix_id].request_phase(ns_idx)
    for _ in range(600):
        pinned.step()
        sim.step()
        for veh in sim.vehicles.values():
            assert veh.kind == ON_LANE, "vehicle entered the intersection against a red"
    assert sim.departed == 0
    assert sim.spawned > 5
    assert sim.queues_by_approach().sum() > 0, "expected a growing queue at the red"


def test_determinism_byte_identical(tmp_path):
    outs = []
    for run in range(2):
        p = tmp_path / f"det{run}.traj"
        sim = make_sim("grid2x2", "rush", seed=11)
        sim.attach_writer(p, policy="fixed")
        controllers = default_controllers(sim)
        for _ in range(240):
            for c in controllers:
                c.step()
            sim.step()
        sim.close()
        outs.append(p.read_bytes())
    assert outs[0] == outs[1], "same seed produced different trajectories"
    p = tmp_path / "det_other.traj"
    sim = make_sim("grid2x2", "rush", seed=12)
    sim.attach_writer(p, policy="fixed")
    controllers = default_controllers(sim)
    for _ in range(240):
        for c in controllers:
            c.step()
        sim.step()
    sim.close()
    assert p.read_bytes() != outs[0], "different seeds produced identical trajectories"


def test_recording_is_valid_and_consistent(tmp_path):
    p = tmp_path / "rec.traj"
    sim = make_sim("single", "rush", seed=4)
    sim.attach_writer(p, policy="fixed")
    controllers = default_controllers(sim)
    for _ in range(300):
        for c in controllers:
            c.step()
        sim.step()
    sim.close()
    assert validate_file(p) == []
    r = TrajectoryReader(p)
    assert r.num_frames == 300
    # Queue array in the file equals the number of FLAG_QUEUED vehicles per frame.
    for i in (50, 150, 299):
        fr = r.frame(i)
        assert int(fr.queues.sum()) == int((fr.vehicles["flags"] & 8 != 0).sum())
    # Metrics sane: throughput non-decreasing, active matches vehicle count.
    prev_tp = -1.0
    for i in range(0, 300, 25):
        fr = r.frame(i)
        assert fr.metrics[0] == len(fr.vehicles)
        assert fr.metrics[2] >= prev_tp
        prev_tp = fr.metrics[2]
