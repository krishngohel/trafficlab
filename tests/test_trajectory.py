"""Tests for the .traj format: round-trip, determinism, validator, corruption."""
import io
import json
import struct

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from trafficlab.synthetic import synthetic_meta, write_synthetic
from trafficlab.trajectory import (
    FRAME_HEAD_STRUCT, HEADER_STRUCT, LANE_NONE, SIGNAL_DTYPE, TRAILER_STRUCT,
    VEHICLE_DTYPE, TrajectoryReader, TrajectoryWriter, validate_bytes,
    validate_file,
)


def make_frames(meta, num_frames, seed=0, max_vehicles=40):
    """Random but valid frame content for the synthetic single-intersection meta."""
    rng = np.random.default_rng(seed)
    lane_ids = [l["id"] for l in meta["network"]["lanes"]] + [LANE_NONE]
    k, a, m = 1, 4, 4
    frames = []
    n_prev = 0
    next_id = 0
    live: list[int] = []
    for _ in range(num_frames):
        # Spawn/despawn from the front only, so ids never resurrect.
        n = int(rng.integers(0, max_vehicles + 1))
        while len(live) < n:
            live.append(next_id)
            next_id += 1
        while len(live) > n:
            live.pop(0)
        veh = np.zeros(n, dtype=VEHICLE_DTYPE)
        veh["id"] = live
        veh["x"] = rng.uniform(-120, 120, n)
        veh["y"] = rng.uniform(-120, 120, n)
        veh["heading"] = rng.uniform(-np.pi, np.pi, n)
        veh["speed"] = rng.uniform(0, 15, n)
        veh["accel"] = rng.uniform(-3, 2, n)
        veh["lane"] = rng.choice(lane_ids, n)
        veh["flags"] = rng.integers(0, 16, n)
        sig = np.zeros(k, dtype=SIGNAL_DTYPE)
        sig["phase"] = rng.integers(0, 2, k)
        sig["state"] = rng.integers(0, 3, k)
        sig["time_in_phase"] = rng.uniform(0, 30, k)
        frames.append((
            veh, sig,
            rng.integers(0, 30, a).astype("<u2"),
            rng.normal(size=k).astype("<f4"),
            rng.uniform(0, 100, m).astype("<f4"),
        ))
    return frames


def write_to_bytes(meta, frames):
    bio = io.BytesIO()
    with TrajectoryWriter(bio, meta) as w:
        for f in frames:
            w.write_frame(*f)
    return bio.getvalue()


@pytest.fixture(scope="module")
def meta():
    return synthetic_meta()


def test_round_trip_exact(meta):
    frames = make_frames(meta, 25, seed=1)
    data = write_to_bytes(meta, frames)
    r = TrajectoryReader(data)
    assert r.num_frames == 25
    assert r.meta == json.loads(json.dumps(meta))
    for i, (veh, sig, q, rew, met) in enumerate(frames):
        fr = r.frame(i)
        assert fr.tick == i
        assert np.array_equal(fr.vehicles, veh.astype(VEHICLE_DTYPE))
        assert np.array_equal(fr.signals, sig)
        assert np.array_equal(fr.queues, q)
        assert np.array_equal(fr.rewards, rew)
        assert np.array_equal(fr.metrics, met)


def test_byte_determinism(meta):
    frames = make_frames(meta, 10, seed=7)
    assert write_to_bytes(meta, frames) == write_to_bytes(meta, frames)


def test_random_access_matches_iteration(meta):
    data = write_to_bytes(meta, make_frames(meta, 30, seed=3))
    r = TrajectoryReader(data)
    seq = list(r)
    for i in (0, 7, 29, 15):
        fr = r.frame(i)
        assert fr.tick == seq[i].tick
        assert np.array_equal(fr.vehicles, seq[i].vehicles)


def test_validator_accepts_good_file(meta, tmp_path):
    p = tmp_path / "good.traj"
    write_synthetic(p, num_frames=60)
    assert validate_file(p) == []


def test_empty_trajectory_valid(meta):
    data = write_to_bytes(meta, [])
    assert validate_bytes(data) == []
    assert TrajectoryReader(data).num_frames == 0


def test_validator_rejects_truncation(meta):
    data = write_to_bytes(meta, make_frames(meta, 5, seed=2))
    for cut in (1, 10, 100):
        assert validate_bytes(data[:-cut]) != []


def test_validator_rejects_bad_magic(meta):
    data = bytearray(write_to_bytes(meta, make_frames(meta, 3)))
    data[0:4] = b"XXXX"
    assert any("magic" in e for e in validate_bytes(bytes(data)))


