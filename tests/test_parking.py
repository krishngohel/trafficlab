"""Off-street trip ends: garages, driveways, uncontrolled junctions, gap acceptance.

The contract is docs/PARKING_DESIGN.md. Everything here is opt-in: a config
without a "parking" block must build and run exactly as it did before, which is
pinned separately by the golden-network test in test_network.py.
"""
import importlib.util
import json
import math
from pathlib import Path

import pytest

from trafficlab import baselines
from trafficlab.env import TrafficEnv
from trafficlab.network import Network
from trafficlab.simulator import CRITICAL_GAP, MIN_CRITICAL_GAP, ON_CONN, ON_LANE, Simulator
from trafficlab.trajectory import validate_file

ROOT = Path(__file__).resolve().parents[1]

_spec = importlib.util.spec_from_file_location("make_city", ROOT / "scripts" / "make_city.py")
make_city = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(make_city)


def load(kind, name):
    return json.loads((ROOT / "configs" / kind / f"{name}.json").read_text())


def city_net() -> Network:
    return Network.from_config(load("networks", "city"))


# A west->east chain: boundary - intersection - (400 m street) - intersection -
# boundary. Only the middle edge is long enough for driveways at 150 m spacing,
# and it gets exactly two of them.
STREET_CFG = {
    "type": "explicit",
    "nodes": [
        {"id": 0, "x": -140.0, "y": 0.0, "type": "boundary"},
        {"id": 1, "x": 0.0, "y": 0.0, "type": "intersection"},
        {"id": 2, "x": 400.0, "y": 0.0, "type": "intersection"},
        {"id": 3, "x": 540.0, "y": 0.0, "type": "boundary"},
    ],
    "edges": [
        {"from": 0, "to": 1, "lanes": 2, "two_way": True, "speed_limit": 13.9},
        {"from": 1, "to": 2, "lanes": 2, "two_way": True, "speed_limit": 13.9},
        {"from": 2, "to": 3, "lanes": 2, "two_way": True, "speed_limit": 13.9},
    ],
    "parking": {"spacing": 150.0, "driveway_length": 14.0, "speed_limit": 5.6,
                "min_segment": 45.0, "streets_only": True},
}


def street_net() -> Network:
    return Network.from_config(STREET_CFG)


# ------------------------------------------------------------------ splitting
def test_link_splitting_preserves_length_and_cross_section():
    """A 400 m link with 2 driveways becomes 3 segments summing to 400 m."""
    net = street_net()
    assert len(net.driveways) == 2

    # The split chain 1 -> J -> J -> 2, walked in the eastbound direction.
    order = [1] + sorted(net.driveways, key=lambda j: net.nodes[j].x) + [2]
    assert [net.nodes[n].type for n in order] == [
        "intersection", "junction", "junction", "intersection"]
    by_pair = {(l.from_node, l.to_node): l for l in net.links.values()}
    chain = [by_pair[(a, b)] for a, b in zip(order, order[1:])]
    assert len(chain) == 3

    total = sum(math.dist((net.nodes[l.from_node].x, net.nodes[l.from_node].y),
                          (net.nodes[l.to_node].x, net.nodes[l.to_node].y)) for l in chain)
    assert total == pytest.approx(400.0, abs=1e-6)
    for link in chain:
        assert len(link.lanes) == 2
        for lane_id in link.lanes:
            assert net.lanes[lane_id].width == 3.5
            assert net.lanes[lane_id].speed_limit == 13.9


def test_driveway_geometry():
    """The driveway is a 1-lane, 14 m, 5.6 m/s link that starts at the kerb."""
    net = street_net()
    for jid in sorted(net.driveways):
        dw = net.driveways[jid]
        for lane_id in (dw.in_lane, dw.out_lane):
            lane = net.lanes[lane_id]
            assert len(net.links[lane.link].lanes) == 1
            assert lane.length == pytest.approx(14.0, abs=1e-6)
            assert lane.speed_limit == pytest.approx(5.6)
        # The garage sits clear of the carriageway.
        j, p = net.nodes[jid], net.nodes[dw.parking]
        assert math.dist((j.x, j.y), (p.x, p.y)) > 2 * 3.5 + 14.0


