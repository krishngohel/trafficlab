/**
 * Deterministic placement of scenery (trees, building pads) in the gaps
 * between roads. Pure math — no three.js, no DOM — so the placement rules are
 * unit testable and identical for every viewer that loads the same file.
 *
 * Everything is seeded from `meta.network_name`, so a given network always
 * grows the same trees in the same places (and a comparison's two sides match).
 *
 * Coordinates here are SIM coordinates (X east, Y north), the same space the
 * lane polylines live in. The three.js layer maps them to (x, -z).
 */

import { intersectionRadii, networkBounds } from "./roads";
import type { TrajMeta } from "../traj";

export interface TreeSpot {
  x: number;
  y: number;
  /** Height in metres. */
  height: number;
  /** Rotation about the vertical axis (rad). */
  rot: number;
  /** Per-instance colour multiplier, split into warm/cool so hue shifts too. */
  tintR: number;
  tintG: number;
  tintB: number;
}

export interface PadSpot {
  x: number;
  y: number;
  /**
   * Rotation about the vertical axis (rad), in SCENE space: the model's local
   * +Z faces the nearest road, so the buildings front the street instead of
   * sitting at random angles in a field.
   */
  rot: number;
  /** Footprint and height in metres. */
  width: number;
  depth: number;
  height: number;
  tint: number;
}

export interface ScatterOptions {
  /** Minimum distance from any lane polyline / intersection disc (m). */
  clearance?: number;
  maxTrees?: number;
  /** Minimum clearance for building pads (m). */
  padClearance?: number;
  maxPads?: number;
}

export interface Scatter {
  trees: TreeSpot[];
  pads: PadSpot[];
}

const DEFAULTS = {
  clearance: 14,
  padClearance: 22,
  maxTrees: 400,
} as const;

/**
 * Buildings per metre of lane, when the caller does not pin `maxPads`. A fixed
 * cap turns a single-intersection network into a dense office park and leaves a
 * grid4x4 looking empty, so the count follows how much street there is to line.
 */
const PADS_PER_LANE_METRE = 1 / 220;
const MIN_PADS = 6;
const MAX_PADS = 40;

/** FNV-1a over a string — a stable seed for the PRNG. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for scatter jitter. */
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

interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
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

/** Squared distance from (px, py) to a segment. */
function distSqToSegment(px: number, py: number, s: Segment): number {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - s.x0) * dx + (py - s.y0) * dy) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = s.x0 + dx * t;
  const cy = s.y0 + dy * t;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

interface NodeDisc {
  x: number;
  y: number;
  radius: number;
}

/**
 * True when (px, py) sits in the band `clearance <= d <= spread` from the road
 * network: far enough off the tarmac to never crowd a lane, close enough that
 * the scenery reads as filling the blocks *between* roads instead of drifting
 * off into empty countryside. Both tests share one early-exiting pass.
 */
export function inBand(
  px: number,
  py: number,
  segments: readonly Segment[],
  discs: readonly NodeDisc[],
  clearance: number,
  spread = Infinity,
): boolean {
  const near = clearance * clearance;
  let withinSpread = spread === Infinity;
  for (const d of discs) {
    const dx = px - d.x;
    const dy = py - d.y;
    const distSq = dx * dx + dy * dy;
    const inner = d.radius + clearance;
    if (distSq < inner * inner) return false;
    if (!withinSpread) {
      const outer = d.radius + spread;
      if (distSq < outer * outer) withinSpread = true;
    }
  }
  const reach = spread === Infinity ? clearance : spread;
  for (const s of segments) {
    // Cheap bounding-box reject before the projection maths.
    if (
      px < s.minX - reach ||
      px > s.maxX + reach ||
      py < s.minY - reach ||
      py > s.maxY + reach
    ) {
      continue;
    }
    const distSq = distSqToSegment(px, py, s);
    if (distSq < near) return false;
    if (!withinSpread && distSq < spread * spread) withinSpread = true;
  }
  return withinSpread;
}

/** True when (px, py) keeps at least `clearance` metres from every road. */
export function isClear(
  px: number,
  py: number,
  segments: readonly Segment[],
  discs: readonly NodeDisc[],
  clearance: number,
): boolean {
  return inBand(px, py, segments, discs, clearance);
}

/**
 * Scene-space Y rotation that turns a model's local +Z toward the nearest road,
 * so buildings front the street. Falls back to 0 when there is no road at all.
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

/** Deterministic Fisher-Yates, so a cap never biases the scatter spatially. */
function shuffle<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Scatter scenery over the network's empty blocks: building pads first (they
 * want the biggest gaps), then trees, which avoid both the roads and the pads.
 * Deterministic for a given `meta.network_name`.
 */
