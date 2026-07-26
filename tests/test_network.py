"""Tests for trafficlab.network: geometry, topology, phases, meta export."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from trafficlab.network import Lane, Network
from trafficlab.trajectory import FORMAT_VERSION, _check_meta

CONFIG_DIR = Path(__file__).resolve().parents[1] / "configs" / "networks"
CONFIG_NAMES = ["single", "grid2x2", "grid4x4", "arterial6"]


def load(name: str) -> dict:
    return json.loads((CONFIG_DIR / f"{name}.json").read_text())


def build(name: str) -> Network:
    return Network.from_config(load(name))


def make_meta(name: str, net: Network) -> dict:
    return {
        "format_version": FORMAT_VERSION,
        "dt": 0.5,
        "seed": 0,
        "policy": "test",
        "network_name": name,
        "network": net.to_meta_network(),
        "intersections_order": sorted(net.intersections),
        "approaches": net.approaches(),
        "metrics": ["active_vehicles", "cumulative_delay", "throughput", "mean_speed"],
    }


# ---------------------------------------------------------------- pose_at

def test_pose_at_arclength_and_heading():
    lane = Lane(0, 0, 0, 3.5, 13.9, np.array([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]))
    assert lane.length == pytest.approx(20.0)
    x, y, h = lane.pose_at(5.0)
    assert (x, y) == pytest.approx((5.0, 0.0))
    assert h == pytest.approx(0.0)
    x, y, h = lane.pose_at(15.0)
    assert (x, y) == pytest.approx((10.0, 5.0))
    assert h == pytest.approx(math.pi / 2)


def test_pose_at_clamps():
    lane = Lane(0, 0, 0, 3.5, 13.9, np.array([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]))
    assert lane.pose_at(-5.0)[:2] == pytest.approx((0.0, 0.0))
    assert lane.pose_at(999.0)[:2] == pytest.approx((10.0, 10.0))
    assert lane.pose_at(999.0)[2] == pytest.approx(math.pi / 2)


def test_connection_pose_at_endpoints():
    net = build("single")
    conn = next(net.connections[k] for k in sorted(net.connections)
                if net.connections[k].movement == "left")
    assert conn.polyline.shape == (12, 2)          # turns: 12-point Bezier
    x, y, _ = conn.pose_at(0.0)
    assert (x, y) == pytest.approx(tuple(conn.polyline[0]))
    x, y, _ = conn.pose_at(conn.length)
    assert (x, y) == pytest.approx(tuple(conn.polyline[-1]))


# ---------------------------------------------------------------- topology

def test_grid2x2_topology():
    net = build("grid2x2")
    assert len(net.intersections) == 4
    # 8 boundary stubs (2 per corner intersection) x 2 lanes per inbound link.
    assert len(net.entry_lanes) == 16
    assert net.entry_lanes == sorted(net.entry_lanes)
    for lid in net.entry_lanes:
        link = net.links[net.lanes[lid].link]
        assert net.nodes[link.from_node].type == "boundary"
    for ix_id in net.intersections:
        assert len(net.incoming_links(ix_id)) == 4


def test_arterial6_topology():
    net = build("arterial6")
    assert len(net.intersections) == 6
    # 12 cross stubs x 1 lane + 2 arterial end stubs x 2 lanes.
    assert len(net.entry_lanes) == 16
    single_lane_links = [l for l in net.links.values() if len(l.lanes) == 1]
    assert len(single_lane_links) == 24            # 12 two-way cross-stub roads


def test_approach_labels_single():
    net = build("single")
    aps = net.approaches()
    assert [a["label"] for a in aps] == ["N", "E", "S", "W"]
    assert [a["link"] for a in aps] == net.incoming_links(0)
    assert all(a["intersection"] == 0 for a in aps)


def test_lane_connections_sorted_and_complete():
    net = build("grid2x2")
    seen: set[int] = set()
    for lid, conns in net.lane_connections.items():
        assert conns == sorted(conns)
        for cid in conns:
            assert net.connections[cid].from_lane == lid
        seen.update(conns)
    assert seen == set(net.connections)


# ---------------------------------------------------------------- movements

@pytest.mark.parametrize("name", ["grid2x2", "arterial6"])
def test_movement_lane_rules(name):
    net = build(name)
    for conn in net.connections.values():
        lane = net.lanes[conn.from_lane]
        n_lanes = len(net.links[lane.link].lanes)
        if conn.movement == "left":
            assert lane.index == 0                 # left from lane 0 only
        elif conn.movement == "right":
            assert lane.index == n_lanes - 1       # right from rightmost only
        elif n_lanes >= 2:
            assert lane.index >= 1                 # lane 0 is dedicated left
        else:
            assert lane.index == 0                 # single lane: through allowed


def test_through_from_lane_zero_when_single_lane():
    net = build("arterial6")
    assert any(
        c.movement == "through" and net.lanes[c.from_lane].index == 0
        and len(net.links[net.lanes[c.from_lane].link].lanes) == 1
        for c in net.connections.values())


# ---------------------------------------------------------------- phases

def test_single_phase_construction():
    net = build("single")
    ix = net.intersections[0]
    assert [p.name for p in ix.phases] == ["NS", "NS-L", "EW", "EW-L"]
    for p in ix.phases:
        assert p.connections and p.connections == tuple(sorted(p.connections))
        movements = {net.connections[c].movement for c in p.connections}
        if p.name.endswith("-L"):
            assert movements == {"left"}
        else:
            assert movements <= {"through", "right"}
    in_phases = [c for p in ix.phases for c in p.connections]
    assert sorted(in_phases) == sorted(net.connections)  # each conn in exactly one phase
    assert len(in_phases) == len(set(in_phases))


def test_phase_skipping_empty_axis():
    # N/S roads one-way outbound: no NS approaches -> NS and NS-L skipped.
    cfg = {
        "type": "explicit",
        "nodes": [
            {"id": 0, "x": 0.0, "y": 0.0, "type": "intersection"},
            {"id": 1, "x": 0.0, "y": 150.0, "type": "boundary"},
            {"id": 2, "x": 0.0, "y": -150.0, "type": "boundary"},
            {"id": 3, "x": 150.0, "y": 0.0, "type": "boundary"},
            {"id": 4, "x": -150.0, "y": 0.0, "type": "boundary"},
        ],
        "edges": [
            {"from": 0, "to": 1, "lanes": 1, "two_way": False},
            {"from": 0, "to": 2, "lanes": 1, "two_way": False},
            {"from": 3, "to": 0, "lanes": 1, "two_way": True},
            {"from": 4, "to": 0, "lanes": 1, "two_way": True},
        ],
    }
    net = Network.from_config(cfg)
    assert [p.name for p in net.intersections[0].phases] == ["EW", "EW-L"]


def test_phase_skipping_left_phase_only():
    # E/W roads one-way inbound: NS axis keeps throughs but has no lefts -> no NS-L.
    cfg = {
        "type": "explicit",
        "nodes": [
            {"id": 0, "x": 0.0, "y": 0.0, "type": "intersection"},
            {"id": 1, "x": 0.0, "y": 150.0, "type": "boundary"},
            {"id": 2, "x": 0.0, "y": -150.0, "type": "boundary"},
            {"id": 3, "x": 150.0, "y": 0.0, "type": "boundary"},
            {"id": 4, "x": -150.0, "y": 0.0, "type": "boundary"},
        ],
        "edges": [
            {"from": 0, "to": 1, "lanes": 1, "two_way": True},
            {"from": 0, "to": 2, "lanes": 1, "two_way": True},
            {"from": 3, "to": 0, "lanes": 1, "two_way": False},
            {"from": 4, "to": 0, "lanes": 1, "two_way": False},
        ],
    }
    net = Network.from_config(cfg)
    assert [p.name for p in net.intersections[0].phases] == ["NS", "EW", "EW-L"]


# ---------------------------------------------------------------- geometry

def test_lane_cutback_to_intersection_box():
    net = build("grid2x2")
    r_box = 6.0 + 3.5 * 2                          # lanes=2 everywhere
    for lane in net.lanes.values():
        link = net.links[lane.link]
        a, b = net.nodes[link.from_node], net.nodes[link.to_node]
        span = math.hypot(b.x - a.x, b.y - a.y)
        ux, uy = (b.x - a.x) / span, (b.y - a.y) / span
        if b.type == "intersection":               # stop line = lane end at box edge
            ex, ey = lane.polyline[-1]
            assert (ex - b.x) * ux + (ey - b.y) * uy == pytest.approx(-r_box)
        if a.type == "intersection":
            sx, sy = lane.polyline[0]
            assert (sx - a.x) * ux + (sy - a.y) * uy == pytest.approx(r_box)


@pytest.mark.parametrize("name", CONFIG_NAMES)
def test_positive_lengths(name):
    net = build(name)
    assert net.lanes and net.connections
    for lane in net.lanes.values():
        assert lane.length > 0.0
    for conn in net.connections.values():
        assert conn.length > 0.0


def test_lane_offset_right_of_centerline():
    net = build("single")
    # Eastbound entry lane (from W stub): right of travel = -Y; index 0 leftmost.
    wb = [l for l in net.links.values()
          if net.nodes[l.from_node].type == "boundary" and net.nodes[l.from_node].x < 0]
    link = wb[0]
    lane0, lane1 = net.lanes[link.lanes[0]], net.lanes[link.lanes[1]]
    assert lane0.polyline[0][1] == pytest.approx(-0.5 * 3.5)
    assert lane1.polyline[0][1] == pytest.approx(-1.5 * 3.5)


# ---------------------------------------------------------------- meta + determinism

@pytest.mark.parametrize("name", CONFIG_NAMES)
def test_meta_passes_check(name):
    net = build(name)
    meta = make_meta(name, net)
    assert _check_meta(meta) == []
    json.dumps(meta, allow_nan=False)              # TrajectoryWriter-compatible


@pytest.mark.parametrize("name", CONFIG_NAMES)
def test_determinism(name):
    cfg = load(name)
    a, b = Network.from_config(cfg), Network.from_config(cfg)
    assert json.dumps(a.to_meta_network(), sort_keys=True) == \
        json.dumps(b.to_meta_network(), sort_keys=True)
    assert a.approaches() == b.approaches()
    assert a.entry_lanes == b.entry_lanes
    assert a.lane_connections == b.lane_connections
