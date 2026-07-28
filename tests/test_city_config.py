"""The network model must follow the input data, not assume a shape.

Lane counts, movement-to-lane assignment, phasing and the emitted meta must all
change when the config changes. These pin that: a 3-lane avenue is drawn and
routed as three lanes, a 1-lane street with left turns gets split phasing, and
mixed networks carry per-link widths and speed limits through to the .traj meta
the visualizer renders from.
"""
import importlib.util
import json
from pathlib import Path

import pytest

from trafficlab.network import Network
from trafficlab.trajectory import _check_meta

ROOT = Path(__file__).resolve().parents[1]

_spec = importlib.util.spec_from_file_location("make_city", ROOT / "scripts" / "make_city.py")
make_city = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(make_city)


def grid(lanes: int) -> Network:
    return Network.from_config({
        "type": "grid", "rows": 2, "cols": 2, "block": 200.0, "arm": 150.0,
        "lanes": lanes, "speed_limit": 13.9,
    })


@pytest.mark.parametrize("lanes", [1, 2, 3, 4])
def test_link_lane_count_follows_config(lanes):
    net = grid(lanes)
    assert {len(l.lanes) for l in net.links.values()} == {lanes}
    # Every lane is a distinct, ordered, positive-length ribbon.
    for link in net.links.values():
        idxs = [net.lanes[l].index for l in link.lanes]
        assert idxs == sorted(idxs) == list(range(lanes))
        assert all(net.lanes[l].length > 0 for l in link.lanes)


@pytest.mark.parametrize("lanes,through_idx", [(1, [0]), (2, [1]), (3, [1, 2]), (4, [1, 2, 3])])
def test_movement_to_lane_rules_scale(lanes, through_idx):
    """Left from the leftmost lane, right from the rightmost, through from the rest."""
    net = grid(lanes)
    by_movement: dict[str, set[int]] = {}
    for conn in net.connections.values():
        by_movement.setdefault(conn.movement, set()).add(net.lanes[conn.from_lane].index)
    assert sorted(by_movement["through"]) == through_idx
    assert by_movement["left"] == {0}
    assert by_movement["right"] == {lanes - 1}


def test_lane_offsets_widen_with_lane_count():
    """A 3-lane road is physically wider than a 2-lane road."""
    def span(net: Network) -> float:
        link = next(iter(net.links.values()))
        ys = [net.lanes[l].polyline[0][1] for l in link.lanes]
        xs = [net.lanes[l].polyline[0][0] for l in link.lanes]
        return max(max(ys) - min(ys), max(xs) - min(xs))

    assert span(grid(3)) > span(grid(2)) > span(grid(1)) == 0.0


def test_single_lane_approach_with_lefts_gets_split_phasing():
    """Protected-left axis phasing would head-of-line-block a single lane."""
    two = grid(2)
    one = grid(1)
    assert [p.name for p in next(iter(two.intersections.values())).phases] == [
        "NS", "NS-L", "EW", "EW-L",
    ]
    assert [p.name for p in next(iter(one.intersections.values())).phases] == [
        "N", "S", "E", "W",
    ]


def test_mixed_network_phases_per_intersection():
    """Phasing is decided per intersection from that intersection's approaches."""
    cfg = make_city.build(rows=5, cols=5, block=220.0, arm=170.0)
    net = Network.from_config(cfg)
    assert len(net.intersections) == 25
    assert {len(l.lanes) for l in net.links.values()} == {1, 2, 3}

    shapes = {}
    for ix in net.intersections.values():
        shapes[tuple(p.name for p in ix.phases)] = shapes.get(
            tuple(p.name for p in ix.phases), 0) + 1
    # Standard 4-phase where both axes are multi-lane; split on whichever axis
    # the single-lane street runs.
    assert shapes[("NS", "NS-L", "EW", "EW-L")] == 16
    assert shapes[("NS", "NS-L", "E", "W")] == 4
    assert shapes[("N", "S", "EW", "EW-L")] == 4
    assert shapes[("N", "S", "E", "W")] == 1
    assert sum(shapes.values()) == 25


def test_mixed_network_meta_carries_per_link_geometry():
    """What the visualizer renders from must reflect the same variation."""
    cfg = make_city.build(rows=5, cols=5, block=220.0, arm=170.0)
    net = Network.from_config(cfg)
    meta_net = net.to_meta_network()

    lanes_per_link = sorted({len(l["lanes"]) for l in meta_net["links"]})
    assert lanes_per_link == [1, 2, 3]
    # Per-lane speed limits survive (avenue / street / local).
    assert len({l["speed_limit"] for l in meta_net["lanes"]}) == 3
    # Each lane carries its own polyline, so geometry is never inferred.
    assert all(len(l["polyline"]) >= 2 for l in meta_net["lanes"])

    meta = {
        "format_version": 1, "dt": 0.5, "seed": 0, "policy": "test",
        "network_name": "city", "network": meta_net,
        "intersections_order": sorted(net.intersections),
        "approaches": net.approaches(),
        "metrics": ["active_vehicles", "cumulative_delay", "throughput", "mean_speed"],
    }
    assert _check_meta(meta) == []
    json.dumps(meta, allow_nan=False)


def test_shipped_city_config_matches_generator():
    """configs/networks/city.json is the generator's output, not hand-drift."""
    shipped = json.loads((ROOT / "configs/networks/city.json").read_text())
    assert shipped == make_city.build(rows=5, cols=5, block=220.0, arm=170.0)