def test_parking_is_opt_in():
    cfg = dict(STREET_CFG)
    cfg.pop("parking")
    net = Network.from_config(cfg)
    assert net.driveways == {} and net.parking_nodes == []
    assert all(n.type in ("intersection", "boundary") for n in net.nodes.values())
    assert "junction_connections" not in net.to_meta_network()


def test_streets_only_skips_avenues():
    net = city_net()
    for jid, dw in net.driveways.items():
        street = net.links[net.lanes[dw.conflict_lane].link]
        assert len(street.lanes) < 3, "an avenue got a driveway despite streets_only"
    assert len(net.parking_nodes) == len(net.driveways) > 0


# --------------------------------------------------------- right-in/right-out
def junction_connections(net: Network, jid: int) -> list:
    return [c for c in (net.connections[k] for k in sorted(net.connections))
            if net.links[net.lanes[c.from_lane].link].to_node == jid]


@pytest.mark.parametrize("builder", [street_net, city_net])
def test_right_in_right_out_only(builder):
    net = builder()
    assert net.driveways
    for jid in sorted(net.driveways):
        dw = net.driveways[jid]
        conns = junction_connections(net, jid)
        into = [c for c in conns if c.to_lane == dw.in_lane]
        out_of = [c for c in conns if c.from_lane == dw.out_lane]
        assert len(into) == 1 and len(out_of) == 1
        assert into[0].movement == "right" and out_of[0].movement == "right"
        # Both sit on the rightmost lane of their street segment.
        street_in = net.links[net.lanes[into[0].from_lane].link]
        street_out = net.links[net.lanes[out_of[0].to_lane].link]
        assert into[0].from_lane == street_in.lanes[-1] == dw.conflict_lane
        assert out_of[0].to_lane == street_out.lanes[-1]
        # No lefts and no U-turns anywhere at a junction.
        assert {c.movement for c in conns} <= {"through", "right"}
        for c in conns:
            src = net.links[net.lanes[c.from_lane].link]
            dst = net.links[net.lanes[c.to_lane].link]
            assert not (src.from_node == dst.to_node), "U-turn generated at a junction"
        assert sum(1 for c in conns if c.movement == "right") == 2


def test_junctions_are_never_signalised():
    net = city_net()
    ix_nodes = {ix.node for ix in net.intersections.values()}
    assert not ix_nodes.intersection(net.driveways)
    assert not ix_nodes.intersection(net.parking_nodes)
    sim = Simulator(net, load("demand", "city"), seed=0, network_name="city")
    assert set(sim.units) == set(net.intersections)
    assert len(sim.units) == 25
    for c in net.connections.values():
        if c.intersection < 0:
            for ix in net.intersections.values():
                assert all(c.id not in ph.connections for ph in ix.phases)


def test_env_agent_count_is_the_signalised_count():
    env = TrafficEnv(load("networks", "city"), load("demand", "city"),
                     episode_seconds=10.0, network_name="city")
    net = city_net()
    assert len(env.agents) == len(net.intersections) == 25
    assert len(net.driveways) > 0


def test_meta_validates_and_carries_the_new_node_types():
    net = city_net()
    meta_net = net.to_meta_network()
    types = {n["type"] for n in meta_net["nodes"]}
    assert types == {"intersection", "boundary", "junction", "parking"}
    # Junction connections are additive: they never claim an intersection.
    assert all(c["intersection"] >= 0 for c in meta_net["connections"])
    assert len(meta_net["junction_connections"]) == len(net.connections) - len(meta_net["connections"])
    assert len(meta_net["driveways"]) == len(net.driveways)
    # Signalised connection ids stay dense 0..K-1 so index == id still holds.
    assert [c["id"] for c in meta_net["connections"]] == list(range(len(meta_net["connections"])))


