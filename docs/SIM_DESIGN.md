# Simulator design — module interfaces (M2)

Binding contract for `network.py`, `idm.py`, `signals.py`, `demand.py`, `simulator.py`.
Implementers: do not change signatures; add private helpers freely. Units: m, s, rad.
Right-hand traffic. Determinism: the only RNG anywhere is a `numpy.random.Generator`
passed in explicitly; iteration orders must be sorted-by-id, never dict/set order.

## network.py

```python
@dataclass(frozen=True)
class Node:      id: int; x: float; y: float; type: str            # "intersection" | "boundary"

@dataclass
class Lane:
    id: int; link: int; index: int                                  # index 0 = leftmost in travel direction
    width: float; speed_limit: float
    polyline: np.ndarray                                            # (N,2) float64, travel direction
    # computed in __post_init__: self.length; cumulative arclengths
    def pose_at(self, s: float) -> tuple[float, float, float]       # x, y, heading; s clamped to [0, length]

@dataclass
class Link:      id: int; from_node: int; to_node: int; lanes: list[int]   # left→right order

@dataclass
class Connection:
    id: int; from_lane: int; to_lane: int
    movement: str                                                   # "through" | "left" | "right"
    intersection: int
    polyline: np.ndarray                                            # (N,2); computed length + pose_at() like Lane

@dataclass
class Phase:     name: str; connections: tuple[int, ...]

@dataclass
class Intersection:
    id: int; node: int; phases: list[Phase]
    yellow: float; all_red: float; min_green: float

class Network:
    nodes: dict[int, Node]; links: dict[int, Link]; lanes: dict[int, Lane]
    connections: dict[int, Connection]; intersections: dict[int, Intersection]
    lane_connections: dict[int, list[int]]      # from_lane id -> sorted connection ids leaving it
    entry_lanes: list[int]                      # lanes whose link.from_node is a boundary node, sorted
    def incoming_links(self, ix: int) -> list[int]                  # sorted by compass angle: N, E, S, W first
    def approaches(self) -> list[dict]          # [{"intersection", "link", "label"}] label in "N/E/S/W/NE..."
    def to_meta_network(self) -> dict           # exactly the TRAJECTORY_FORMAT.md meta["network"] shape
    @classmethod
    def from_config(cls, cfg: dict) -> "Network"
```

`from_config` accepts `{"type": "grid"|"arterial"|"explicit", ...}`:

- grid: `{"type":"grid","rows":R,"cols":C,"block":200.0,"arm":150.0,"lanes":2,"speed_limit":13.9}`
  R×C intersections on a lattice, boundary stubs on the perimeter (arm length `arm`),
  interior spacing `block`. Two-way roads, `lanes` lanes per direction.
- arterial: `{"type":"arterial","n":6,"spacing":180.0,"arm":150.0,"lanes":2,"cross_lanes":1,"speed_limit":13.9}`
  n signalized 4-ways in a west→east row; each has a two-way cross street to boundary stubs.
- explicit: `{"type":"explicit","nodes":[{"id","x","y","type"}],"edges":[{"from","to","lanes":2,"two_way":true,"speed_limit":13.9}]}`

All three accept optional top-level `"yellow"`, `"all_red"`, `"min_green"` overrides
(defaults 3.0 / 2.0 / 6.0 s), applied to every intersection in the network.

Geometry rules:
- Intersection box radius `R_box = 6.0 + 3.5 * max lanes over its links`. Lane polylines are cut
  back so they start/end at the box edge (stop line = lane end).
- A direction's lanes are offset RIGHT of the road centerline: lane center offset
  `(i + 0.5) * width` for index i, perpendicular-right of travel.
- Connections: through = straight segment; turns = quadratic Bezier sampled at 12 points.
  Turn control point = intersection of the from-lane's exit tangent line and the to-lane's
  entry tangent line (last/first polyline segments extended); if the tangents are
  near-parallel (|cross product of unit tangents| < 0.15) fall back to the chord midpoint.
  This keeps connection headings continuous with their lanes at both endpoints (no
  entry/exit heading kinks, no leftward bulge on right turns).
