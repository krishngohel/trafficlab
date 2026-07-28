/**
 * Seeded randomness and lane-polyline geometry — the primitives the city
 * planner (`city.ts`) is built out of. Pure math: no three.js, no DOM, so the
 * placement rules are unit testable and identical for every viewer that loads
 * the same file.
 *
 * Everything downstream is seeded from `meta.network_name`, so a given network
 * always grows the same city (and a comparison's two sides match).
 *
 * Coordinates here are SIM coordinates (X east, Y north), the same space the
 * lane polylines live in. The three.js layer maps them to (x, -z).
 */

import { intersectionRadii } from "./network";
import type { TrajMeta, TrajNode } from "../traj";

/**
 * The node types a .traj network can carry. `TrajNode.type` still declares only
 * the two original ones, but the simulator's off-street parking feature
 * (docs/PARKING_DESIGN.md) added `"parking"` (a garage / lot, where trips begin
 * and end) and `"junction"` (an uncontrolled driveway/street junction), and
 * every parking-enabled network is full of both. Widening the parser's union is
 * a change to the format contract; reading it through here is not.
 */
export type SceneNodeType = "intersection" | "boundary" | "parking" | "junction";

/** `node.type`, widened to the four types a parking-enabled network can carry. */
export function nodeType(node: TrajNode): SceneNodeType {
  return node.type as SceneNodeType;
}

/** FNV-1a over a string — a stable seed for the PRNG. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for placement jitter. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A lane polyline segment with a cached bounding box. */
export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface NodeDisc {
  x: number;
  y: number;
  radius: number;
}

/**
 * One off-street parking node and the driveway that joins it to the street.
 *
 * A driveway is a 14 m, single-lane-per-direction link running perpendicular
 * from an uncontrolled `junction` node on the street out to a `parking` node
 * (the garage). It is NOT a street: it carries no through traffic, it sits
 * mid-block where no city grid line runs, and anything that derives the street
 * grid, its spacing or its carriageway widths has to leave it out.
 */
export interface Driveway {
  /** Parking node id — where a car comes to rest. */
  parking: number;
  /** Parking node position, sim coordinates. */
  x: number;
  y: number;
  /** The uncontrolled junction node on the street. */
  junction: number;
  jx: number;
  jy: number;
  /** Unit vector pointing from the street junction out to the parking node. */
  dirX: number;
  dirY: number;
  /** Junction to parking node distance (m). */
  length: number;
  /** Half-width of the driveway's carriageway (m), across `dir`. */
  half: number;
  /** Every lane on the driveway's two links. */
  lanes: number[];
}

/**
 * Every driveway in the network, one entry per parking node, ordered by node
 * id. Empty for a network without the parking feature, which is what keeps the
 * shipped non-parking fixtures on exactly the code path they had before.
 */
export function driveways(meta: TrajMeta): Driveway[] {
  const nodeById = new Map(meta.network.nodes.map((n) => [n.id, n]));
  const laneById = new Map(meta.network.lanes.map((l) => [l.id, l]));
  /** parking node id -> the junction it hangs off + every lane between them. */
  const byParking = new Map<number, { junction: TrajNode; lanes: number[] }>();
  for (const link of meta.network.links) {
    const from = nodeById.get(link.from_node);
    const to = nodeById.get(link.to_node);
    if (!from || !to) continue;
    const parking =
      nodeType(from) === "parking" ? from : nodeType(to) === "parking" ? to : null;
    if (!parking) continue;
    const junction = parking === from ? to : from;
    const entry = byParking.get(parking.id);
    if (entry) entry.lanes.push(...link.lanes);
    else byParking.set(parking.id, { junction, lanes: [...link.lanes] });
  }

  const out: Driveway[] = [];
  for (const [id, { junction, lanes }] of [...byParking].sort((a, b) => a[0] - b[0])) {
    const node = nodeById.get(id)!;
    const dx = node.x - junction.x;
    const dy = node.y - junction.y;
    const length = Math.hypot(dx, dy) || 1;
    const dirX = dx / length;
    const dirY = dy / length;
    // Half-width across the driveway: the furthest lane edge from its axis.
    let half = 0;
    for (const laneId of lanes) {
      const lane = laneById.get(laneId);
      if (!lane) continue;
      for (const [px, py] of lane.polyline) {
        const across = Math.abs((px - node.x) * -dirY + (py - node.y) * dirX);
        half = Math.max(half, across + lane.width / 2);
      }
    }
    out.push({
      parking: id,
      x: node.x,
      y: node.y,
      junction: junction.id,
      jx: junction.x,
      jy: junction.y,
      dirX,
      dirY,
      length,
      half: half > 0 ? half : 3.5,
      lanes,
    });
  }
  return out;
}

