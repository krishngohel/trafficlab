# .traj Trajectory File Format — v1

The contract between the Python simulator (producer) and the WebGL visualizer (consumer).
Binary, little-endian, packed (no alignment padding). One file = one fully self-contained
replay: network geometry, per-tick vehicle states, signal states, queues, rewards, metrics.

Reference implementations — a change to this format requires a version bump here **and** in
both of these:

| role | path |
|---|---|
| Python writer / reader / validator | `src/trafficlab/trajectory.py` |
| TypeScript parser (lazy frames + `scanMeta`) | `viz/src/lib/traj.ts` |

Everything else is downstream of those two: `src/trafficlab/simulator.py` (the producer, via
`attach_writer`), `src/trafficlab/network.py::Network.to_meta_network()` (emits exactly the
`meta["network"]` shape below), `src/trafficlab/synthetic.py` (hand-built format-valid
fixtures, no simulator needed), the conformance tests `tests/test_trajectory.py` and
`viz/src/lib/{traj,scan}.test.ts`, and the checked-in replays in `viz/public/fixtures/`
(regenerate those when the version bumps).

## File layout

```
[ header (12 B) ][ meta JSON ][ frame 0 ] ... [ frame N-1 ][ index (8N B) ][ trailer (16 B) ]
```

Readers parse the header and meta from the front, then jump to `EOF-16` for the trailer,
which locates the frame index. The index enables O(1) random access for timeline scrubbing.

## Header (12 bytes)

| offset | type | value |
|--------|------|-------|
| 0 | `char[4]` | magic `"TLTJ"` |
| 4 | `u16` | format version, `1` |
| 6 | `u16` | flags, reserved, `0` |
| 8 | `u32` | `meta_len` — byte length of the meta JSON block |

## Meta JSON (`meta_len` bytes, UTF-8)

Required keys:

- `format_version` (int): `1`.
- `dt` (float): seconds of sim time per tick.
- `seed` (int | null), `policy` (string), `network_name` (string): provenance labels.
- `network` (object): full renderable geometry —
  - `nodes`: `[{id, x, y, type: "intersection"|"boundary"|"parking"|"junction"}]` — `"parking"` is an off-street garage/lot where trips begin and end, `"junction"` an uncontrolled driveway junction on a street (neither is signalised; see `docs/PARKING_DESIGN.md`). Readers must treat unknown type strings as inert.
  - `links`: `[{id, from_node, to_node, lanes: [lane_id, ...]}]` — lanes listed left-to-right in travel direction.
  - `lanes`: `[{id, link, index, width, speed_limit, polyline: [[x,y], ...]}]` — polyline runs in travel direction; positions along a lane are arc-length along this polyline.
  - `connections`: `[{id, from_lane, to_lane, movement: "through"|"left"|"right", intersection}]`
  - `intersections`: `[{id, node, yellow, all_red, min_green, phases: [{name, connections: [conn_id, ...]}]}]`
  - `junction_connections` (optional): `[{id, from_lane, to_lane, movement, junction}]` — movements at uncontrolled junctions. They have no owning intersection, so they are listed here rather than in `connections`; ids continue past the signalised ones. Absent when the network has no driveways.
  - `driveways` (optional): `[{junction, parking, in_lane, out_lane, conflict_lane}]`. Absent when the network has no driveways.
- `intersections_order`: `[intersection_id, ...]` — defines **K** and the array order of all per-intersection data in frames (signals, rewards).
- `approaches`: `[{intersection, link, label}]` — defines **A** and the order of the per-frame queue array. One entry per incoming link per intersection.
- `metrics`: `[name, ...]` — defines **M** and the order of the per-frame global metrics array. Producers should emit at least `["active_vehicles", "cumulative_delay", "throughput", "mean_speed"]`.

Unknown extra keys are allowed and must be preserved by tooling. The authoritative frame
count is the **trailer**, not meta.

Units: meters, seconds, radians. X east, Y north, heading CCW from +X.

## Frame

