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
import type { TrajMeta } from "../traj";

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

/** Every lane polyline flattened into segments with a cached bounding box. */
export function laneSegments(meta: TrajMeta): Segment[] {
  const out: Segment[] = [];
  for (const lane of meta.network.lanes) {
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

/** One keep-out disc per simulated intersection. */
export function nodeDiscs(meta: TrajMeta): NodeDisc[] {
  const radii = intersectionRadii(meta);
  const out: NodeDisc[] = [];
  for (const node of meta.network.nodes) {
    if (node.type !== "intersection") continue;
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
