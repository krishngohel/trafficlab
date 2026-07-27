"""Road network model built from declarative JSON configs.

See docs/SIM_DESIGN.md for the binding interface contract. Deterministic id
assignment order:

- nodes: config order (explicit); grid = row-major intersections then boundary
  stubs (per intersection row-major, directions N, E, S, W); arterial =
  intersections west->east then stubs (per intersection, N, E, S, W).
- links: edge config order, forward (from->to) then reverse for two-way.
- lanes: per link in link-id order, index 0 (leftmost) first.
- intersections: dense 0..K-1 over intersection nodes in ascending node id.
- connections: per intersection ascending id; per incoming link in compass
  order (N, E, S, W first); per outgoing link ascending id; from-lane index
  ascending. Through goes from lane i to lane min(i, L_out-1); left targets
  lane 0; right targets lane L_out-1.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

LANE_WIDTH = 3.5
DEFAULT_SPEED = 13.9
DEFAULT_YELLOW, DEFAULT_ALL_RED, DEFAULT_MIN_GREEN = 3.0, 2.0, 6.0
BOX_BASE, BOX_PER_LANE = 6.0, 3.5
BEZIER_SAMPLES = 12
TANGENT_PARALLEL_EPS = 0.15     # |cross of unit tangents| below this: chord-midpoint fallback
CONFLICT_SAMPLES = 24           # polyline resampling for phase-conflict checking
MERGE_EXCLUSION = 4.0           # m around polyline end points where crossings are legal merges
COMPASS_LABELS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
PHASE_ORDER = ("NS", "NS-L", "EW", "EW-L")


def _arclengths(polyline: np.ndarray) -> np.ndarray:
    seg = np.diff(polyline, axis=0)
    return np.concatenate(([0.0], np.cumsum(np.hypot(seg[:, 0], seg[:, 1]))))


def _pose_at(polyline: np.ndarray, cum: np.ndarray, s: float) -> tuple[float, float, float]:
    s = min(max(float(s), 0.0), float(cum[-1]))
    i = min(max(int(np.searchsorted(cum, s, side="right")) - 1, 0), len(polyline) - 2)
    d = polyline[i + 1] - polyline[i]
    seg = float(cum[i + 1] - cum[i])
    t = (s - float(cum[i])) / seg if seg > 0.0 else 0.0
    p = polyline[i] + t * d
    return float(p[0]), float(p[1]), math.atan2(float(d[1]), float(d[0]))


@dataclass(frozen=True)
class Node:
    id: int
    x: float
    y: float
    type: str  # "intersection" | "boundary"


@dataclass
class Lane:
    id: int
    link: int
    index: int              # 0 = leftmost in travel direction
    width: float
    speed_limit: float
    polyline: np.ndarray    # (N,2) float64, travel direction

    def __post_init__(self) -> None:
        self.polyline = np.asarray(self.polyline, dtype=np.float64)
        self.arclengths = _arclengths(self.polyline)
        self.length = float(self.arclengths[-1])

    def pose_at(self, s: float) -> tuple[float, float, float]:
        """(x, y, heading) at arc length s, clamped to [0, length]."""
        return _pose_at(self.polyline, self.arclengths, s)


@dataclass
class Link:
    id: int
    from_node: int
    to_node: int
    lanes: list[int]        # left -> right in travel direction


@dataclass
class Connection:
    id: int
    from_lane: int
    to_lane: int
    movement: str           # "through" | "left" | "right"
    intersection: int
    polyline: np.ndarray    # (N,2) float64

    def __post_init__(self) -> None:
        self.polyline = np.asarray(self.polyline, dtype=np.float64)
        self.arclengths = _arclengths(self.polyline)
        self.length = float(self.arclengths[-1])

    def pose_at(self, s: float) -> tuple[float, float, float]:
        """(x, y, heading) at arc length s, clamped to [0, length]."""
        return _pose_at(self.polyline, self.arclengths, s)


@dataclass
class Phase:
    name: str
    connections: tuple[int, ...]


@dataclass
class Intersection:
    id: int
    node: int
    phases: list[Phase]
    yellow: float
    all_red: float
    min_green: float


def _turn_control_point(from_poly: np.ndarray, to_poly: np.ndarray) -> np.ndarray:
    """Bezier control point for a turn connection: the intersection of the
    from-lane's exit tangent line and the to-lane's entry tangent line (the
    last/first polyline segments extended). Keeps the connection heading
    continuous with both lanes at the endpoints. Near-parallel tangents
    (|cross of unit tangents| < TANGENT_PARALLEL_EPS) fall back to the chord
    midpoint."""
    p0, p2 = from_poly[-1], to_poly[0]
    d0 = from_poly[-1] - from_poly[-2]
    d1 = to_poly[1] - to_poly[0]
    u0 = d0 / math.hypot(float(d0[0]), float(d0[1]))
    u1 = d1 / math.hypot(float(d1[0]), float(d1[1]))
    cross = float(u0[0] * u1[1] - u0[1] * u1[0])
    if abs(cross) < TANGENT_PARALLEL_EPS:
        return 0.5 * (p0 + p2)
    s = (float(p2[0] - p0[0]) * float(u1[1]) - float(p2[1] - p0[1]) * float(u1[0])) / cross
    return p0 + s * u0


def _resample(polyline: np.ndarray, cum: np.ndarray, n: int) -> np.ndarray:
    """n points evenly spaced by arc length along the polyline."""
    s = np.linspace(0.0, float(cum[-1]), n)
    return np.column_stack([np.interp(s, cum, polyline[:, 0]),
                            np.interp(s, cum, polyline[:, 1])])


def _polylines_cross(pa: np.ndarray, pb: np.ndarray,
                     end_clear: float) -> tuple[float, float] | None:
    """First crossing point between segments of pa and pb, ignoring crossings
    within end_clear of either polyline's final point (legal merges); None if
    the polylines do not cross. Parallel/collinear segment pairs never count."""
    a0, a1 = pa[:-1, None, :], pa[1:, None, :]
    b0, b1 = pb[None, :-1, :], pb[None, 1:, :]
    r, s, qp = a1 - a0, b1 - b0, b0 - a0
    denom = r[..., 0] * s[..., 1] - r[..., 1] * s[..., 0]
    ok = np.abs(denom) > 1e-12
    safe = np.where(ok, denom, 1.0)
    t = (qp[..., 0] * s[..., 1] - qp[..., 1] * s[..., 0]) / safe
    u = (qp[..., 0] * r[..., 1] - qp[..., 1] * r[..., 0]) / safe
    hit = ok & (t >= 0.0) & (t <= 1.0) & (u >= 0.0) & (u <= 1.0)
    if not hit.any():
        return None
    px = a0[..., 0] + t * r[..., 0]
    py = a0[..., 1] + t * r[..., 1]
    hit &= np.hypot(px - pa[-1, 0], py - pa[-1, 1]) >= end_clear
    hit &= np.hypot(px - pb[-1, 0], py - pb[-1, 1]) >= end_clear
    if not hit.any():
        return None
    i, j = np.argwhere(hit)[0]
    return float(px[i, j]), float(py[i, j])


def _check_phase_conflicts(intersections: dict[int, Intersection],
                           connections: dict[int, Connection]) -> None:
    """Raise ValueError if two connections of the same phase with different
    from_lanes geometrically cross (merges into a shared to_lane at the end
    of the polylines are legal and excluded)."""
    for ix_id in sorted(intersections):
        for phase in intersections[ix_id].phases:
            conns = [connections[c] for c in phase.connections]
            samples = [_resample(c.polyline, c.arclengths, CONFLICT_SAMPLES) for c in conns]
            for i in range(len(conns)):
                for j in range(i + 1, len(conns)):
                    if conns[i].from_lane == conns[j].from_lane:
                        continue
                    pt = _polylines_cross(samples[i], samples[j], MERGE_EXCLUSION)
                    if pt is not None:
                        raise ValueError(
                            f"conflicting movements in phase {phase.name!r} at "
                            f"intersection {ix_id}: connections {conns[i].id} and "
                            f"{conns[j].id} cross at ({pt[0]:.1f}, {pt[1]:.1f})")


def _bearing(dx: float, dy: float) -> float:
    """Compass bearing in degrees: N=0, E=90, S=180, W=270."""
    return math.degrees(math.atan2(dx, dy)) % 360.0


def _heading_deg(a: Node, b: Node) -> float:
    """Travel heading a->b in degrees CCW from +X, normalized to [0, 360)."""
    return math.degrees(math.atan2(b.y - a.y, b.x - a.x)) % 360.0


def _incoming_sorted(node: Node, links: dict[int, Link], nodes: dict[int, Node]) -> list[Link]:
    inc = [links[k] for k in sorted(links) if links[k].to_node == node.id]
    return sorted(inc, key=lambda l: (
        _bearing(nodes[l.from_node].x - node.x, nodes[l.from_node].y - node.y), l.id))


class Network:
    """Road network; all public iteration orders are sorted-by-id."""

    def __init__(self, nodes: dict[int, Node], links: dict[int, Link],
                 lanes: dict[int, Lane], connections: dict[int, Connection],
                 intersections: dict[int, Intersection]) -> None:
        self.nodes = nodes
        self.links = links
        self.lanes = lanes
        self.connections = connections
        self.intersections = intersections
        self.lane_connections: dict[int, list[int]] = {lid: [] for lid in sorted(lanes)}
        for cid in sorted(connections):
            self.lane_connections[connections[cid].from_lane].append(cid)
        self.entry_lanes: list[int] = sorted(
            lid for lid, lane in lanes.items()
            if nodes[links[lane.link].from_node].type == "boundary")

    def incoming_links(self, ix: int) -> list[int]:
        """Incoming link ids sorted by compass angle of approach: N, E, S, W first."""
        node = self.nodes[self.intersections[ix].node]
        return [l.id for l in _incoming_sorted(node, self.links, self.nodes)]

    def approaches(self) -> list[dict]:
        """[{"intersection", "link", "label"}] per incoming link, ix-then-compass order."""
        out = []
        for ix_id in sorted(self.intersections):
            node = self.nodes[self.intersections[ix_id].node]
            for link in _incoming_sorted(node, self.links, self.nodes):
                src = self.nodes[link.from_node]
                b = _bearing(src.x - node.x, src.y - node.y)
                out.append({"intersection": ix_id, "link": link.id,
                            "label": COMPASS_LABELS[int(round(b / 45.0)) % 8]})
        return out

    def to_meta_network(self) -> dict:
        """Exactly the TRAJECTORY_FORMAT.md meta["network"] shape (JSON-serializable)."""
        return {
            "nodes": [{"id": n.id, "x": float(n.x), "y": float(n.y), "type": n.type}
                      for n in (self.nodes[k] for k in sorted(self.nodes))],
            "links": [{"id": l.id, "from_node": l.from_node, "to_node": l.to_node,
                       "lanes": list(l.lanes)}
                      for l in (self.links[k] for k in sorted(self.links))],
            "lanes": [{"id": l.id, "link": l.link, "index": l.index,
                       "width": float(l.width), "speed_limit": float(l.speed_limit),
                       "polyline": [[float(x), float(y)] for x, y in l.polyline]}
                      for l in (self.lanes[k] for k in sorted(self.lanes))],
            "connections": [{"id": c.id, "from_lane": c.from_lane, "to_lane": c.to_lane,
                             "movement": c.movement, "intersection": c.intersection}
                            for c in (self.connections[k] for k in sorted(self.connections))],
            "intersections": [{"id": ix.id, "node": ix.node, "yellow": float(ix.yellow),
                               "all_red": float(ix.all_red), "min_green": float(ix.min_green),
                               "phases": [{"name": p.name, "connections": list(p.connections)}
                                          for p in ix.phases]}
                              for ix in (self.intersections[k] for k in sorted(self.intersections))],
        }

    @classmethod
    def from_config(cls, cfg: dict) -> "Network":
        kind = cfg["type"]
        if kind == "grid":
            nodes, edges = _grid(cfg)
        elif kind == "arterial":
            nodes, edges = _arterial(cfg)
        elif kind == "explicit":
            nodes, edges = _explicit(cfg)
        else:
            raise ValueError(f"unknown network type {kind!r}")
        return cls(*_build(nodes, edges,
                           yellow=float(cfg.get("yellow", DEFAULT_YELLOW)),
                           all_red=float(cfg.get("all_red", DEFAULT_ALL_RED)),
                           min_green=float(cfg.get("min_green", DEFAULT_MIN_GREEN))))


def _grid(cfg: dict) -> tuple[list[Node], list[dict]]:
    rows, cols = int(cfg["rows"]), int(cfg["cols"])
    block = float(cfg.get("block", 200.0))
    arm = float(cfg.get("arm", 150.0))
    nl = int(cfg.get("lanes", 2))
    sl = float(cfg.get("speed_limit", DEFAULT_SPEED))
    nodes = [Node(r * cols + c, c * block, r * block, "intersection")
             for r in range(rows) for c in range(cols)]
    edges: list[dict] = []
    for r in range(rows):
        for c in range(cols):
            nid = r * cols + c
            if c + 1 < cols:
                edges.append({"from": nid, "to": nid + 1, "lanes": nl,
                              "two_way": True, "speed_limit": sl})
            if r + 1 < rows:
                edges.append({"from": nid, "to": nid + cols, "lanes": nl,
                              "two_way": True, "speed_limit": sl})
    stub_id = rows * cols
    for r in range(rows):
        for c in range(cols):
            nid = r * cols + c
            for dx, dy in ((0, 1), (1, 0), (0, -1), (-1, 0)):    # N, E, S, W
                if 0 <= r + dy < rows and 0 <= c + dx < cols:
                    continue
                nodes.append(Node(stub_id, c * block + dx * arm, r * block + dy * arm, "boundary"))
                edges.append({"from": nid, "to": stub_id, "lanes": nl,
                              "two_way": True, "speed_limit": sl})
                stub_id += 1
    return nodes, edges


def _arterial(cfg: dict) -> tuple[list[Node], list[dict]]:
    n = int(cfg["n"])
    spacing = float(cfg.get("spacing", 180.0))
    arm = float(cfg.get("arm", 150.0))
    nl = int(cfg.get("lanes", 2))
    cl = int(cfg.get("cross_lanes", 1))
    sl = float(cfg.get("speed_limit", DEFAULT_SPEED))
    nodes = [Node(i, i * spacing, 0.0, "intersection") for i in range(n)]
    edges = [{"from": i, "to": i + 1, "lanes": nl, "two_way": True, "speed_limit": sl}
             for i in range(n - 1)]
    stub_id = n
    for i in range(n):
        for dx, dy, count in ((0, 1, cl), (1, 0, nl), (0, -1, cl), (-1, 0, nl)):  # N, E, S, W
            if dx == 1 and i != n - 1:
                continue
            if dx == -1 and i != 0:
                continue
            nodes.append(Node(stub_id, i * spacing + dx * arm, dy * arm, "boundary"))
            edges.append({"from": i, "to": stub_id, "lanes": count,
                          "two_way": True, "speed_limit": sl})
            stub_id += 1
    return nodes, edges


def _explicit(cfg: dict) -> tuple[list[Node], list[dict]]:
    nodes = [Node(int(n["id"]), float(n["x"]), float(n["y"]), n["type"])
             for n in cfg["nodes"]]
    edges = [{"from": int(e["from"]), "to": int(e["to"]), "lanes": int(e.get("lanes", 1)),
              "two_way": bool(e.get("two_way", True)),
              "speed_limit": float(e.get("speed_limit", DEFAULT_SPEED))}
             for e in cfg["edges"]]
    return nodes, edges


def _build(nodes_list: list[Node], edges: list[dict], yellow: float, all_red: float,
           min_green: float) -> tuple[dict[int, Node], dict[int, Link], dict[int, Lane],
                                      dict[int, Connection], dict[int, Intersection]]:
    nodes = {n.id: n for n in nodes_list}
    specs: list[tuple[int, int, int, float]] = []       # from, to, n_lanes, speed_limit
    for e in edges:
        specs.append((e["from"], e["to"], e["lanes"], e["speed_limit"]))
        if e["two_way"]:
            specs.append((e["to"], e["from"], e["lanes"], e["speed_limit"]))

    # Intersection box radius: 6.0 + 3.5 * max lanes over incident links.
    box = {nid: 0.0 for nid in nodes}
    for a, b, nl, _sl in specs:
        for nid in (a, b):
            if nodes[nid].type == "intersection":
                box[nid] = max(box[nid], BOX_BASE + BOX_PER_LANE * nl)

    links: dict[int, Link] = {}
    lanes: dict[int, Lane] = {}
    lane_id = 0
    for link_id, (a, b, nl, sl) in enumerate(specs):
        na, nb = nodes[a], nodes[b]
        span = math.hypot(nb.x - na.x, nb.y - na.y)
        if span < 1e-9:
            raise ValueError(
                f"coincident nodes: edge from node {a} to node {b} spans zero distance")
        if span <= box[a] + box[b]:
            raise ValueError(
                f"edge from node {a} to node {b} is too short: node span {span:.3f} m "
                f"must exceed the sum of intersection box radii "
                f"{box[a]:.3f} m (node {a}) + {box[b]:.3f} m (node {b})")
        ux, uy = (nb.x - na.x) / span, (nb.y - na.y) / span
        rx, ry = uy, -ux                                # perpendicular-right of travel
        sx, sy = na.x + ux * box[a], na.y + uy * box[a]  # cut back to box edges
        ex, ey = nb.x - ux * box[b], nb.y - uy * box[b]
        ids = []
        for i in range(nl):
            off = (i + 0.5) * LANE_WIDTH
            poly = np.array([[sx + rx * off, sy + ry * off],
                             [ex + rx * off, ey + ry * off]], dtype=np.float64)
            lanes[lane_id] = Lane(lane_id, link_id, i, LANE_WIDTH, sl, poly)
            ids.append(lane_id)
            lane_id += 1
        links[link_id] = Link(link_id, a, b, ids)

    connections: dict[int, Connection] = {}
    intersections: dict[int, Intersection] = {}
    conn_id = 0
    for ix_id, nid in enumerate(sorted(k for k, n in nodes.items() if n.type == "intersection")):
        node = nodes[nid]
        groups: dict[str, list[int]] = {name: [] for name in PHASE_ORDER}
        # Per-approach bookkeeping for split phasing: a single-lane approach
        # with a left turn cannot use protected-left axis phasing (the head
        # left-turner blocks the whole lane during the through phase), so such
        # axes get one all-movements phase per approach instead.
        appr: dict[str, dict] = {}
        outgoing = [links[k] for k in sorted(links) if links[k].from_node == nid]
        for in_link in _incoming_sorted(node, links, nodes):
            src = nodes[in_link.from_node]
            h_in = _heading_deg(src, node)
            axis = "NS" if abs(src.y - node.y) >= abs(src.x - node.x) else "EW"
            dx, dy = src.x - node.x, src.y - node.y
            if axis == "NS":
                label = "N" if dy > 0 else "S"
            else:
                label = "E" if dx > 0 else "W"
            if label in appr:
                raise ValueError(
                    f"intersection at node {nid}: two incoming links both classify "
                    f"as approach '{label}' (arms within 45 deg of each other); "
                    f"split-phase labeling cannot distinguish them - adjust geometry")
            ap = appr.setdefault(label, {"axis": axis, "conns": [], "left": False,
                                         "lanes": len(in_link.lanes)})
            for out_link in outgoing:
                d = (_heading_deg(node, nodes[out_link.to_node]) - h_in) % 360.0
                if d < 45.0 or d >= 315.0:
                    movement = "through"
                elif d < 135.0:
                    movement = "left"
                elif d <= 225.0:
                    continue                            # U-turn: no connection
                else:
                    movement = "right"
                l_in, l_out = len(in_link.lanes), len(out_link.lanes)
                if movement == "left":
                    pairs = [(0, 0)]
                elif movement == "right":
                    pairs = [(l_in - 1, l_out - 1)]
                else:
                    idxs = range(1, l_in) if l_in >= 2 else range(1)
                    pairs = [(i, min(i, l_out - 1)) for i in idxs]
                for fi, ti in pairs:
                    fl, tl = lanes[in_link.lanes[fi]], lanes[out_link.lanes[ti]]
                    p0, p2 = fl.polyline[-1], tl.polyline[0]
                    if movement == "through":
                        poly = np.array([p0, p2], dtype=np.float64)
                    else:
                        t = np.linspace(0.0, 1.0, BEZIER_SAMPLES)[:, None]
                        p1 = _turn_control_point(fl.polyline, tl.polyline)
                        poly = (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2
                    connections[conn_id] = Connection(conn_id, fl.id, tl.id, movement, ix_id, poly)
                    groups[axis + ("-L" if movement == "left" else "")].append(conn_id)
                    ap["conns"].append(conn_id)
                    if movement == "left":
                        ap["left"] = True
                    conn_id += 1
        phases = []
        for axis in ("NS", "EW"):
            on_axis = {lbl: a for lbl, a in appr.items() if a["axis"] == axis}
            split = any(a["lanes"] == 1 and a["left"] for a in on_axis.values())
            if split:
                for lbl in sorted(on_axis):
                    phases.append(Phase(lbl, tuple(sorted(on_axis[lbl]["conns"]))))
            else:
                for name in (axis, axis + "-L"):
                    if groups[name]:
                        phases.append(Phase(name, tuple(sorted(groups[name]))))
        if not phases:
            raise ValueError(
                f"intersection at node {nid} has no signal phases "
                f"(no incoming links or no legal movements)")
        intersections[ix_id] = Intersection(ix_id, nid, phases, yellow, all_red, min_green)
    _check_phase_conflicts(intersections, connections)
    return nodes, links, lanes, connections, intersections
