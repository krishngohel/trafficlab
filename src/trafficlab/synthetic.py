"""Synthetic trajectory generation: a fake but format-valid single intersection.

Used by the format tests and as a development fixture for the visualizer before
the real simulator exists. Vehicles stream through a 4-way intersection on
straight lanes; signals cycle through phases with yellow/all-red transitions.
"""
from __future__ import annotations

import numpy as np

from .trajectory import (
    FORMAT_VERSION, LANE_NONE, SIGNAL_ALL_RED, SIGNAL_DTYPE, SIGNAL_GREEN,
    SIGNAL_YELLOW, VEHICLE_DTYPE, TrajectoryWriter,
)

ARM = 120.0  # approach length in meters


def synthetic_meta(policy: str = "synthetic", seed: int | None = 0) -> dict:
    """Single 4-way intersection at the origin, one lane per direction each way."""
    nodes = [
        {"id": 0, "x": 0.0, "y": 0.0, "type": "intersection"},
        {"id": 1, "x": -ARM, "y": 0.0, "type": "boundary"},
        {"id": 2, "x": ARM, "y": 0.0, "type": "boundary"},
        {"id": 3, "x": 0.0, "y": -ARM, "type": "boundary"},
        {"id": 4, "x": 0.0, "y": ARM, "type": "boundary"},
    ]
    # 8 links: in/out on each arm. Lane id == link id (one lane per link).
    def lane(lid, x0, y0, x1, y1):
        return {"id": lid, "link": lid, "index": 0, "width": 3.5, "speed_limit": 13.9,
                "polyline": [[x0, y0], [x1, y1]]}
    links, lanes = [], []
    arms = [(1, -ARM, 0.0), (2, ARM, 0.0), (3, 0.0, -ARM), (4, 0.0, ARM)]
    lid = 0
    for node_id, x, y in arms:
        links.append({"id": lid, "from_node": node_id, "to_node": 0, "lanes": [lid]})
        lanes.append(lane(lid, x, y, x * 0.06, y * 0.06)); lid += 1
        links.append({"id": lid, "from_node": 0, "to_node": node_id, "lanes": [lid]})
        lanes.append(lane(lid, x * 0.06, y * 0.06, x, y)); lid += 1
    # Through connections only: W->E (lane 0 -> lane 3), E->W (2->1), S->N (4->7), N->S (6->5)
    connections = [
        {"id": 0, "from_lane": 0, "to_lane": 3, "movement": "through", "intersection": 0},
        {"id": 1, "from_lane": 2, "to_lane": 1, "movement": "through", "intersection": 0},
        {"id": 2, "from_lane": 4, "to_lane": 7, "movement": "through", "intersection": 0},
        {"id": 3, "from_lane": 6, "to_lane": 5, "movement": "through", "intersection": 0},
    ]
    intersections = [{
        "id": 0, "node": 0, "yellow": 3.0, "all_red": 2.0, "min_green": 5.0,
        "phases": [
            {"name": "EW", "connections": [0, 1]},
            {"name": "NS", "connections": [2, 3]},
        ],
    }]
    return {
        "format_version": FORMAT_VERSION,
        "dt": 0.5,
        "seed": seed,
        "policy": policy,
        "network_name": "synthetic_single",
        "network": {"nodes": nodes, "links": links, "lanes": lanes,
                    "connections": connections, "intersections": intersections},
        "intersections_order": [0],
        "approaches": [
            {"intersection": 0, "link": 0, "label": "W"},
            {"intersection": 0, "link": 2, "label": "E"},
            {"intersection": 0, "link": 4, "label": "S"},
            {"intersection": 0, "link": 6, "label": "N"},
        ],
        "metrics": ["active_vehicles", "cumulative_delay", "throughput", "mean_speed"],
    }


def write_synthetic(path, num_frames: int = 240, seed: int = 0, vehicles_per_dir: int = 6) -> dict:
    """Write a fake-but-valid trajectory; returns the meta dict."""
    rng = np.random.default_rng(seed)
    meta = synthetic_meta(seed=seed)
    dt = meta["dt"]
    # Vehicle streams: (in-lane id, out-lane id, direction unit vector)
    streams = [(0, 3, 1.0, 0.0), (2, 1, -1.0, 0.0), (4, 7, 0.0, 1.0), (6, 5, 0.0, -1.0)]
    # Each vehicle: (id, stream, s) where s in [-ARM, ARM] along travel direction.
    vehicles = []
    vid = 0
    for si in range(4):
        for j in range(vehicles_per_dir):
            vehicles.append([vid, si, -ARM + j * (2 * ARM / vehicles_per_dir) * rng.uniform(0.9, 1.0)])
            vid += 1
    green, yellow, all_red = 20.0, 3.0, 2.0
    cycle = 2 * (green + yellow + all_red)
    throughput = 0.0
    cum_delay = 0.0

    with TrajectoryWriter(path, meta) as w:
        for f in range(num_frames):
            t = f * dt
            tc = t % cycle
            half = green + yellow + all_red
            if tc < half:
                phase, tp = 0, tc
            else:
                phase, tp = 1, tc - half
            state = SIGNAL_GREEN if tp < green else (SIGNAL_YELLOW if tp < green + yellow else SIGNAL_ALL_RED)
            green_streams = (0, 1) if (phase == 0 and state == SIGNAL_GREEN) else (
                (2, 3) if (phase == 1 and state == SIGNAL_GREEN) else ())

            recs = np.zeros(len(vehicles), dtype=VEHICLE_DTYPE)
            speeds = []
            for r, v in enumerate(vehicles):
                _, si, s = v
                in_lane, out_lane, dx, dy = streams[si]
                speed = 12.0
                # Stop at the stop line (s = -8) when not green, then queue.
                if si not in green_streams and -40.0 < s < -7.0:
                    speed = max(0.0, 12.0 * (abs(s + 7.0) / 33.0) ** 2)
                s_new = s + speed * dt
                if s_new > ARM:  # respawn at entry
                    s_new = -ARM
                    throughput += 1
                v[2] = s_new
                if speed < 1.0:
                    cum_delay += dt
                on_conn = -7.0 <= s_new <= 7.0
                lane_id = LANE_NONE if on_conn else (in_lane if s_new < 0 else out_lane)
                recs[r] = (v[0], dx * s_new, dy * s_new,
                           float(np.arctan2(dy, dx)), speed, 0.0, lane_id,
                           (1 if speed < 1.0 else 0) | (8 if speed < 0.3 else 0), 0)
                speeds.append(speed)

            sig = np.zeros(1, dtype=SIGNAL_DTYPE)
            sig[0] = (phase, state, tp if state == SIGNAL_GREEN else tp - (green if state == SIGNAL_YELLOW else 0))
            sig[0]["time_in_phase"] = tp
            queues = np.zeros(4, dtype="<u2")
            for r, v in enumerate(vehicles):
                if recs[r]["flags"] & 8 and recs[r]["lane"] != LANE_NONE and recs[r]["lane"] in (0, 2, 4, 6):
                    queues[[0, 2, 4, 6].index(int(recs[r]["lane"]))] += 1
            rewards = np.array([-float(queues.sum())], dtype="<f4")
            metrics = np.array([len(vehicles), cum_delay, throughput,
                                float(np.mean(speeds)) if speeds else 0.0], dtype="<f4")
            w.write_frame(recs, sig, queues, rewards, metrics)
    return meta
