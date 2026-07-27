"""Tests for trafficlab.demand against a duck-typed fake network."""
from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from trafficlab.demand import Demand

TURNING = {"left": 0.2, "through": 0.65, "right": 0.15}


def make_network(reverse_dicts: bool = False):
    """Entry links 0 (lanes 0,1) and 1 (lanes 2,3); internal approach links 5
    (lanes 10,11) and 6 (lane 12) feeding intersection 7. Movements at ix 7:
    link 5 -> left+through only, link 6 -> right only."""
    lanes = {
        0: SimpleNamespace(id=0, link=0), 1: SimpleNamespace(id=1, link=0),
        2: SimpleNamespace(id=2, link=1), 3: SimpleNamespace(id=3, link=1),
        10: SimpleNamespace(id=10, link=5), 11: SimpleNamespace(id=11, link=5),
        12: SimpleNamespace(id=12, link=6),
    }
    links = {
        0: SimpleNamespace(id=0, lanes=[0, 1]),
        1: SimpleNamespace(id=1, lanes=[2, 3]),
        5: SimpleNamespace(id=5, lanes=[10, 11]),
        6: SimpleNamespace(id=6, lanes=[12]),
    }
    connections = {
        100: SimpleNamespace(id=100, from_lane=10, movement="left", intersection=7),
        101: SimpleNamespace(id=101, from_lane=11, movement="through", intersection=7),
        102: SimpleNamespace(id=102, from_lane=12, movement="right", intersection=7),
    }
    lane_connections = {10: [100], 11: [101], 12: [102]}
    if reverse_dicts:  # different insertion order, same contents
        lanes = dict(reversed(lanes.items()))
        links = dict(reversed(links.items()))
        connections = dict(reversed(connections.items()))
        lane_connections = dict(reversed(lane_connections.items()))
    return SimpleNamespace(
        lanes=lanes, links=links, connections=connections,
        lane_connections=lane_connections, entry_lanes=[0, 1, 2, 3],
    )


def link_of(net, lane_id: int) -> int:
    return net.lanes[lane_id].link


def test_poisson_total_within_3_sigma():
    net = make_network()
    d = Demand({"base_rate": 720.0, "turning": TURNING}, net, np.random.default_rng(42))
    dt, ticks = 0.5, 7200  # one hour
    total = sum(len(d.arrivals(i * dt, dt)) for i in range(ticks))
    expected = 2 * 720.0  # two entry links, veh/h each
    assert abs(total - expected) <= 3.0 * math.sqrt(expected)


def test_profile_piecewise_linear_clamped():
    net = make_network()
    cfg = {"base_rate": 100.0, "profile": [[10, 0.5], [20, 1.5], [40, 1.0]]}
    d = Demand(cfg, net, np.random.default_rng(0))
    assert d._multiplier(-5.0) == pytest.approx(0.5)   # clamped left
    assert d._multiplier(10.0) == pytest.approx(0.5)
    assert d._multiplier(15.0) == pytest.approx(1.0)
    assert d._multiplier(20.0) == pytest.approx(1.5)
    assert d._multiplier(30.0) == pytest.approx(1.25)
    assert d._multiplier(40.0) == pytest.approx(1.0)
    assert d._multiplier(1e6) == pytest.approx(1.0)    # clamped right
    # missing profile -> flat 1.0
    flat = Demand({"base_rate": 100.0}, net, np.random.default_rng(0))
    assert flat._multiplier(0.0) == flat._multiplier(9e9) == 1.0
    # zero multiplier clamps to zero arrivals at any t (public API)
    off = Demand({"base_rate": 10000.0, "profile": [[50, 0.0]]}, net, np.random.default_rng(1))
    assert off.arrivals(0.0, 0.5) == [] and off.arrivals(1e6, 0.5) == []


def test_per_entry_link_rate_override():
    net = make_network()
    cfg = {"base_rate": 0.0, "per_entry": {"0": 7200.0}}  # only link 0 spawns
    d = Demand(cfg, net, np.random.default_rng(7))
    dt, ticks = 0.5, 2000  # lambda = 1.0 per tick on link 0
    lanes = [lane for i in range(ticks) for lane in d.arrivals(i * dt, dt)]
    assert lanes and set(lanes) <= {0, 1}          # never lanes 2/3 (base_rate 0)
    assert abs(len(lanes) - 2000) <= 3.0 * math.sqrt(2000)
    assert lanes.count(0) > 800 and lanes.count(1) > 800  # split across lanes


def test_identical_seeds_identical_sequences():
    cfg = {"base_rate": 600.0, "profile": [[0, 0.8], [500, 1.4]],
           "per_entry": {"1": 900.0}, "turning": TURNING}
    seqs, turns = [], []
    for _ in range(2):
        d = Demand(cfg, make_network(), np.random.default_rng(999))
        seqs.append([d.arrivals(i * 0.5, 0.5) for i in range(300)])
        turns.append([d.turn_for(7, 5) for _ in range(100)])
    assert seqs[0] == seqs[1]
    assert turns[0] == turns[1]


def test_turn_for_renormalizes_over_available():
    net = make_network()
    d = Demand({"base_rate": 300.0, "turning": TURNING}, net, np.random.default_rng(3))
    samples = [d.turn_for(7, 5) for _ in range(4000)]
    assert set(samples) <= {"left", "through"}     # "right" unavailable at (7, 5)
    frac_through = samples.count("through") / len(samples)
    assert frac_through == pytest.approx(0.65 / 0.85, abs=0.04)
    # only "right" exists at (7, 6): always returned despite its small weight
    assert all(d.turn_for(7, 6) == "right" for _ in range(50))


def test_arrivals_follow_sorted_link_ids():
    cfg = {"base_rate": 3600.0, "turning": TURNING}
    a = Demand(cfg, make_network(), np.random.default_rng(11))
    b = Demand(cfg, make_network(reverse_dicts=True), np.random.default_rng(11))
    for i in range(400):
        tick_a, tick_b = a.arrivals(i * 0.5, 0.5), b.arrivals(i * 0.5, 0.5)
        assert tick_a == tick_b                    # insertion order irrelevant
        links = [link_of(a.network, lane) for lane in tick_a]
        assert links == sorted(links)              # grouped by ascending link id


def test_init_rejects_nan_base_rate():
    with pytest.raises(ValueError, match="base_rate"):
        Demand({"base_rate": float("nan")}, make_network(), np.random.default_rng(0))


def test_init_rejects_negative_per_entry():
    cfg = {"base_rate": 100.0, "per_entry": {"0": -5.0}}
    with pytest.raises(ValueError, match=r"per_entry rate for link '0'.*-5\.0"):
        Demand(cfg, make_network(), np.random.default_rng(0))


def test_init_rejects_negative_profile_point():
    cfg = {"base_rate": 100.0, "profile": [[0, 1.0], [60, -0.5]]}
    with pytest.raises(ValueError, match=r"profile multiplier at point \[60\.0, -0\.5\]"):
        Demand(cfg, make_network(), np.random.default_rng(0))


def test_shipped_configs_load():
    root = Path(__file__).resolve().parents[1] / "configs" / "demand"
    for name, rate in (("light", 300), ("rush", 500), ("heavy", 800)):
        cfg = json.loads((root / f"{name}.json").read_text())
        d = Demand(cfg, make_network(), np.random.default_rng(5))
        assert d.base_rate == rate
        assert isinstance(d.arrivals(0.0, 0.5), list)
    assert "profile" not in json.loads((root / "light.json").read_text())
