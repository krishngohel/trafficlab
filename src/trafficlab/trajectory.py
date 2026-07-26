"""Reader/writer/validator for the .traj binary trajectory format (v1).

See docs/TRAJECTORY_FORMAT.md for the authoritative spec. All multi-byte
values are little-endian and packed. The file layout is:

    [header 12B][meta JSON][frame 0]...[frame N-1][index 8N B][trailer 16B]
"""
from __future__ import annotations

import io
import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterator

import numpy as np

MAGIC = b"TLTJ"
INDEX_MAGIC = b"TLIX"
FORMAT_VERSION = 1
HEADER_STRUCT = struct.Struct("<4sHHI")     # magic, version, flags, meta_len
TRAILER_STRUCT = struct.Struct("<IQ4s")     # num_frames, index_offset, magic
FRAME_HEAD_STRUCT = struct.Struct("<III")   # frame_len, tick, n_vehicles

LANE_NONE = 0xFFFF  # vehicle is on a connection inside an intersection

VEHICLE_DTYPE = np.dtype([
    ("id", "<u4"), ("x", "<f4"), ("y", "<f4"), ("heading", "<f4"),
    ("speed", "<f4"), ("accel", "<f4"), ("lane", "<u2"),
    ("flags", "u1"), ("vclass", "u1"),
])
SIGNAL_DTYPE = np.dtype([("phase", "u1"), ("state", "u1"), ("time_in_phase", "<f4")])
assert VEHICLE_DTYPE.itemsize == 28 and SIGNAL_DTYPE.itemsize == 6

FLAG_BRAKING = 1
FLAG_LEFT_BLINKER = 2
FLAG_RIGHT_BLINKER = 4
FLAG_QUEUED = 8

SIGNAL_GREEN, SIGNAL_YELLOW, SIGNAL_ALL_RED = 0, 1, 2

REQUIRED_META_KEYS = (
    "format_version", "dt", "seed", "policy", "network_name",
    "network", "intersections_order", "approaches", "metrics",
)
REQUIRED_NETWORK_KEYS = ("nodes", "links", "lanes", "connections", "intersections")


@dataclass
class Frame:
    tick: int
    vehicles: np.ndarray   # VEHICLE_DTYPE, shape (n,)
    signals: np.ndarray    # SIGNAL_DTYPE, shape (K,)
    queues: np.ndarray     # uint16, shape (A,)
    rewards: np.ndarray    # float32, shape (K,)
    metrics: np.ndarray    # float32, shape (M,)


def _meta_counts(meta: dict) -> tuple[int, int, int]:
    """(K intersections, A approaches, M metrics) as defined by meta."""
    return len(meta["intersections_order"]), len(meta["approaches"]), len(meta["metrics"])


def _check_meta(meta: dict) -> list[str]:
    errors = []
    for key in REQUIRED_META_KEYS:
        if key not in meta:
            errors.append(f"meta: missing required key '{key}'")
    if errors:
        return errors
    if meta["format_version"] != FORMAT_VERSION:
        errors.append(f"meta: format_version {meta['format_version']} != {FORMAT_VERSION}")
    if not (isinstance(meta["dt"], (int, float)) and meta["dt"] > 0):
        errors.append("meta: dt must be a positive number")
    net = meta["network"]
    for key in REQUIRED_NETWORK_KEYS:
        if key not in net:
            errors.append(f"meta.network: missing key '{key}'")
    if errors:
        return errors

    node_ids = {n["id"] for n in net["nodes"]}
    link_ids = {l["id"] for l in net["links"]}
    lane_ids = {l["id"] for l in net["lanes"]}
    conn_ids = {c["id"] for c in net["connections"]}
    ix_ids = {i["id"] for i in net["intersections"]}

    for link in net["links"]:
        if link["from_node"] not in node_ids or link["to_node"] not in node_ids:
            errors.append(f"link {link['id']}: unresolved node reference")
        for lane_id in link["lanes"]:
            if lane_id not in lane_ids:
                errors.append(f"link {link['id']}: unknown lane {lane_id}")
    for lane in net["lanes"]:
        if lane["link"] not in link_ids:
            errors.append(f"lane {lane['id']}: unknown link {lane['link']}")
        if len(lane.get("polyline", [])) < 2:
            errors.append(f"lane {lane['id']}: polyline needs >= 2 points")
    for conn in net["connections"]:
        if conn["from_lane"] not in lane_ids or conn["to_lane"] not in lane_ids:
            errors.append(f"connection {conn['id']}: unresolved lane reference")
        if conn["intersection"] not in ix_ids:
            errors.append(f"connection {conn['id']}: unknown intersection")
    for ix in net["intersections"]:
        if ix["node"] not in node_ids:
            errors.append(f"intersection {ix['id']}: unknown node {ix['node']}")
        if not ix.get("phases"):
            errors.append(f"intersection {ix['id']}: needs >= 1 phase")
        for phase in ix.get("phases", []):
            for cid in phase["connections"]:
                if cid not in conn_ids:
                    errors.append(f"intersection {ix['id']} phase '{phase.get('name')}': unknown connection {cid}")
    for ix_id in meta["intersections_order"]:
        if ix_id not in ix_ids:
            errors.append(f"intersections_order: unknown intersection {ix_id}")
    if len(set(meta["intersections_order"])) != len(meta["intersections_order"]):
        errors.append("intersections_order: duplicate ids")
    for i, ap in enumerate(meta["approaches"]):
        if ap["intersection"] not in ix_ids:
            errors.append(f"approaches[{i}]: unknown intersection {ap['intersection']}")
        if ap["link"] not in link_ids:
            errors.append(f"approaches[{i}]: unknown link {ap['link']}")
    return errors