- Build validation: an edge whose node span is <= the sum of its endpoint intersection
  box radii raises ValueError (lanes would build reversed), as do coincident nodes.
  After phases are built, every same-phase pair of connections with different from_lanes
  is checked geometrically (polylines resampled at 24 points): if they cross anywhere
  except within 4 m of either polyline's final point (merges into a shared to_lane are
  legal), the build raises ValueError naming the intersection, phase, and connections.
- Movement→lane rule (per incoming link with L lanes): left turns from lane 0 only;
  right turns from lane L-1 only; through from every lane EXCEPT lane 0 when L ≥ 2
  (dedicated left) — through from lane 0 too when L == 1.
- Phases per 4-way intersection (skip any phase with no connections; also merge: if an
  axis has no left connections, don't emit its left phase):
  0 "NS" (N+S through+right), 1 "NS-L" (N+S lefts), 2 "EW", 3 "EW-L".
  SPLIT PHASING exception: if any approach on an axis has a single lane AND a left
  turn, protected-left axis phasing would head-of-line-block that lane (the lead
  left-turner stalls the through queue during the axis phase), so that axis instead
  gets one all-movements phase per approach, named by compass label ("N", "S" / "E",
  "W"), emitted in sorted label order. Same-approach movements share a from_lane, so
  split phases are conflict-free by construction.
  Defaults: yellow 3.0, all_red 2.0, min_green 6.0.
- Node ids: as given (explicit) or row-major grid then boundary stubs. Link/lane/connection
  ids: dense ints assigned in a deterministic documented order.

Configs shipped: `configs/networks/{single,grid2x2,grid4x4,arterial6}.json` (single = 1×1 grid).

## idm.py (pure functions, vectorizable)

```python
@dataclass
class DriverParams:
    v0: float = 13.9; T: float = 1.5; a: float = 1.5; b: float = 2.0
    s0: float = 2.0; delta: float = 4.0; length: float = 4.5
    politeness: float = 0.3; lc_threshold: float = 0.2; lc_cooldown: float = 4.0
    @staticmethod
    def sample(rng) -> "DriverParams"
        # Draw order = field order: v0 = 13.9·U(0.9,1.15), T ~U(1.2,1.8), a ~U(1.2,1.8),
        # b ~U(1.5,2.5), s0 ~U(1.5,2.5), length ~U(4.0,5.0), politeness ~U(0.1,0.5).
        # delta, lc_threshold, lc_cooldown stay at their defaults.

def idm_accel(v, v_lead, gap, p: DriverParams | field-arrays,
              v0: float | np.ndarray | None = None) -> float | np.ndarray
    # s* = s0 + max(0, v·T + v·Δv / (2·√(a·b))); acc = a·(1 − (v/v0)^δ − (s*/gap)²)
    # gap = ∞ (use 1e9) when free. Clamp result to [-8.0, p.a]. gap ≤ 0.5 → return -8.0.
    # `v0` OVERRIDES p.v0 for this call. The simulator always passes it: the effective
    # desired speed is min(driver v0, element speed limit), so element limits (and the
    # extra caps on turning connections) are enforced without mutating DriverParams.
    # All-scalar inputs take a pure-math fast path (~10x faster than numpy); any array
    # input (including an array v0, or a DriverParams whose fields are arrays)
    # broadcasts to an ndarray.

def mobil_ok(a_self_new, a_self_old, a_newfollower_new, a_newfollower_old,
             a_oldfollower_new, a_oldfollower_old, politeness, threshold,
             bias: float = 0.0, b_safe: float = 4.0) -> bool
    # Safety: a_newfollower_new ≥ −b_safe. Incentive:
    # (a_self_new − a_self_old) + politeness·(Δnewfollower + Δoldfollower) > threshold − bias
```

## signals.py

```python
GREEN, YELLOW, ALL_RED = 0, 1, 2

class SignalUnit:
    """Phase state machine for one intersection. GREEN → (request) → YELLOW(yellow s)
    → ALL_RED(all_red s) → GREEN(new phase). Requests during a transition are ignored;
    requests before min_green has elapsed are queued and honored when it elapses.
    Re-requesting the CURRENT phase while GREEN cancels any queued pending switch —
    the latest request always wins, so a stale queued request can never fire after a
    later "stay" decision (preserves RL action → transition correspondence)."""
    def __init__(self, ix: Intersection, dt: float, initial_phase: int = 0): ...
    phase: int          # current (outgoing during transition), the value written to .traj
    state: int          # GREEN/YELLOW/ALL_RED
    time_in_phase: float       # seconds in the current (phase, state) segment
    traj_time_in_phase: float  # the .traj value (see Semantics below)
    def request_phase(self, p: int) -> None
    def step(self) -> None
    def can_switch(self) -> bool               # state==GREEN and time_in_green >= min_green
    def signal_for(self, conn_id: int) -> int  # GREEN/YELLOW/ALL_RED-as-red for a connection
    def action_mask(self, n_actions: int) -> np.ndarray[bool]  # all True if can_switch else only current

Semantics: `time_in_phase` = seconds since the current (phase, state) segment began is NOT
what .traj wants — .traj wants seconds since the current phase began counting from its
YELLOW start. Hence the separate `traj_time_in_phase` = time since current `phase`
became active (green start), and during YELLOW/ALL_RED = time since the transition
(yellow) began; the all-red segment keeps that clock running. All timing is integer-tick
based (`ceil(seconds / dt)`), so repeated stepping never drifts. Out-of-range
`initial_phase` / `request_phase(p)` raise ValueError.
signal_for: conn in current phase and GREEN → GREEN; conn in current phase and YELLOW →
YELLOW; else ALL_RED.

class FixedCycleController:
    """M2 testing controller: cycles phases in order, holding phase p green for
    greens[p] seconds (min_green still applies, so shorter greens are extended).
    len(greens) must equal the intersection's phase count or __init__ raises."""
    def __init__(self, unit: SignalUnit, greens: list[float]): ...
    def step(self) -> None   # call once per tick BEFORE unit.step(): the request is placed
                             # one tick early so the switch lands exactly on the green time
```

## demand.py

```python
class Demand:
    def __init__(self, cfg: dict, network: Network, rng: np.random.Generator): ...
    def arrivals(self, t: float, dt: float) -> list[int]   # entry lane ids to spawn this tick
    def turn_for(self, ix: int, from_link: int) -> str     # sample "left"|"through"|"right"
```

cfg = `{"base_rate": 500, "profile": [[t0,mult0],[t1,mult1],...], "turning": {"left":0.2,"through":0.65,"right":0.15}, "per_entry": {"<link_id>": rate_override}}`
- base_rate: veh/h per entry LINK (split evenly across its lanes; spawn lane chosen via rng).
- profile: piecewise-linear multiplier over sim time, clamped at ends; missing → 1.0.
- arrivals: per entry link, Poisson(rate·mult·dt/3600); iterate links sorted by id.
- turn_for: renormalize over movements actually available at that (ix, link); rng-sample.
  Missing or zero-mass `turning` weights fall back to uniform over the available
  movements; a (ix, link) pair with no movements at all raises ValueError.
- Validation at construction: non-finite or negative `base_rate`, `per_entry` rate, or
  `profile` multiplier raises ValueError. Profile points are sorted by time.
Shipped: `configs/demand/{light,rush,heavy}.json` — light 300 veh/h flat, rush 500 with a
double-peak profile, heavy 800 at a flat 1.2× multiplier.

## simulator.py

Vehicle state: id, element (`kind` ∈ lane/conn + element id), s, v, acc, params, route
decision cache (`movement`, `next_conn`, `needs_lane`), lane-change cooldown, entered
tick, cumulative delay, cumulative queued wait, and a `committed` flag (see yellow
handling below). Geometry (x, y, heading) is computed **only** when a .traj frame is
being recorded — headless training never pays for it.

Per tick, in this order: signal units step → spawns → rebuild per-element vehicle lists
sorted by (s, id) → IDM accels → MOBIL lane changes → integrate → accounting → optional
.traj frame append.

Key behaviours (constants in the module):

- **Spawning.** Arrivals that cannot fit are queued per entry lane and retried on later
  ticks (never dropped). A vehicle enters at `min(driver v0, lane speed_limit)`, further
  capped to `sqrt(2·b·(gap − s0))` against the rear-most vehicle already on the lane, and
  is rejected outright if that gap is under `s0 + 2 m`.
- **Leader search.** Same element first, then forward across connections/lanes up to
  `LOOKAHEAD = 150 m`. A red (or non-committed yellow) signal for the vehicle's chosen
  connection becomes a virtual wall `STOP_MARGIN = 1 m` short of the stop line; a queue
  spilling back out of the intersection overrides that wall when the connection occupant's
  rear is closer. A vehicle with no legal movement from its lane also gets the wall.
- **Committed yellow, persisted.** On yellow a vehicle commits (proceeds) when stopping
  would need harder braking than 3 m/s² (`d_stop < v²/6 + v·dt`). **The commitment
  survives into the clearance all-red** — it lapses only once an opposing phase actually
  turns green — so committed vehicles are never frozen mid-intersection.
- **Element speed limits.** Desired speed is `min(driver v0, element limit)` passed as
  `idm_accel(..., v0=...)`; connections use the min of their endpoint lane limits, further
  capped at 9 m/s for left turns and 7 m/s for right turns.
- **Lane changes** (multi-lane links only). Mandatory (wrong lane for the intended
  movement): every eligible tick, one lane step toward the target lane, MOBIL bias
  `0.5 + 2.0·max(0, 1 − d_stop/150)` growing as the stop line nears; if the vehicle is
  still in the wrong lane within `GIVE_UP_DIST = 15 m` it falls back to a movement its
  current lane serves (this runs regardless of cooldown, so nobody parks at the line).
  Discretionary: only when `d_stop ≥ 70 m`, and **on a 4-tick cadence** —
  `(tick + veh.id) % 4 == 0`, i.e. each vehicle re-evaluates every 2 s at dt = 0.5 s,
  which is what keeps MOBIL affordable; inside 100 m of the line a discretionary change
  is only allowed into a lane that still serves the vehicle's intended movement.
  No lane changes within `LC_FORBID_NEAR = 12 m`
  of the stop line, while the cooldown is live, or before the vehicle's rear has cleared
  the lane start. Safety also projects vehicles on feeding connections as followers
  (shifted to negative s) so a merger cannot appear out of an intersection blind spot.
- **Integration.** Semi-implicit Euler: `v = max(0, v + a·dt)`, `s += v·dt`.
- **Transitions with an insertion speed cap.** Insertion into the next element is strictly
  no-overlap: the entrant is clamped to `rear.s − rear.length − s0/2`, and because that
  clamp teleports it backwards its speed is **also** capped to
  `min(v, rear.v + max(0, gap − 0.5)/dt)` so the next tick cannot carry it through the
  vehicle ahead. If even the clamped position is negative the vehicle holds at the end of
  its current element with v = 0. A vehicle at the stop line with no connection likewise
  holds at v = 0; boundary-bound vehicles despawn.
- **Accounting.** Per tick, `delay += dt·max(0, 1 − v/v0)` per vehicle (and into
  `cum_delay`); a vehicle counts as queued when `v < QUEUE_SPEED = 0.3 m/s` on an approach
  lane within `QUEUE_DIST = 100 m` of the stop line.
- **Phase counts vary per intersection.** Split phasing (see the network.py section) can
  replace an axis's two phases with one per approach, so `len(ix.phases)` is not always 4;
  everything downstream (action masks, .traj signal records, per-intersection arrays) must
  read the per-intersection phase list rather than assume a fixed count.

Observation/reward helpers used by `env.py` and the baselines: `queues_by_approach()`,
`density_by_approach()` (veh/km), `vehicles_near_stop(lane, dist)`,
`movement_pressure(conn)` (wrong-lane vehicles count toward their intended movement,
split evenly across the connections serving it), `phase_pressures(ix)`,
`intersection_pressure(ix)` (downstream counted once per unique exit lane), and
`default_rewards()` = `-intersection_pressure` per intersection in sorted id order.
Recording: `attach_writer(path, policy)` / `set_frame_rewards(arr)` / `close()`.
`check_no_overlap()` is the property-test hook (includes cross-element boundary pairs).