# ------------------------------------------------------------ gap acceptance
def lag_headway(sim: Simulator, veh, dw) -> float:
    """Time-to-junction of the nearest upstream vehicle on the conflict lane."""
    occ = sim._occ_list(ON_LANE, dw.conflict_lane)
    if not occ:
        return math.inf
    lag = occ[-1]
    d = sim.net.lanes[dw.conflict_lane].length - lag.s
    return (d - lag.p.s0) / max(lag.v, 1.0)


def street_sim(base_rate: float, seed: int = 0) -> Simulator:
    net = street_net()
    return Simulator(net, {"base_rate": base_rate,
                           "turning": {"left": 0.2, "through": 0.65, "right": 0.15}},
                     seed=seed, network_name="street")


def test_exits_promptly_onto_an_empty_street():
    sim = street_sim(0.0)
    dw = sim.net.driveways[sorted(sim.net.driveways)[0]]
    assert sim._try_spawn(dw.out_lane)
    veh = sim.vehicles[max(sim.vehicles)]
    for _ in range(30):                                  # 15 s
        sim.step()
        if veh.kind == ON_CONN or veh.elem != dw.out_lane:
            break
    assert veh.elem != dw.out_lane, "a vehicle stalled leaving an empty street"
    assert veh.gap_wait == 0.0


def test_waits_when_the_conflict_lane_is_saturated():
    sim = street_sim(0.0)
    dw = sim.net.driveways[sorted(sim.net.driveways)[0]]
    for _ in range(60):                                  # prime a dense stream
        sim._try_spawn(dw.conflict_lane)
        sim.step()
    assert sim._try_spawn(dw.out_lane)
    veh = sim.vehicles[max(sim.vehicles)]
    for _ in range(30):
        sim._try_spawn(dw.conflict_lane)
        sim.step()
    assert veh.elem == dw.out_lane, "pulled out into a saturated stream"
    assert veh.gap_wait > 0.0


def test_never_accepts_a_gap_below_the_critical_headway():
    """Every realised entry had at least the vehicle's own critical gap."""
    sim = street_sim(0.0, seed=5)
    dws = [sim.net.driveways[j] for j in sorted(sim.net.driveways)]
    accepted: list[tuple[float, float]] = []
    for tick in range(1200):
        if tick % 14 == 0:                                # a gappy 7 s stream
            for dw in dws:
                sim._try_spawn(dw.conflict_lane)
        if tick % 25 == 0:
            for dw in dws:
                sim._try_spawn(dw.out_lane)
        before = {}
        for dw in dws:
            for veh in sim._occ_list(ON_LANE, dw.out_lane):
                before[veh.id] = (dw, lag_headway(sim, veh, dw), sim.critical_gap(veh))
        sim.step()
        for vid, (dw, headway, crit) in before.items():
            veh = sim.vehicles.get(vid)
            if veh is not None and veh.elem != dw.out_lane:
                accepted.append((headway, crit))
    assert len(accepted) > 10, "no driveway departures to check"
    for headway, crit in accepted:
        assert headway > crit - 1e-9, f"entered on a {headway:.2f} s gap (needed {crit:.2f})"
    assert min(c for _, c in accepted) >= MIN_CRITICAL_GAP - 1e-9
    assert max(c for _, c in accepted) <= CRITICAL_GAP + 1e-9


def test_critical_gap_relaxes_with_waiting():
    sim = street_sim(0.0)
    dw = sim.net.driveways[sorted(sim.net.driveways)[0]]
    assert sim._try_spawn(dw.out_lane)
    veh = sim.vehicles[max(sim.vehicles)]
    assert sim.critical_gap(veh) == pytest.approx(CRITICAL_GAP)
    veh.gap_wait = 30.0
    assert sim.critical_gap(veh) == pytest.approx(0.5 * (CRITICAL_GAP + MIN_CRITICAL_GAP))
    veh.gap_wait = 600.0
    assert sim.critical_gap(veh) == pytest.approx(MIN_CRITICAL_GAP)