def frame_payload_len(n_vehicles: int, k: int, a: int, m: int) -> int:
    return 8 + 28 * n_vehicles + 6 * k + 2 * a + 4 * k + 4 * m


class TrajectoryWriter:
    """Streams frames to a .traj file. Call close() (or use as context manager)."""

    def __init__(self, path_or_file: str | Path | BinaryIO, meta: dict):
        errors = _check_meta(meta)
        if errors:
            raise ValueError("invalid meta: " + "; ".join(errors[:5]))
        self.meta = meta
        self.k, self.a, self.m = _meta_counts(meta)
        if isinstance(path_or_file, (str, Path)):
            Path(path_or_file).parent.mkdir(parents=True, exist_ok=True)
            self._f: BinaryIO = open(path_or_file, "wb")
            self._owns = True
        else:
            self._f = path_or_file
            self._owns = False
        self._offsets: list[int] = []
        self._next_tick = 0
        self._closed = False
        meta_bytes = json.dumps(meta, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self._f.write(HEADER_STRUCT.pack(MAGIC, FORMAT_VERSION, 0, len(meta_bytes)))
        self._f.write(meta_bytes)
        self._pos = HEADER_STRUCT.size + len(meta_bytes)

    def write_frame(self, vehicles, signals, queues, rewards, metrics, tick: int | None = None) -> None:
        if self._closed:
            raise ValueError("writer is closed")
        vehicles = np.ascontiguousarray(np.asarray(vehicles, dtype=VEHICLE_DTYPE))
        signals = np.ascontiguousarray(np.asarray(signals, dtype=SIGNAL_DTYPE))
        queues = np.ascontiguousarray(np.asarray(queues, dtype="<u2"))
        rewards = np.ascontiguousarray(np.asarray(rewards, dtype="<f4"))
        metrics = np.ascontiguousarray(np.asarray(metrics, dtype="<f4"))
        if signals.shape != (self.k,):
            raise ValueError(f"signals shape {signals.shape} != ({self.k},)")
        if queues.shape != (self.a,):
            raise ValueError(f"queues shape {queues.shape} != ({self.a},)")
        if rewards.shape != (self.k,):
            raise ValueError(f"rewards shape {rewards.shape} != ({self.k},)")
        if metrics.shape != (self.m,):
            raise ValueError(f"metrics shape {metrics.shape} != ({self.m},)")
        if tick is None:
            tick = self._next_tick
        elif tick != self._next_tick:
            raise ValueError(f"tick {tick} out of order, expected {self._next_tick}")
        n = len(vehicles)
        payload_len = frame_payload_len(n, self.k, self.a, self.m)
        self._offsets.append(self._pos)
        self._f.write(FRAME_HEAD_STRUCT.pack(payload_len, tick, n))
        self._f.write(vehicles.tobytes())
        self._f.write(signals.tobytes())
        self._f.write(queues.tobytes())
        self._f.write(rewards.tobytes())
        self._f.write(metrics.tobytes())
        self._pos += 4 + payload_len
        self._next_tick += 1

    @property
    def num_frames(self) -> int:
        return len(self._offsets)

    def close(self) -> None:
        if self._closed:
            return
        index_offset = self._pos
        self._f.write(np.asarray(self._offsets, dtype="<u8").tobytes())
        self._f.write(TRAILER_STRUCT.pack(len(self._offsets), index_offset, INDEX_MAGIC))
        if self._owns:
            self._f.close()
        self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class TrajectoryReader:
    """Random-access reader. Loads the whole file into memory (files are local replays)."""

    def __init__(self, path_or_bytes: str | Path | bytes):
        if isinstance(path_or_bytes, bytes):
            self._buf = path_or_bytes
        else:
            self._buf = Path(path_or_bytes).read_bytes()
        buf = self._buf
        if len(buf) < HEADER_STRUCT.size + TRAILER_STRUCT.size:
            raise ValueError("file too short to be a .traj file")
        magic, version, _flags, meta_len = HEADER_STRUCT.unpack_from(buf, 0)
        if magic != MAGIC:
            raise ValueError(f"bad magic {magic!r}")
        if version != FORMAT_VERSION:
            raise ValueError(f"unsupported version {version}")
        self.meta = json.loads(buf[HEADER_STRUCT.size:HEADER_STRUCT.size + meta_len].decode("utf-8"))
        self.k, self.a, self.m = _meta_counts(self.meta)
        num_frames, index_offset, trailer_magic = TRAILER_STRUCT.unpack_from(buf, len(buf) - TRAILER_STRUCT.size)
        if trailer_magic != INDEX_MAGIC:
            raise ValueError(f"bad trailer magic {trailer_magic!r}")
        expected_size = index_offset + 8 * num_frames + TRAILER_STRUCT.size
        if expected_size != len(buf):
            raise ValueError(f"file size {len(buf)} != expected {expected_size}")
        self.num_frames = num_frames
        self._offsets = np.frombuffer(buf, dtype="<u8", count=num_frames, offset=index_offset)

    def __len__(self) -> int:
        return self.num_frames

    def frame(self, i: int) -> Frame:
        if not 0 <= i < self.num_frames:
            raise IndexError(i)
        buf = self._buf
        off = int(self._offsets[i])
        payload_len, tick, n = FRAME_HEAD_STRUCT.unpack_from(buf, off)
        if payload_len != frame_payload_len(n, self.k, self.a, self.m):
            raise ValueError(f"frame {i}: inconsistent frame_len")
        p = off + 12
        vehicles = np.frombuffer(buf, dtype=VEHICLE_DTYPE, count=n, offset=p); p += 28 * n
        signals = np.frombuffer(buf, dtype=SIGNAL_DTYPE, count=self.k, offset=p); p += 6 * self.k
        queues = np.frombuffer(buf, dtype="<u2", count=self.a, offset=p); p += 2 * self.a
        rewards = np.frombuffer(buf, dtype="<f4", count=self.k, offset=p); p += 4 * self.k
        metrics = np.frombuffer(buf, dtype="<f4", count=self.m, offset=p)
        return Frame(tick, vehicles, signals, queues, rewards, metrics)

    def __iter__(self) -> Iterator[Frame]:
        for i in range(self.num_frames):
            yield self.frame(i)


def validate_bytes(buf: bytes, max_errors: int = 20, deep: bool = True) -> list[str]:
    """Validate a .traj byte string. Returns a list of errors; empty means valid."""
    errors: list[str] = []

    def fail(msg: str) -> bool:
        errors.append(msg)
        return len(errors) >= max_errors

    if len(buf) < HEADER_STRUCT.size + TRAILER_STRUCT.size:
        return ["file too short"]
    magic, version, _flags, meta_len = HEADER_STRUCT.unpack_from(buf, 0)
    if magic != MAGIC:
        return [f"bad header magic {magic!r}"]
    if version != FORMAT_VERSION:
        return [f"unsupported version {version}"]
    if HEADER_STRUCT.size + meta_len > len(buf) - TRAILER_STRUCT.size:
        return ["meta_len exceeds file size"]
    try:
        meta = json.loads(buf[HEADER_STRUCT.size:HEADER_STRUCT.size + meta_len].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        return [f"meta JSON parse error: {e}"]
    errors.extend(_check_meta(meta))
    if errors:
        return errors
    k, a, m = _meta_counts(meta)

    num_frames, index_offset, trailer_magic = TRAILER_STRUCT.unpack_from(buf, len(buf) - TRAILER_STRUCT.size)
    if trailer_magic != INDEX_MAGIC:
        return errors + [f"bad trailer magic {trailer_magic!r}"]
    if index_offset + 8 * num_frames + TRAILER_STRUCT.size != len(buf):
        return errors + ["file size inconsistent with trailer"]
    offsets = np.frombuffer(buf, dtype="<u8", count=num_frames, offset=index_offset)

    lane_ids = {l["id"] for l in meta["network"]["lanes"]}
    phases_per_ix = {ix["id"]: len(ix["phases"]) for ix in meta["network"]["intersections"]}
    order = meta["intersections_order"]

    expected_off = HEADER_STRUCT.size + meta_len
    seen_ids: set[int] = set()
    live_prev: set[int] = set()
    for i in range(num_frames):
        off = int(offsets[i])
        if off != expected_off:
            if fail(f"frame {i}: index offset {off} != expected {expected_off}"):
                return errors
            break
        if off + 12 > index_offset:
            return errors + [f"frame {i}: overruns index region"]
        payload_len, tick, n = FRAME_HEAD_STRUCT.unpack_from(buf, off)
        if payload_len != frame_payload_len(n, k, a, m):
            return errors + [f"frame {i}: frame_len {payload_len} inconsistent with n_vehicles {n}"]
        if off + 4 + payload_len > index_offset:
            return errors + [f"frame {i}: payload overruns index region"]
        if tick != i:
            if fail(f"frame {i}: tick {tick}, expected {i}"):
                return errors
        if deep:
            p = off + 12
            veh = np.frombuffer(buf, dtype=VEHICLE_DTYPE, count=n, offset=p); p += 28 * n
            sig = np.frombuffer(buf, dtype=SIGNAL_DTYPE, count=k, offset=p); p += 6 * k + 2 * a
            rew = np.frombuffer(buf, dtype="<f4", count=k, offset=p); p += 4 * k
            met = np.frombuffer(buf, dtype="<f4", count=m, offset=p)
            for name, arr in (("x", veh["x"]), ("y", veh["y"]), ("heading", veh["heading"]),
                              ("speed", veh["speed"]), ("accel", veh["accel"])):
                if not np.all(np.isfinite(arr)):
                    if fail(f"frame {i}: non-finite vehicle {name}"):
                        return errors
            if n and veh["speed"].min() < 0:
                if fail(f"frame {i}: negative speed"):
                    return errors
            if n:
                bad_lanes = set(veh["lane"][veh["lane"] != LANE_NONE].tolist()) - lane_ids
                if bad_lanes and fail(f"frame {i}: unknown lane ids {sorted(bad_lanes)[:3]}"):
                    return errors
                ids = veh["id"]
                if len(set(ids.tolist())) != n and fail(f"frame {i}: duplicate vehicle ids"):
                    return errors
                live = set(ids.tolist())
                resurrected = (live - live_prev) & seen_ids
                if resurrected and fail(f"frame {i}: vehicle ids reused after despawn: {sorted(resurrected)[:3]}"):
                    return errors
                seen_ids |= live
                live_prev = live
            else:
                live_prev = set()
            for j, ix_id in enumerate(order):
                if sig["phase"][j] >= phases_per_ix[ix_id]:
                    if fail(f"frame {i}: intersection {ix_id} phase {sig['phase'][j]} out of range"):
                        return errors
                if sig["state"][j] > 2:
                    if fail(f"frame {i}: bad signal state {sig['state'][j]}"):
                        return errors
            if not np.all(np.isfinite(sig["time_in_phase"])):
                if fail(f"frame {i}: non-finite time_in_phase"):
                    return errors
            for name, arr in (("rewards", rew), ("metrics", met)):
                if not np.all(np.isfinite(arr)):
                    if fail(f"frame {i}: non-finite {name}"):
                        return errors
        expected_off = off + 4 + payload_len
    if num_frames and expected_off != index_offset:
        errors.append("frames do not end exactly at index_offset")
    if not num_frames and HEADER_STRUCT.size + meta_len != index_offset:
        errors.append("empty trajectory: index_offset != end of meta")
    return errors


def validate_file(path: str | Path, max_errors: int = 20, deep: bool = True) -> list[str]:
    return validate_bytes(Path(path).read_bytes(), max_errors=max_errors, deep=deep)
