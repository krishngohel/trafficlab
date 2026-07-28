# Off-street trip ends — parking, driveways, uncontrolled junctions

Binding contract for the parking feature. Today every vehicle is born at a
boundary stub doing 12 m/s and dies at another one, so in the renderer cars
appear and vanish in mid-air at the edge of the map. Real urban traffic mostly
*starts parked and ends parked*: a car pulls out of a garage or lot, drives,
and pulls into another one.

This adds that, at the simulation level, because the visualizer can only draw
what the trajectory carries — a vehicle whose first recorded frame is already at
road speed can never be made to look like it left a building.

**Opt-in.** Everything here activates only when a network config asks for it.
`single`, `grid2x2`, `grid4x4` and `arterial6` must build byte-identically to
today, so every committed evaluation result stays valid. Only `city.json` (and
the new test configs) turn parking on.

## 1. Network model

Two new node types join `"intersection"` and `"boundary"`:

| type | meaning | signalised | in `Network.intersections` |
|---|---|---|---|
| `"parking"` | a garage / lot: where trips begin and end | no | no |
| `"junction"` | uncontrolled driveway/street junction | no | no |

`Network` gains:

```python
parking_nodes: list[int]                 # sorted node ids, type == "parking"
driveways: dict[int, Driveway]           # keyed by junction node id

@dataclass(frozen=True)
class Driveway:
    junction: int          # the uncontrolled node on the street
    parking: int           # the parking node it serves
    in_lane: int           # street lane -> parking (entering)
    out_lane: int          # parking -> street lane (exiting)
    conflict_lane: int     # street lane an exiting vehicle must yield to
```

`entry_lanes` continues to mean "lanes traffic may be injected on" and now
additionally includes the lane leaving each parking node.

`Intersection`/`Phase`/`SignalUnit` are untouched: junction nodes get
connections but **no phases and no signal unit**, so nothing in `signals.py`,
`baselines.py`, `env.py` or `rl/` changes. Agent counts stay per signalised
intersection.

### Geometry

Driveways are **right-in / right-out only** — the standard treatment for
off-street access on a two-way street, and it means an exiting vehicle crosses
no opposing stream. A driveway is a 1-lane link of length `driveway_length`
(default 14 m), perpendicular to the street, at `speed_limit` 5.6 m/s, running
between the parking node and the junction node.

Street links are **split** at each driveway: a link A→B with driveways at
arc-length fractions f₁ < f₂ becomes A→J₁→J₂→B. Splitting happens before lane
geometry is generated, so all downstream geometry, ids and the phase-conflict
check operate on the split network with no special cases.

At a junction node the connections are:
- through: each street lane → its counterpart on the next segment (both directions);
- `out_lane` → the rightmost lane of the outbound street segment (right turn);
- rightmost lane of the inbound street segment → `in_lane` (right turn).

`movement` for the two driveway connections is `"right"`. No left turns and no
U-turns are generated at a junction.

### Config

```jsonc
{ "type": "explicit", "nodes": [...], "edges": [...],
  "parking": {                  // optional; absent => today's behaviour exactly
    "spacing": 110.0,           // metres of frontage per driveway
    "driveway_length": 14.0,
    "speed_limit": 5.6,
    "min_segment": 45.0,        // never split a segment shorter than this
    "streets_only": true        // skip avenues (>=3 lanes) — realistic, and keeps
  }                             // the busiest roads free of driveway friction
}
```

`scripts/make_city.py` gains `--parking/--no-parking` (default on) and emits the
block.

## 2. Simulator

### Departing a parking node

A vehicle spawned at a parking node starts **at rest** (`v = 0`) at the back of
the driveway rather than at road speed. It drives to the driveway's stop line
and then must accept a gap before entering the street.

Gap acceptance on `conflict_lane`, evaluated at the stop line:

- Let `lead` be the nearest vehicle downstream of the junction on the target
  lane and `lag` the nearest upstream one.