/**
 * Lane ids that belong to a driveway rather than to a street. Pass this to
 * `laneSegments` (or check it directly) wherever "the street network" is meant.
 */
export function drivewayLaneIds(meta: TrajMeta): Set<number> {
  const out = new Set<number>();
  for (const drive of driveways(meta)) for (const id of drive.lanes) out.add(id);
  return out;
}

/**
 * Every lane polyline flattened into segments with a cached bounding box.
 *
 * With no `skip` set this is the whole network — the right set for keep-out
 * tests, because nothing may be built on a driveway either. Pass
 * `drivewayLaneIds(meta)` to get the STREET network, which is what deriving the
 * city grid, its spacing and its carriageway widths needs.
 */
export function laneSegments(meta: TrajMeta, skip?: ReadonlySet<number>): Segment[] {
  const out: Segment[] = [];
  for (const lane of meta.network.lanes) {
    if (skip?.has(lane.id)) continue;
    const pts = lane.polyline;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      out.push({
        x0,
        y0,
        x1,
        y1,
        minX: Math.min(x0, x1),
        maxX: Math.max(x0, x1),
        minY: Math.min(y0, y1),
        maxY: Math.max(y0, y1),
      });
    }
  }
  return out;
}

/** Lane segments of the STREET network — driveways excluded. */
export function streetLaneSegments(meta: TrajMeta): Segment[] {
  return laneSegments(meta, drivewayLaneIds(meta));
}

/** One keep-out disc per simulated intersection. */
export function nodeDiscs(meta: TrajMeta): NodeDisc[] {
  const radii = intersectionRadii(meta);
  const out: NodeDisc[] = [];
  for (const node of meta.network.nodes) {
    if (nodeType(node) !== "intersection") continue;
    out.push({ x: node.x, y: node.y, radius: radii.get(node.id) ?? 6 });
  }
  return out;
}

/** Squared distance from (px, py) to a segment. */
export function distSqToSegment(px: number, py: number, s: Segment): number {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - s.x0) * dx + (py - s.y0) * dy) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = s.x0 + dx * t;
  const cy = s.y0 + dy * t;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/** True when (px, py) keeps at least `clearance` metres from every road. */
export function isClear(
  px: number,
  py: number,
  segments: readonly Segment[],
  discs: readonly NodeDisc[],
  clearance: number,
): boolean {
  const near = clearance * clearance;
  for (const d of discs) {
    const dx = px - d.x;
    const dy = py - d.y;
    const inner = d.radius + clearance;
    if (dx * dx + dy * dy < inner * inner) return false;
  }
  for (const s of segments) {
    if (
      px < s.minX - clearance ||
      px > s.maxX + clearance ||
      py < s.minY - clearance ||
      py > s.maxY + clearance
    ) {
      continue;
    }
    if (distSqToSegment(px, py, s) < near) return false;
  }
  return true;
}

/**
 * Scene-space Y rotation that turns a model's local +Z toward the nearest road,
 * so a prop fronts the street. Falls back to 0 when there is no road at all.
 */
export function facingNearestRoad(
  px: number,
  py: number,
  segments: readonly Segment[],
): number {
  let bestSq = Infinity;
  let cx = px;
  let cy = py;
  for (const s of segments) {
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - s.x0) * dx + (py - s.y0) * dy) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = s.x0 + dx * t;
    const qy = s.y0 + dy * t;
    const distSq = (px - qx) * (px - qx) + (py - qy) * (py - qy);
    if (distSq < bestSq) {
      bestSq = distSq;
      cx = qx;
      cy = qy;
    }
  }
  if (!Number.isFinite(bestSq) || bestSq === 0) return 0;
  // Sim (x, y) -> scene (x, -z): the facing vector is (dx, -dy).
  return Math.atan2(cx - px, -(cy - py));
}
