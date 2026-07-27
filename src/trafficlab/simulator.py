"""Deterministic fixed-timestep microsimulation engine.

Integrates network, IDM/MOBIL, signals, and demand. Continuous space along
lane/connection arc length; synchronous acceleration update, semi-implicit
Euler integration; strict no-overlap insertion at element transitions.

Positions (x, y, heading) are only computed when a trajectory frame is being
recorded — headless training never pays for geometry.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from .demand import Demand
from .idm import DriverParams, idm_accel, mobil_ok
from .network import Network
from .signals import ALL_RED, GREEN, YELLOW, FixedCycleController, SignalUnit
from .trajectory import (
    FLAG_BRAKING, FLAG_LEFT_BLINKER, FLAG_QUEUED, FLAG_RIGHT_BLINKER,
    FORMAT_VERSION, LANE_NONE, SIGNAL_DTYPE, VEHICLE_DTYPE, TrajectoryWriter,
)

ON_LANE, ON_CONN = 0, 1
QUEUE_SPEED = 0.3      # m/s: below this a vehicle counts as queued
QUEUE_DIST = 100.0     # m from stop line within which queued vehicles count
LOOKAHEAD = 150.0      # m leader-search horizon
STOP_MARGIN = 1.0      # m gap kept to the stop line
FREE_GAP = 1e9
LC_FORBID_NEAR = 12.0  # no lane changes in the last metres before the stop line
GIVE_UP_DIST = 15.0    # wrong-lane fallback: re-pick movement this close to the line


class Vehicle:
    __slots__ = ("id", "kind", "elem", "s", "v", "acc", "p", "movement",
                 "next_conn", "needs_lane", "lc_cooldown", "entered_tick",
                 "delay", "wait")

    def __init__(self, vid: int, lane: int, params: DriverParams, tick: int):
        self.id = vid
        self.kind = ON_LANE
        self.elem = lane
        self.s = 0.0
        self.v = 0.0
        self.acc = 0.0
        self.p = params
        self.movement: str | None = None
        self.next_conn: int | None = None
        self.needs_lane: int | None = None
        self.lc_cooldown = 0.0
        self.entered_tick = tick
        self.delay = 0.0
        self.wait = 0.0


class Simulator:
    def __init__(self, network: Network, demand_cfg: dict, seed: int = 0,
                 dt: float = 0.5, network_name: str = ""):
        self.net = network
        self.dt = dt
        self.seed = seed
        self.network_name = network_name
        self.rng = np.random.default_rng(seed)
        self.demand = Demand(demand_cfg, network, self.rng)
        self.tick = 0
        self.vehicles: dict[int, Vehicle] = {}
        self._next_id = 0
        self._pending: dict[int, int] = {}      # entry lane -> queued spawn count
        self.units: dict[int, SignalUnit] = {
            ix_id: SignalUnit(ix, dt) for ix_id, ix in sorted(network.intersections.items())
        }
        self._node2ix = {ix.node: ix_id for ix_id, ix in network.intersections.items()}
        # Approaches: aligned with network.approaches() == .traj queue order.
        self._approaches = []
        for i, ap in enumerate(network.approaches()):
            lanes = tuple(network.links[ap["link"]].lanes)
            self._approaches.append((ap["intersection"], ap["link"], lanes))
        self._lane2approach = {}
        for i, (_ix, _link, lanes) in enumerate(self._approaches):
            for l in lanes:
                self._lane2approach[l] = i
        # Counters
        self.spawned = 0
        self.departed = 0
        self.crossings = {ix_id: 0 for ix_id in sorted(network.intersections)}
        self.cum_delay = 0.0
        self.wait_by_approach = np.zeros(len(self._approaches))
        self._occ: dict[tuple[int, int], list[Vehicle]] = {}
        self._writer: TrajectoryWriter | None = None
        self._reward_override: np.ndarray | None = None

    # ---------------------------------------------------------------- recording
    def attach_writer(self, path: str | Path, policy: str) -> None:
        meta = {
            "format_version": FORMAT_VERSION, "dt": self.dt, "seed": self.seed,
            "policy": policy, "network_name": self.network_name,
            "network": self.net.to_meta_network(),
            "intersections_order": sorted(self.net.intersections),
            "approaches": self.net.approaches(),
            "metrics": ["active_vehicles", "cumulative_delay", "throughput", "mean_speed"],
        }
        self._writer = TrajectoryWriter(path, meta)

    def close(self) -> None:
        if self._writer is not None:
            self._writer.close()
            self._writer = None

    def set_frame_rewards(self, rewards: np.ndarray | None) -> None:
        """Override the per-intersection reward written to the next frames."""
        self._reward_override = rewards

    # ---------------------------------------------------------------- stepping
    def request_phases(self, requests: dict[int, int]) -> None:
        for ix_id in sorted(requests):
            self.units[ix_id].request_phase(int(requests[ix_id]))

    def step(self) -> None:
        t = self.tick * self.dt
        for ix_id in sorted(self.units):
            self.units[ix_id].step()
        self._spawn(t)
        self._rebuild_occupancy()
        accels = self._compute_accels()
        self._lane_changes(accels)
        self._integrate(accels)
        self._account()
        if self._writer is not None:
            self._write_frame()
        self.tick += 1

    def run(self, ticks: int, controllers: list | None = None) -> None:
        for _ in range(ticks):
            if controllers:
                for c in controllers:
                    c.step()
            self.step()

    # ---------------------------------------------------------------- internals
    def _spawn(self, t: float) -> None:
        for lane_id in self.demand.arrivals(t, self.dt):
            self._pending[lane_id] = self._pending.get(lane_id, 0) + 1
        for lane_id in sorted(self._pending):
            while self._pending[lane_id] > 0:
                if not self._try_spawn(lane_id):
                    break
                self._pending[lane_id] -= 1

    def _try_spawn(self, lane_id: int) -> bool:
        lane = self.net.lanes[lane_id]
        occ = self._occ_list(ON_LANE, lane_id)
        params = DriverParams.sample(self.rng)
        v_init = min(params.v0, lane.speed_limit)
        if occ:
            rear = occ[0]                       # lowest s on the lane
            gap = (rear.s - rear.p.length) - 0.0
            if gap < params.s0 + 2.0:
                return False
            v_init = min(v_init, max(0.0, math.sqrt(max(0.0, 2.0 * params.b * (gap - params.s0)))))
        veh = Vehicle(self._next_id, lane_id, params, self.tick)
        veh.v = v_init
        self._next_id += 1
        self.vehicles[veh.id] = veh
        self._decide_route(veh)
        occ_list = self._occ.setdefault((ON_LANE, lane_id), [])
        occ_list.insert(0, veh)
        self.spawned += 1
        return True

    def _decide_route(self, veh: Vehicle) -> None:
        """Pick movement + connection for the intersection at the end of veh's lane."""
        lane = self.net.lanes[veh.elem]
        link = self.net.links[lane.link]
        node = self.net.nodes[link.to_node]
        veh.movement = None
        veh.next_conn = None
        veh.needs_lane = None
        if node.type == "boundary":
            return
        ix_id = self._node2ix[link.to_node]
        movement = self.demand.turn_for(ix_id, link.id)
        veh.movement = movement
        self._resolve_connection(veh, movement)

    def _resolve_connection(self, veh: Vehicle, movement: str) -> None:
        own = [c for c in self.net.lane_connections.get(veh.elem, ())
               if self.net.connections[c].movement == movement]
        if own:
            veh.next_conn = own[0]
            veh.needs_lane = None
            return
        # Movement not served by this lane: find the lane on this link that serves it.
        link = self.net.links[self.net.lanes[veh.elem].link]
        for lane_id in link.lanes:
            for c in self.net.lane_connections.get(lane_id, ()):
                if self.net.connections[c].movement == movement:
                    veh.next_conn = None
                    veh.needs_lane = lane_id
                    return
        # Movement impossible on this link (demand shouldn't do this): fall back.
        self._fallback_movement(veh)

    def _fallback_movement(self, veh: Vehicle) -> None:
        """Give up on the assigned movement; take whatever this lane offers."""
        conns = self.net.lane_connections.get(veh.elem, ())
        best = None
        for pref in ("through", "right", "left"):
            for c in conns:
                if self.net.connections[c].movement == pref:
                    best = c
                    break
            if best is not None:
                break
        if best is not None:
            veh.movement = self.net.connections[best].movement
            veh.next_conn = best
            veh.needs_lane = None

    def _rebuild_occupancy(self) -> None:
        occ: dict[tuple[int, int], list[Vehicle]] = {}
        for vid in sorted(self.vehicles):
            veh = self.vehicles[vid]
            occ.setdefault((veh.kind, veh.elem), []).append(veh)
        for lst in occ.values():
            lst.sort(key=lambda v: (v.s, v.id))
        self._occ = occ

    def _occ_list(self, kind: int, elem: int) -> list[Vehicle]:
        return self._occ.get((kind, elem), [])

    def _elem_len(self, kind: int, elem: int) -> float:
        return self.net.lanes[elem].length if kind == ON_LANE else self.net.connections[elem].length

    def _signal_gap(self, veh: Vehicle, d_stop: float) -> float | None:
        """Gap to a virtual red-light wall, or None if the vehicle may proceed."""
        if veh.next_conn is None:
            return max(0.0, d_stop - STOP_MARGIN)      # wrong lane / no legal movement
        ix_id = self.net.connections[veh.next_conn].intersection
        state = self.units[ix_id].signal_for(veh.next_conn)
        if state == GREEN:
            return None
        if state == YELLOW:
            # Proceed if stopping now needs harder braking than 3 m/s².
            if d_stop < veh.v * veh.v / 6.0 + veh.v * self.dt:
                return None
            return max(0.0, d_stop - STOP_MARGIN)
        return max(0.0, d_stop - STOP_MARGIN)

    def _leader_gap(self, veh: Vehicle) -> tuple[float, float]:
        """(gap, leader speed). Walks ahead across elements up to LOOKAHEAD."""
        occ = self._occ_list(veh.kind, veh.elem)
        idx = occ.index(veh)
        if idx + 1 < len(occ):
            lead = occ[idx + 1]
            return (lead.s - lead.p.length) - veh.s, lead.v
        # Front of this element: walk the path.
        dist = self._elem_len(veh.kind, veh.elem) - veh.s
        if veh.kind == ON_LANE:
            lane = self.net.lanes[veh.elem]
            if self.net.nodes[self.net.links[lane.link].to_node].type == "boundary":
                return FREE_GAP, 0.0                    # free exit ahead
            wall = self._signal_gap(veh, dist)
            if wall is not None:
                return wall, 0.0
            kind, elem = ON_CONN, veh.next_conn
        else:
            kind, elem = ON_LANE, self.net.connections[veh.elem].to_lane
        while dist < LOOKAHEAD:
            occ2 = self._occ_list(kind, elem)
            if occ2:
                lead = occ2[0]
                return dist + lead.s - lead.p.length, lead.v
            length = self._elem_len(kind, elem)
            dist += length
            if kind == ON_CONN:
                kind, elem = ON_LANE, self.net.connections[elem].to_lane
            else:
                break   # do not guess the next vehicle-specific turn beyond one lane
        return FREE_GAP, 0.0

    def _compute_accels(self) -> dict[int, float]:
        accels: dict[int, float] = {}
        for key in sorted(self._occ):
            for veh in self._occ[key]:
                gap, v_lead = self._leader_gap(veh)
                accels[veh.id] = float(idm_accel(veh.v, v_lead, gap, veh.p))
        return accels

    def _gaps_in_lane(self, target: int, s: float) -> tuple[Vehicle | None, Vehicle | None]:
        """(new_leader, new_follower) around position s in target lane."""
        occ = self._occ_list(ON_LANE, target)
        leader = follower = None
        for v in occ:
            if v.s > s:
                leader = v
                break
            follower = v
        return leader, follower

    def _accel_vs(self, veh: Vehicle, leader: Vehicle | None, extra_gap: float = 0.0) -> float:
        if leader is None:
            return float(idm_accel(veh.v, 0.0, FREE_GAP, veh.p))
        gap = (leader.s - leader.p.length) - veh.s + extra_gap
        return float(idm_accel(veh.v, leader.v, gap, veh.p))

    def _lane_changes(self, accels: dict[int, float]) -> None:
        for vid in sorted(self.vehicles):
            veh = self.vehicles[vid]
            if veh.kind != ON_LANE or veh.lc_cooldown > 0.0:
                continue
            lane = self.net.lanes[veh.elem]
            link = self.net.links[lane.link]
            if len(link.lanes) < 2:
                continue
            d_stop = lane.length - veh.s
            if d_stop < LC_FORBID_NEAR:
                if veh.needs_lane is not None and d_stop < GIVE_UP_DIST:
                    self._fallback_movement(veh)
                continue
            li = link.lanes.index(veh.elem)
            candidates: list[tuple[int, float]] = []
            if veh.needs_lane is not None:
                ti = link.lanes.index(veh.needs_lane)
                step = 1 if ti > li else -1
                target = link.lanes[li + step]
                bias = 0.5 + 2.0 * max(0.0, 1.0 - d_stop / 150.0)
                candidates.append((target, bias))
            else:
                if d_stop < 150.0:
                    continue                            # keep lane discipline near the line
                for ni in (li - 1, li + 1):
                    if 0 <= ni < len(link.lanes):
                        candidates.append((link.lanes[ni], 0.0))
            for target, bias in candidates:
                if veh.needs_lane is None and veh.movement is not None:
                    serves = any(self.net.connections[c].movement == veh.movement
                                 for c in self.net.lane_connections.get(target, ()))
                    if not serves and d_stop < 250.0:
                        continue
                new_leader, new_follower = self._gaps_in_lane(target, veh.s)
                if new_leader is not None and (new_leader.s - new_leader.p.length) - veh.s < veh.p.s0:
                    continue
                if new_follower is not None and (veh.s - veh.p.length) - new_follower.s < new_follower.p.s0:
                    continue
                a_self_new = self._accel_vs(veh, new_leader)
                a_self_old = accels[veh.id]
                a_nf_old = accels[new_follower.id] if new_follower else 0.0
                a_nf_new = (self._accel_vs(new_follower, veh) if new_follower else 0.0)
                occ = self._occ_list(ON_LANE, veh.elem)
                idx = occ.index(veh)
                old_follower = occ[idx - 1] if idx > 0 else None
                a_of_old = accels[old_follower.id] if old_follower else 0.0
                a_of_new = (self._accel_vs(old_follower, occ[idx + 1] if idx + 1 < len(occ) else None)
                            if old_follower else 0.0)
                if mobil_ok(a_self_new, a_self_old, a_nf_new, a_nf_old, a_of_new, a_of_old,
                            veh.p.politeness, veh.p.lc_threshold, bias=bias):
                    self._occ[(ON_LANE, veh.elem)].remove(veh)
                    veh.elem = target
                    veh.s = min(veh.s, self.net.lanes[target].length - 0.1)
                    tocc = self._occ.setdefault((ON_LANE, target), [])
                    tocc.append(veh)
                    tocc.sort(key=lambda v: (v.s, v.id))
                    veh.lc_cooldown = veh.p.lc_cooldown
                    accels[veh.id] = a_self_new
                    if veh.movement is not None:
                        self._resolve_connection(veh, veh.movement)
                    break

    def _integrate(self, accels: dict[int, float]) -> None:
        dt = self.dt
        departed: list[int] = []
        for vid in sorted(self.vehicles):
            veh = self.vehicles[vid]
            a = accels[vid]
            veh.acc = a
            veh.v = max(0.0, veh.v + a * dt)
            veh.s += veh.v * dt
            veh.lc_cooldown = max(0.0, veh.lc_cooldown - dt)
            # Element transitions (a vehicle can cross at most one boundary per tick
            # at plausible speeds; loop anyway for safety).
            while True:
                length = self._elem_len(veh.kind, veh.elem)
                if veh.s <= length:
                    break
                overshoot = veh.s - length
                if veh.kind == ON_LANE:
                    if veh.next_conn is None:
                        link = self.net.links[self.net.lanes[veh.elem].link]
                        if self.net.nodes[link.to_node].type == "boundary":
                            departed.append(vid)
                            break
                        veh.s = length          # wrong lane at the line: hold position
                        veh.v = 0.0
                        break
                    dest_kind, dest_elem = ON_CONN, veh.next_conn
                    self.crossings[self.net.connections[veh.next_conn].intersection] += 1
                else:
                    dest_kind, dest_elem = ON_LANE, self.net.connections[veh.elem].to_lane
                # Strict no-overlap insertion into the destination element.
                dest_occ = self._occ_list(dest_kind, dest_elem)
                s_new = overshoot
                if dest_occ:
                    rear = dest_occ[0]
                    limit = (rear.s - rear.p.length) - veh.p.s0 * 0.5
                    if s_new > limit:
                        if limit < 0.0:
                            veh.s = length - 0.01   # destination blocked: wait at the end
                            veh.v = 0.0
                            break
                        s_new = limit
                self._occ[(veh.kind, veh.elem)].remove(veh)
                veh.kind, veh.elem, veh.s = dest_kind, dest_elem, s_new
                dlist = self._occ.setdefault((dest_kind, dest_elem), [])
                dlist.insert(0, veh)
                dlist.sort(key=lambda v: (v.s, v.id))
                if dest_kind == ON_LANE:
                    self._decide_route(veh)
        for vid in departed:
            veh = self.vehicles.pop(vid)
            self._occ[(veh.kind, veh.elem)].remove(veh)
            self.departed += 1

    def _account(self) -> None:
        dt = self.dt
        for vid in sorted(self.vehicles):
            veh = self.vehicles[vid]
            veh.delay += dt * max(0.0, 1.0 - veh.v / veh.p.v0)
            self.cum_delay += dt * max(0.0, 1.0 - veh.v / veh.p.v0)
            if veh.kind == ON_LANE and veh.v < QUEUE_SPEED:
                ap = self._lane2approach.get(veh.elem)
                if ap is not None and self.net.lanes[veh.elem].length - veh.s <= QUEUE_DIST:
                    veh.wait += dt
                    self.wait_by_approach[ap] += dt

    # ---------------------------------------------------------------- observations
    def queues_by_approach(self) -> np.ndarray:
        q = np.zeros(len(self._approaches), dtype=np.int64)
        for i, (_ix, _link, lanes) in enumerate(self._approaches):
            for lane_id in lanes:
                lane_len = self.net.lanes[lane_id].length
                for veh in self._occ_list(ON_LANE, lane_id):
                    if veh.v < QUEUE_SPEED and lane_len - veh.s <= QUEUE_DIST:
                        q[i] += 1
        return q

    def density_by_approach(self) -> np.ndarray:
        d = np.zeros(len(self._approaches))
        for i, (_ix, _link, lanes) in enumerate(self._approaches):
            total_len = sum(self.net.lanes[l].length for l in lanes)
            n = sum(len(self._occ_list(ON_LANE, l)) for l in lanes)
            d[i] = n / max(total_len, 1.0) * 1000.0     # veh/km
        return d

    def vehicles_near_stop(self, lane_id: int, dist: float = 30.0) -> int:
        lane_len = self.net.lanes[lane_id].length
        return sum(1 for v in self._occ_list(ON_LANE, lane_id) if lane_len - v.s <= dist)

    def movement_pressure(self, conn_id: int) -> int:
        conn = self.net.connections[conn_id]
        up = sum(1 for v in self._occ_list(ON_LANE, conn.from_lane)
                 if v.next_conn == conn_id and
                 self.net.lanes[conn.from_lane].length - v.s <= QUEUE_DIST)
        down_lane = conn.to_lane
        down = sum(1 for v in self._occ_list(ON_LANE, down_lane) if v.s <= QUEUE_DIST)
        return up - down

    def phase_pressures(self, ix_id: int) -> np.ndarray:
        ix = self.net.intersections[ix_id]
        return np.array([sum(self.movement_pressure(c) for c in ph.connections)
                         for ph in ix.phases], dtype=np.float64)

    def intersection_pressure(self, ix_id: int) -> float:
        conns = sorted(c for c, conn in self.net.connections.items()
                       if conn.intersection == ix_id)
        return float(sum(self.movement_pressure(c) for c in conns))

    def default_rewards(self) -> np.ndarray:
        return np.array([-self.intersection_pressure(ix) for ix in sorted(self.net.intersections)],
                        dtype=np.float32)

    # ---------------------------------------------------------------- frame output
    def _write_frame(self) -> None:
        n = len(self.vehicles)
        recs = np.zeros(n, dtype=VEHICLE_DTYPE)
        speeds = 0.0
        for i, vid in enumerate(sorted(self.vehicles)):
            veh = self.vehicles[vid]
            if veh.kind == ON_LANE:
                lane = self.net.lanes[veh.elem]
                x, y, hdg = lane.pose_at(veh.s - veh.p.length * 0.5)
                lane_field = veh.elem
            else:
                conn = self.net.connections[veh.elem]
                x, y, hdg = conn.pose_at(veh.s - veh.p.length * 0.5)
                lane_field = LANE_NONE
            flags = 0
            if veh.acc < -1.0:
                flags |= FLAG_BRAKING
            if veh.needs_lane is not None:
                link = self.net.links[self.net.lanes[veh.elem].link] if veh.kind == ON_LANE else None
                if link is not None:
                    li, ti = link.lanes.index(veh.elem), link.lanes.index(veh.needs_lane)
                    flags |= FLAG_LEFT_BLINKER if ti < li else FLAG_RIGHT_BLINKER
            elif veh.movement == "left":
                flags |= FLAG_LEFT_BLINKER
            elif veh.movement == "right":
                flags |= FLAG_RIGHT_BLINKER
            if veh.v < QUEUE_SPEED and veh.kind == ON_LANE and \
                    self.net.lanes[veh.elem].length - veh.s <= QUEUE_DIST:
                flags |= FLAG_QUEUED
            recs[i] = (vid, x, y, hdg, veh.v, veh.acc, lane_field, flags, 0)
            speeds += veh.v
        order = sorted(self.net.intersections)
        sig = np.zeros(len(order), dtype=SIGNAL_DTYPE)
        for j, ix_id in enumerate(order):
            u = self.units[ix_id]
            sig[j] = (u.phase, u.state, u.traj_time_in_phase)
        rewards = (self._reward_override if self._reward_override is not None
                   else self.default_rewards())
        metrics = np.array([n, self.cum_delay, self.departed,
                            (speeds / n) if n else 0.0], dtype=np.float32)
        self._writer.write_frame(recs, sig,
                                 self.queues_by_approach().astype("<u2"),
                                 np.asarray(rewards, dtype="<f4"), metrics)

    # ---------------------------------------------------------------- invariants
    def check_no_overlap(self, tol: float = 0.01) -> list[str]:
        """Property-test hook: bumper overlap violations on every element."""
        problems = []
        for key in sorted(self._occ):
            occ = self._occ[key]
            for rear, front in zip(occ, occ[1:]):
                gap = (front.s - front.p.length) - rear.s
                if gap < -tol:
                    problems.append(f"overlap {gap:.3f} m between {rear.id} and {front.id} on {key}")
        return problems