- Accept when `lag` is either absent or its time-to-junction
  `(distance − s0) / max(v, 1)` exceeds `CRITICAL_GAP` (default **5.5 s**), and
  the downstream space is at least `s0 + length`.
- While waiting the vehicle holds at the stop line at `v = 0` (the existing
  virtual-wall mechanism in `_signal_gap` is the right hook).

A vehicle that has waited longer than `MAX_WAIT` (default 60 s) relaxes its
critical gap linearly toward 3.0 s, so a driveway on a saturated street cannot
deadlock forever.

### Arriving at a parking node

Vehicles are not routed origin-to-destination (the sim samples turning
movements locally, and that stays true). Instead each vehicle carries a
**parking intent**:

- On spawn, draw `park_after` — a distance in metres, `Exp(mean=trip_length)`
  with `trip_length` from the demand config (default 1200 m).
- Once cumulative distance travelled exceeds `park_after`, the vehicle takes
  the **next driveway it passes on its right**, choosing that movement at the
  junction the way `turn_for` chooses one at an intersection.
- Entering the driveway it decelerates to rest inside the parking node, holds
  for `PARK_DWELL` (default 2 s of sim time so it is visibly parked, not
  teleported away), then is removed and counted.

Vehicles injected at a **boundary** keep today's behaviour unless the demand
config gives them a parking intent — see below — so through traffic still
crosses the map.

### Counters

`Simulator` gains `self.parked` (arrived at a parking node) alongside
`self.departed` (left via a boundary). `spawned == departed + parked +
len(vehicles)` is the new conservation invariant and must be asserted in the
property tests.

## 3. Demand

`demand.py` config gains an optional block:

```jsonc
"parking": {
  "share_from": 0.5,     // fraction of arrivals injected at parking nodes
  "share_to": 0.5,       // fraction of vehicles given a parking intent
  "trip_length": 1200.0  // mean metres before a vehicle looks to park
}
```

Absent ⇒ no parking trips, exactly today's behaviour. Arrival draws stay
Poisson and the per-tick iteration order stays sorted-by-id so determinism is
preserved. Parking nodes are drawn from a sorted list with the same `rng`.

## 4. Trajectory format

Purely additive and **no version bump**: `meta.network.nodes[].type` may now
also be `"parking"` or `"junction"`, and driveway links/lanes appear in the
existing `links`/`lanes` arrays like any other. `validate_bytes` never
constrained the node-type string, so old readers keep working. Update the type
list in `docs/TRAJECTORY_FORMAT.md`. The visualizer places garages at parking
nodes in a later pass.

## 5. Tests (all required)

- Existing four shipped configs build byte-identically to before the change
  (compare `to_meta_network()` JSON against a golden captured pre-change).
- Splitting: a link with 2 driveways yields 3 segments whose lengths sum to the
  original within 1e-6, and lane count/width/speed limit are preserved.
- Right-in/right-out: a junction emits exactly one connection into the driveway
  and one out of it, both `movement == "right"`, both on the rightmost lane, and
  no left/U-turn connections exist at junction nodes.
- Junction nodes never appear in `Network.intersections` and never get a
  `SignalUnit`; the agent count of a parking-enabled env equals the signalised
  count.
- Gap acceptance: with a saturated conflict lane an exiting vehicle waits; with
  an empty street it enters within a few ticks; it never enters within
  `CRITICAL_GAP` of an oncoming vehicle (assert minimum realised headway).
- Anti-deadlock: on a heavily loaded city run every parking node with demand
  discharges at least one vehicle within 120 s.
- Trips complete: on a parking-enabled city run, `parked > 0`, and
  `spawned == departed + parked + active` every tick.
- No vehicle overlaps anywhere including driveways and junctions
  (`check_no_overlap` must cover the new elements).
- Determinism: two identical seeded parking-enabled runs are byte-identical.