# ------------------------------------------------------------------- city run
def run_city(ticks: int, seed: int = 3, base_rate: float | None = None,
             writer: Path | None = None, check: bool = True) -> Simulator:
    cfg = dict(load("demand", "city"))
    if base_rate is not None:
        cfg["base_rate"] = base_rate
    sim = Simulator(city_net(), cfg, seed=seed, network_name="city")
    if writer is not None:
        sim.attach_writer(writer, policy="actuated")
    controllers = baselines.build("actuated", sim)
    for tk in range(ticks):
        for c in controllers:
            c.step()
        sim.step()
        if check:
            assert sim.check_no_overlap() == [], f"tick {tk}: {sim.check_no_overlap()[:3]}"
            assert sim.spawned == sim.departed + sim.parked + len(sim.vehicles), \
                f"tick {tk}: conservation broken"
    if writer is not None:
        sim.close()
    return sim


def test_trips_complete_and_conserve():
    sim = run_city(900)
    assert sim.parked > 0, "nobody parked"
    assert sim.departed > 0
    assert sim.spawned == sim.departed + sim.parked + len(sim.vehicles)


def test_no_overlaps_including_driveways_and_junctions():
    sim = run_city(600, seed=1, base_rate=700.0)
    assert sim.check_no_overlap() == []
    # The invariant hook actually reached the new elements.
    keys = set(sim._occ)
    assert any((ON_LANE, dw.in_lane) in keys or (ON_LANE, dw.out_lane) in keys
               for dw in sim.net.driveways.values())
    assert any(k[0] == ON_CONN and sim.net.connections[k[1]].intersection < 0 for k in keys)


def test_no_driveway_starves_on_a_loaded_run():
    """Every garage that gets demand discharges a vehicle within 120 s."""
    sim = Simulator(city_net(), {**load("demand", "city"), "base_rate": 700.0},
                    seed=1, network_name="city")
    controllers = baselines.build("actuated", sim)
    first: dict[int, int] = {}
    discharged: dict[int, int] = {}
    ticks = 1200
    for tk in range(ticks):
        for c in controllers:
            c.step()
        before = {l: {v.id for v in sim._occ_list(ON_LANE, l)} for l in sorted(sim._exit_lanes)}
        sim.step()
        for lane_id in sorted(sim._exit_lanes):
            after = {v.id for v in sim._occ_list(ON_LANE, lane_id)}
            if after and lane_id not in first:
                first[lane_id] = tk
            if lane_id in first and lane_id not in discharged and (before[lane_id] - after):
                discharged[lane_id] = tk
    assert len(first) == len(sim.net.driveways) > 0, "some garages never got demand"
    late = {l: (discharged.get(l), first[l]) for l in first
            if first[l] < ticks - 240 and (discharged.get(l, 10 ** 9) - first[l]) > 240}
    assert not late, f"garages starved for more than 120 s: {late}"


def test_parking_run_is_byte_identical_under_a_seed(tmp_path):
    outs = []
    for run in range(2):
        p = tmp_path / f"park{run}.traj"
        run_city(400, seed=7, writer=p, check=False)
        outs.append(p.read_bytes())
    assert outs[0] == outs[1], "same seed produced different parking trajectories"
    other = tmp_path / "park_other.traj"
    run_city(400, seed=8, writer=other, check=False)
    assert other.read_bytes() != outs[0]


def test_parking_recording_validates(tmp_path):
    p = tmp_path / "park.traj"
    run_city(300, seed=2, writer=p, check=False)
    assert validate_file(p) == []


def test_light_demand_leaves_parking_dormant():
    """configs/demand/light.json has no parking block, so city runs unchanged."""
    sim = Simulator(city_net(), load("demand", "light"), seed=3, network_name="city")
    controllers = baselines.build("actuated", sim)
    for _ in range(400):
        for c in controllers:
            c.step()
        sim.step()
    assert sim.parked == 0
    assert all(v.park_after == math.inf for v in sim.vehicles.values())
    assert sim.spawned == sim.departed + len(sim.vehicles)