```
u32 frame_len          # byte length of the payload that follows (excludes this field)
u32 tick               # 0-based, strictly increases by exactly 1 per frame
u32 n_vehicles
VehicleRecord × n_vehicles   (28 B each)
SignalRecord  × K            (6 B each)
u16 queue     × A            (vehicles queued per approach)
f32 reward    × K            (per-intersection instantaneous reward; 0 if N/A)
f32 metric    × M            (global metrics, order per meta)
```

`frame_len = 8 + 28·n_vehicles + 6K + 2A + 4K + 4M`. Frames are contiguous: frame 0 starts
at byte `12 + meta_len`; each subsequent frame starts where the previous ended; the index
begins where the last frame ends.

### VehicleRecord (28 bytes, packed)

| offset | type | field | notes |
|--------|------|-------|-------|
| 0 | `u32` | id | stable for the vehicle's lifetime, never reused within a file |
| 4 | `f32` | x | m |
| 8 | `f32` | y | m |
| 12 | `f32` | heading | rad, CCW from +X |
| 16 | `f32` | speed | m/s, ≥ 0 |
| 20 | `f32` | accel | m/s² |
| 24 | `u16` | lane | lane id; `0xFFFF` = inside intersection (on a connection) |
| 26 | `u8` | flags | bit0 braking, bit1 left blinker, bit2 right blinker, bit3 queued |
| 27 | `u8` | vclass | 0 = car (reserved for future classes) |

numpy dtype: `[('id','<u4'),('x','<f4'),('y','<f4'),('heading','<f4'),('speed','<f4'),('accel','<f4'),('lane','<u2'),('flags','u1'),('vclass','u1')]`

### SignalRecord (6 bytes, packed)

| offset | type | field | notes |
|--------|------|-------|-------|
| 0 | `u8` | phase | index into that intersection's `phases` list |
| 1 | `u8` | state | 0 = green, 1 = yellow, 2 = all-red |
| 2 | `f32` | time_in_phase | s since the current phase (incl. transition) began |

During yellow/all-red, `phase` is the **outgoing** phase until green begins on the new one.

## Index and trailer

- Index: `u64 × num_frames` — absolute file offset of each frame's `frame_len` field.
- Trailer (last 16 bytes): `u32 num_frames`, `u64 index_offset` (absolute offset of the index), `char[4]` magic `"TLIX"`.

File size must equal `index_offset + 8·num_frames + 16`.

## Validity rules

Enforced by `trajectory.validate_bytes(buf, max_errors=20, deep=True)` and
`trajectory.validate_file(path, ...)`, which return a list of error strings (empty = valid);
`deep=False` skips the per-frame scan.

1. Header magic/version correct; meta parses as JSON with all required keys; all id
   references resolve (lanes→links, connections→lanes, phases→connections,
   approaches→intersections+links, orders→intersections).
2. Trailer magic correct; index offsets strictly increasing, matching actual contiguous
   frame positions; declared `frame_len` values consistent with record counts (the
   28-byte divisibility must be exact).
3. Ticks start at 0 and increase by exactly 1.
4. Every float finite. Speeds ≥ 0. Vehicle `lane` ids exist in the network or are `0xFFFF`.
   Signal `phase` < number of phases for that intersection; `state` ∈ {0, 1, 2}.
5. A vehicle id, once it disappears from a frame, never reappears in a later frame.

## TypeScript parsing notes

Read the whole file into an `ArrayBuffer`. Parse trailer with a `DataView` at
`byteLength-16`. Vehicle blocks are at unaligned offsets — copy each frame's vehicle block
into fresh aligned buffers (`Float32Array`/`Uint32Array` of length `7·n`, reinterpreted
per-field by stride) or read via `DataView`. Decode frames lazily and LRU-cache; do not
eagerly decode all frames of large files. The reference parser
(`parseTraj(buffer, { cacheSize })`) defaults to a 120-frame LRU, and its `scanMeta()`
pass decodes only tick + signals + queues + rewards + metrics for every frame (seeking
past the vehicle blocks) to build the timeline series.