export function scatterEnvironment(meta: TrajMeta, options: ScatterOptions = {}): Scatter {
  const opts = { ...DEFAULTS, ...options };
  const bounds = networkBounds(meta);
  const segments = laneSegments(meta);
  const laneMetres = segments.reduce((sum, s) => sum + Math.hypot(s.x1 - s.x0, s.y1 - s.y0), 0);
  const maxPads =
    options.maxPads ??
    Math.min(Math.max(Math.round(laneMetres * PADS_PER_LANE_METRE), MIN_PADS), MAX_PADS);
  const discs: NodeDisc[] = [];
  const radii = intersectionRadii(meta);
  for (const node of meta.network.nodes) {
    discs.push({ x: node.x, y: node.y, radius: radii.get(node.id) ?? 6 });
  }

  const rand = mulberry32(hashSeed(meta.network_name ?? "network"));
  // Frame the network with a margin so the horizon is not an abrupt edge.
  const margin = Math.min(Math.max(bounds.extent * 0.12, 50), 150);
  const minX = bounds.minX - margin;
  const maxX = bounds.maxX + margin;
  const minY = bounds.minY - margin;
  const maxY = bounds.maxY + margin;
  const area = Math.max((maxX - minX) * (maxY - minY), 1);

  // --- building pads ---------------------------------------------------------
  // Buildings are placed along STREET FRONTAGES, not on a grid over the whole
  // map: walking every lane at a fixed setback puts a row of facades behind the
  // verge on each side of a street, which is what makes a network read as a
  // town instead of towers dropped in a field. Everything still has to clear
  // `padClearance` of every lane and intersection, so a candidate that lands in
  // the opposing carriageway or an intersection mouth is simply dropped.
  const padCandidates: PadSpot[] = [];
  const frontageStep = 30;
  for (const lane of meta.network.lanes) {
    const pts = lane.polyline;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const segLen = Math.hypot(x1 - x0, y1 - y0);
      if (segLen < frontageStep) continue;
      const ux = (x1 - x0) / segLen;
      const uy = (y1 - y0) / segLen;
      const slots = Math.floor(segLen / frontageStep);
      for (let k = 0; k < slots; k++) {
        for (const side of [1, -1]) {
          const along = (k + 0.5) * frontageStep + (rand() - 0.5) * frontageStep * 0.5;
          // Town-scale plots: a 14-28 m frontage reads as a commercial block
          // next to 3.5 m lanes, where 22-52 m slabs read as warehouses.
          const width = 12 + rand() * 13;
          const depth = width * (0.86 + rand() * 0.3);
          // Tall enough to read as a massed block from any camera angle — a
          // flat slab just looks like a hole in the ground from above.
          const height = 10 + rand() * 26;
          const tint = 0.82 + rand() * 0.36;
          const jitter = (rand() - 0.5) * 0.18;
          const setback = opts.padClearance + rand() * 14;
          const x = x0 + ux * along + -uy * side * setback;
          const y = y0 + uy * along + ux * side * setback;
          // Sample the four corners too: a pad is a footprint, not a point.
          const reach = Math.max(width, depth) / 2;
          if (!isClear(x, y, segments, discs, opts.padClearance)) continue;
          if (
            !isClear(x + reach, y, segments, discs, opts.padClearance * 0.45) ||
            !isClear(x - reach, y, segments, discs, opts.padClearance * 0.45) ||
            !isClear(x, y + reach, segments, discs, opts.padClearance * 0.45) ||
            !isClear(x, y - reach, segments, discs, opts.padClearance * 0.45)
          ) {
            continue;
          }
          padCandidates.push({
            x,
            y,
            rot: facingNearestRoad(x, y, segments) + jitter,
            width,
            depth,
            height,
            tint,
          });
        }
      }
    }
  }
  // Shuffle first so the cap does not favour the lowest-numbered lanes, then
  // keep only pads whose footprints do not collide with an already-kept one.
  const pads: PadSpot[] = [];
  for (const candidate of shuffle(padCandidates, rand)) {
    if (pads.length >= maxPads) break;
    const reach = Math.max(candidate.width, candidate.depth) / 2;
    let clash = false;
    for (const kept of pads) {
      const gap = reach + Math.max(kept.width, kept.depth) / 2 + 6;
      if (Math.abs(candidate.x - kept.x) < gap && Math.abs(candidate.y - kept.y) < gap) {
        clash = true;
        break;
      }
    }
    if (!clash) pads.push(candidate);
  }

  // --- trees ------------------------------------------------------------------
  // Trees are sampled on their own fine grid (independent of the cap) so the
  // narrow band below is actually hit; the cell budget keeps the sweep cheap
  // even on the biggest network.
  const step = Math.min(Math.max(Math.sqrt(area / 12000), 13), 26);
  // Street trees: a planting strip just off the kerb, in front of the building
  // frontages (which start at `padClearance`). Wide enough to look planted
  // rather than fenced, tight enough that the scenery frames the streets
  // instead of dissolving into open country.
  const spread = opts.clearance + 17;
  const treeCandidates: TreeSpot[] = [];
  for (let gy = minY; gy <= maxY; gy += step) {
    for (let gx = minX; gx <= maxX; gx += step) {
      const x = gx + (rand() - 0.5) * step * 0.85;
      const y = gy + (rand() - 0.5) * step * 0.85;
      const height = 6 + rand() * 4;
      const rot = rand() * Math.PI * 2;
      const warm = rand();
      if (!inBand(x, y, segments, discs, opts.clearance, spread)) continue;
      let insidePad = false;
      for (const p of pads) {
        const reach = Math.max(p.width, p.depth) / 2 + 4;
        if (Math.abs(x - p.x) < reach && Math.abs(y - p.y) < reach) {
          insidePad = true;
          break;
        }
      }
      if (insidePad) continue;
      treeCandidates.push({
        x,
        y,
        height,
        rot,
        // Multiplicative tint: warmer (olive) through cooler (blue-green).
        tintR: 0.78 + warm * 0.5,
        tintG: 0.92 + warm * 0.16,
        tintB: 1.16 - warm * 0.45,
      });
    }
  }
  const trees = shuffle(treeCandidates, rand).slice(0, opts.maxTrees);

  return { trees, pads };
}