def test_validator_rejects_corrupt_frame_len(meta):
    data = bytearray(write_to_bytes(meta, make_frames(meta, 3, seed=4)))
    off = HEADER_STRUCT.size + len(json.dumps(meta, separators=(",", ":")).encode())
    struct.pack_into("<I", data, off, 99999)
    assert validate_bytes(bytes(data)) != []


def test_validator_rejects_nan(meta):
    frames = make_frames(meta, 3, seed=5)
    if len(frames[1][0]) == 0:
        frames[1] = (np.zeros(1, dtype=VEHICLE_DTYPE), *frames[1][1:])
    frames[1][0]["x"][0] = np.nan
    data = write_to_bytes(meta, frames)
    assert any("non-finite" in e for e in validate_bytes(data))


def test_validator_rejects_unknown_lane(meta):
    frames = make_frames(meta, 2, seed=6)
    veh = np.zeros(1, dtype=VEHICLE_DTYPE)
    veh["lane"] = 999
    frames[0] = (veh, *frames[0][1:])
    data = write_to_bytes(meta, frames)
    assert any("lane" in e for e in validate_bytes(data))


def test_validator_rejects_id_resurrection(meta):
    f = make_frames(meta, 3, seed=8)
    mk = lambda ids: np.array([(i, 0, 0, 0, 0, 0, 0, 0, 0) for i in ids], dtype=VEHICLE_DTYPE)
    frames = [(mk([1, 2]), *f[0][1:]), (mk([2]), *f[1][1:]), (mk([1, 2]), *f[2][1:])]
    data = write_to_bytes(meta, frames)
    assert any("reused" in e for e in validate_bytes(data))


def test_validator_rejects_bad_phase_index(meta):
    frames = make_frames(meta, 2, seed=9)
    sig = np.zeros(1, dtype=SIGNAL_DTYPE)
    sig["phase"] = 5  # only 2 phases exist
    frames[0] = (frames[0][0], sig, *frames[0][2:])
    data = write_to_bytes(meta, frames)
    assert any("phase" in e for e in validate_bytes(data))


def test_writer_rejects_wrong_shapes(meta):
    bio = io.BytesIO()
    w = TrajectoryWriter(bio, meta)
    veh = np.zeros(0, dtype=VEHICLE_DTYPE)
    sig = np.zeros(1, dtype=SIGNAL_DTYPE)
    with pytest.raises(ValueError):
        w.write_frame(veh, sig, np.zeros(3, dtype="<u2"), np.zeros(1, "<f4"), np.zeros(4, "<f4"))
    with pytest.raises(ValueError):
        w.write_frame(veh, np.zeros(2, dtype=SIGNAL_DTYPE), np.zeros(4, dtype="<u2"),
                      np.zeros(1, "<f4"), np.zeros(4, "<f4"))


def test_writer_rejects_bad_meta():
    with pytest.raises(ValueError):
        TrajectoryWriter(io.BytesIO(), {"format_version": 1})


def test_frame_offsets_match_index(meta):
    data = write_to_bytes(meta, make_frames(meta, 8, seed=10))
    r = TrajectoryReader(data)
    off = HEADER_STRUCT.size + len(json.dumps(meta, separators=(",", ":")).encode())
    for i in range(8):
        assert int(r._offsets[i]) == off
        payload_len, tick, n = FRAME_HEAD_STRUCT.unpack_from(data, off)
        assert tick == i
        off += 4 + payload_len


@settings(max_examples=25, deadline=None)
@given(num_frames=st.integers(0, 12), seed=st.integers(0, 1000), max_v=st.integers(0, 25))
def test_property_round_trip(num_frames, seed, max_v):
    meta = synthetic_meta()
    frames = make_frames(meta, num_frames, seed=seed, max_vehicles=max_v)
    data = write_to_bytes(meta, frames)
    assert validate_bytes(data) == [], validate_bytes(data)
    r = TrajectoryReader(data)
    assert r.num_frames == num_frames
    for i in range(num_frames):
        assert np.array_equal(r.frame(i).vehicles, frames[i][0])


def test_synthetic_generator_writes_valid_file(tmp_path):
    p = tmp_path / "syn.traj"
    meta = write_synthetic(p, num_frames=120, seed=42)
    errors = validate_file(p)
    assert errors == [], errors
    r = TrajectoryReader(p)
    assert r.num_frames == 120
    assert r.meta["network_name"] == "synthetic_single"
    assert len(r.frame(0).vehicles) == 24
