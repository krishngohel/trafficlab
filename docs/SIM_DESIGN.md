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
    def sample(rng) -> "DriverParams"        # v0 ×U(0.9,1.15), T ~U(1.2,1.8), a ~U(1.2,1.8) etc.

def idm_accel(v, v_lead, gap, p: DriverParams | field-arrays) -> float | np.ndarray
    # s* = s0 + max(0, v·T + v·Δv / (2·√(a·b))); acc = a·(1 − (v/v0)^δ − (s*/gap)²)
    # gap = ∞ (use 1e9) when free. Clamp result to [-8.0, p.a]. gap ≤ 0.5 → return -8.0.

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
    time_in_phase: float  # since this phase's GREEN began (includes transition of predecessor? NO:
                          # resets to 0 when YELLOW starts for outgoing phase measurement; see below)
    def request_phase(self, p: int) -> None
    def step(self) -> None
    def can_switch(self) -> bool               # state==GREEN and time_in_green >= min_green
    def signal_for(self, conn_id: int) -> int  # GREEN/YELLOW/ALL_RED-as-red for a connection
    def action_mask(self, n_actions: int) -> np.ndarray[bool]  # all True if can_switch else only current

Semantics: `time_in_phase` = seconds since the current (phase, state) segment began is NOT
what .traj wants — .traj wants seconds since the current phase began counting from its
YELLOW start. Implement: attribute `traj_time_in_phase` = time since current `phase`
became active (green start), and during YELLOW/ALL_RED = time since transition start.
signal_for: conn in current phase and GREEN → GREEN; conn in current phase and YELLOW →
YELLOW; else ALL_RED.

class FixedCycleController:
    """M2 testing controller: cycles phases in order with given green seconds each."""
    def __init__(self, unit: SignalUnit, greens: list[float]): ...
    def step(self) -> None   # calls unit.request_phase when green time for current phase elapsed
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
Shipped: `configs/demand/{light,rush,heavy}.json` (rush = double-peak profile).

## simulator.py (integrator writes this; listed for context)

Vehicle: id, element ("lane"/"conn", element id), s, v, acc, params, route decision cache,
lane-change cooldown, entered_at tick, cumulative delay. Per tick: signals step → spawns →
per-element sorted vehicle lists → leader search (same element, then across next elements up
to 150 m lookahead; red/yellow signal for the chosen connection = virtual wall at stop line
unless already past the committed distance) → IDM accels → MOBIL lane changes (multi-lane
links only, not within R_box·2 of stop line for mandatory-correct lane logic; mandatory bias
grows as stop line nears) → integrate (v = max(0, v+a·dt), s += v·dt) → element transitions
→ despawn at boundary → queues/delay/throughput accounting → optional .traj frame append.
```
