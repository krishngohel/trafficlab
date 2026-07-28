"""Tests for trafficlab.network: geometry, topology, phases, meta export."""
from __future__ import annotations

import hashlib
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
    # EW approaches are single-lane WITH lefts -> split phasing (one
    # all-movements phase per approach), per SIM_DESIGN split-phasing rule.
    assert [p.name for p in net.intersections[0].phases] == ["E", "W"]


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
    # NS: single-lane but through-only (no lefts) -> merged axis phase kept.
    # EW: single-lane approaches with lefts -> split into per-approach phases.
    assert [p.name for p in net.intersections[0].phases] == ["NS", "E", "W"]


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


def heading_diff_deg(a: float, b: float) -> float:
    """Absolute difference between two headings (radians), in degrees."""
    return abs((math.degrees(a - b) + 180.0) % 360.0 - 180.0)


def test_turn_headings_match_lane_headings_grid2x2():
    # Tangent-intersection control points: a turn's heading at its first
    # sampled point matches the from-lane end heading within 5 degrees, and
    # its exit heading matches the to-lane start heading within 5 degrees.
    net = build("grid2x2")
    seen: set[str] = set()
    for cid in sorted(net.connections):
        conn = net.connections[cid]
        if conn.movement == "through":
            continue
        fl, tl = net.lanes[conn.from_lane], net.lanes[conn.to_lane]
        entry_kink = heading_diff_deg(conn.pose_at(0.0)[2], fl.pose_at(fl.length)[2])
        exit_kink = heading_diff_deg(conn.pose_at(conn.length)[2], tl.pose_at(0.0)[2])
        assert entry_kink < 5.0, f"conn {cid} ({conn.movement}) entry kink {entry_kink:.2f} deg"
        assert exit_kink < 5.0, f"conn {cid} ({conn.movement}) exit kink {exit_kink:.2f} deg"
        seen.add(conn.movement)
    assert seen == {"left", "right"}       # both movements sampled


def _proper_cross(p, q, r, s) -> bool:
    """True iff segments pq and rs properly cross (touching endpoints do not count)."""
    def orient(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    d1, d2 = orient(p, q, r), orient(p, q, s)
    d3, d4 = orient(r, s, p), orient(r, s, q)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def test_turns_do_not_cross_own_lane_through_single():
    # Old node-center Beziers bulged right turns leftward across the through
    # connection leaving the same lane; the new control points must not.
    net = build("single")
    pairs = 0
    for conn in net.connections.values():
        if conn.movement == "through":
            continue
        for cid in net.lane_connections[conn.from_lane]:
            through = net.connections[cid]
            if through.movement != "through":
                continue
            pairs += 1
            a, b = conn.polyline, through.polyline
            for i in range(len(a) - 1):
                for j in range(len(b) - 1):
                    assert not _proper_cross(a[i], a[i + 1], b[j], b[j + 1]), \
                        f"turn {conn.id} crosses its own lane's through {through.id}"
    assert pairs > 0                       # rights share their from-lane with a through


def test_lane_offset_right_of_centerline():
    net = build("single")
    # Eastbound entry lane (from W stub): right of travel = -Y; index 0 leftmost.
    wb = [l for l in net.links.values()
          if net.nodes[l.from_node].type == "boundary" and net.nodes[l.from_node].x < 0]
    link = wb[0]
    lane0, lane1 = net.lanes[link.lanes[0]], net.lanes[link.lanes[1]]
    assert lane0.polyline[0][1] == pytest.approx(-0.5 * 3.5)
    assert lane1.polyline[0][1] == pytest.approx(-1.5 * 3.5)


# ---------------------------------------------------------------- build validation

def test_build_rejects_edge_shorter_than_boxes():
    # span 10 m <= 9.5 m + 9.5 m box radii: lanes would silently build reversed.
    cfg = {
        "type": "explicit",
        "nodes": [
            {"id": 0, "x": 0.0, "y": 0.0, "type": "intersection"},
            {"id": 1, "x": 10.0, "y": 0.0, "type": "intersection"},
        ],
        "edges": [{"from": 0, "to": 1, "lanes": 1, "two_way": True}],
    }
    with pytest.raises(ValueError) as exc:
        Network.from_config(cfg)
    msg = str(exc.value)
    assert "node 0" in msg and "node 1" in msg          # both node ids
    assert "10.000" in msg                              # the span
    assert msg.count("9.500") == 2                      # both box radii


def test_build_rejects_coincident_nodes():
    cfg = {
        "type": "explicit",
        "nodes": [
            {"id": 3, "x": 5.0, "y": 5.0, "type": "intersection"},
            {"id": 4, "x": 5.0, "y": 5.0, "type": "boundary"},
        ],
        "edges": [{"from": 3, "to": 4, "lanes": 1, "two_way": False}],
    }
    with pytest.raises(ValueError, match=r"coincident nodes.*node 3.*node 4"):
        Network.from_config(cfg)


# ---------------------------------------------------------------- phase conflicts

@pytest.mark.parametrize("name", CONFIG_NAMES)
def test_shipped_configs_are_phase_conflict_free(name):
    build(name)                            # must not raise: opposing lefts clear


def test_diagonal_arm_rejected_at_build():
    # Arms at 0/30/180/210 degrees: the 0 and 30 degree arms both classify as
    # approach 'E'. Such configs used to slip through to phase construction and
    # put crossing movements in one green; now the approach-label collision
    # guard rejects them at build time, before phases are even assembled.
    def stub(i, ang):
        return {"id": i, "x": 150.0 * math.cos(math.radians(ang)),
                "y": 150.0 * math.sin(math.radians(ang)), "type": "boundary"}
    cfg = {
        "type": "explicit",
        "nodes": [{"id": 0, "x": 0.0, "y": 0.0, "type": "intersection"},
                  stub(1, 0.0), stub(2, 30.0), stub(3, 180.0), stub(4, 210.0)],
        "edges": [{"from": 0, "to": i, "lanes": 1, "two_way": True}
                  for i in range(1, 5)],
    }
    with pytest.raises(ValueError, match=r"both classify as approach 'E'"):
        Network.from_config(cfg)


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


# --------------------------------------------------------------------- golden
# The four shipped configs must keep building byte-identically forever: every
# committed evaluation result in results/ is keyed to this geometry. The
# fixtures were captured before off-street parking landed (docs/PARKING_DESIGN.md).
FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.mark.parametrize("name", CONFIG_NAMES)
def test_shipped_networks_match_the_pre_parking_golden(name):
    golden = (FIXTURES / f"golden_network_{name}.json").read_text()
    actual = json.dumps(build(name).to_meta_network(), sort_keys=True,
                        separators=(",", ":"))
    assert actual == golden, (
        f"{name}.json no longer builds byte-identically; results/ is invalidated")
    expected_hash = json.loads((FIXTURES / "golden_network_hashes.json").read_text())[name]
    assert hashlib.sha256(actual.encode()).hexdigest() == expected_hash
