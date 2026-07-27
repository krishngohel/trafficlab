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
  maxTrees: 400,
  padClearance: 34,
  maxPads: 24,
} as const;

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

  /**
   * Candidate spacing scales with the network so a grid4x4 does not exhaust
   * the cap in its southern strip while a single intersection gets a
   * postage-stamp forest. ~3 candidates per slot we intend to keep.
   */
  const spacing = (slots: number, lo: number, hi: number) =>
    Math.min(Math.max(Math.sqrt(area / Math.max(slots * 3, 1)), lo), hi);

  // --- building pads ---------------------------------------------------------
  const padStep = spacing(opts.maxPads, 46, 190);
  const padCandidates: PadSpot[] = [];
  for (let gy = minY + padStep / 2; gy <= maxY; gy += padStep) {
    for (let gx = minX + padStep / 2; gx <= maxX; gx += padStep) {
      const x = gx + (rand() - 0.5) * padStep * 0.45;
      const y = gy + (rand() - 0.5) * padStep * 0.45;
      const width = 22 + rand() * 30;
      const depth = 22 + rand() * 30;
      // Tall enough to read as a massed block from any camera angle — a flat
      // slab just looks like a hole in the ground from above.
      const height = 10 + rand() * 26;
      const tint = 0.75 + rand() * 0.5;
      const rot = (rand() - 0.5) * 0.25;
      // Sample the four corners too: a pad is a footprint, not a point.
      const reach = Math.max(width, depth) / 2;
      // Keep the massing inside (or immediately around) the blocks — a tower
      // stranded 200 m from the nearest road just reads as a floating box.
      if (!inBand(x, y, segments, discs, opts.padClearance, opts.padClearance * 2.4)) continue;
      if (
        !isClear(x + reach, y, segments, discs, opts.padClearance * 0.5) ||
        !isClear(x - reach, y, segments, discs, opts.padClearance * 0.5) ||
        !isClear(x, y + reach, segments, discs, opts.padClearance * 0.5) ||
        !isClear(x, y - reach, segments, discs, opts.padClearance * 0.5)
      ) {
        continue;
      }
      padCandidates.push({ x, y, rot, width, depth, height, tint });
    }
  }
  const pads = shuffle(padCandidates, rand).slice(0, opts.maxPads);

  // --- trees ------------------------------------------------------------------
  // Trees are sampled on their own fine grid (independent of the cap) so the
  // narrow band below is actually hit; the cell budget keeps the sweep cheap
  // even on the biggest network.
  const step = Math.min(Math.max(Math.sqrt(area / 12000), 13), 26);
  // Street trees: a band just off the kerb. Wide enough to look planted rather
  // than fenced, tight enough that the scenery frames the streets instead of
  // dissolving into open country.
  const spread = opts.clearance + 30;
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
