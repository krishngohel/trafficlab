/**
 * The city that surrounds the simulation.
 *
 * The .traj network is a handful of streets that stop dead at their boundary
 * nodes. On its own that reads as "a few roads dropped in a field". This module
 * plans a whole cityscape around it, on the sim network's own axes and spacing,
 * so the simulated streets are simply the part of the city that has cars in it:
 *
 *   1. a street grid that continues every boundary stub outward and tiles out to
 *      a few times the network extent, clipped so it never touches the simulated
 *      road footprint (no z-fighting, no filler asphalt over a lane),
 *   2. the blocks between those streets, filled with buildings that front the
 *      street shoulder-to-shoulder — towers downtown, mid-rise in the middle
 *      ring, cheap shells further out, and merged boxes on the horizon,
 *   3. sidewalks, corner pads and paved block interiors, so the ground between
 *      the streets reads as developed land instead of lawn,
 *   4. parks: whole blocks kept as grass and trees, so it is not wall to wall
 *      concrete.
 *
 * Everything here is pure math in SIM coordinates (X east, Y north) and seeded
 * from `meta.network_name`, so a given network always grows the same city and
 * both sides of a comparison match. The three.js layers (`roads.ts` for the flat
 * ground geometry, `environment.ts` for the buildings and trees) consume the
 * plan; `cityPlan()` memoizes it so they can each ask for it independently.
 */

import { hashSeed, laneSegments, mulberry32, type Segment } from "./scatter";
import {
  groundPlaneSize,
  intersectionRadii,
  networkBounds,
  type NetworkBounds,
} from "./network";
import type { TrajMeta } from "../traj";

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

/** 0: constant x, running along y. 1: constant y, running along x. */
export type Axis = 0 | 1;

/** A straight run of something linear (asphalt, sidewalk) on the city grid. */
export interface CityStreet {
  axis: Axis;
  /** The constant coordinate (x for axis 0, y for axis 1). */
  c: number;
  /** Start and end along the varying coordinate. */
  a: number;
  b: number;
  /**
   * Half-width of the run (m). Streets inherit the carriageway width of the
   * simulated corridor they continue, so an avenue stays an avenue and a local
   * street stays narrow; sidewalks carry half the pavement width.
   */
  half: number;
  /** Lanes per direction, for laying out the paint. Sidewalks use 0. */
  lanes: number;
  /** Paint dashed lane separators here (near the camera; off in the far ring). */
  detail: boolean;
}

export type BuildingTier = "tower" | "midrise" | "lowdetail" | "massing";

export interface BuildingSpot {
  /** Footprint centre, sim coordinates. */
  x: number;
  y: number;
  /**
   * Rotation about the vertical axis (rad), in SCENE space: the model's local
   * +Z faces the street this building fronts.
   */
  rot: number;
  /** Footprint side length (m). The models are normalized to a 1 x 1 plan. */
  width: number;
  /** Target height (m); `environment.ts` picks the model that comes closest. */
  height: number;
  tier: BuildingTier;
  /** Albedo multiplier. */
  tint: number;
  /** Stable per-spot random in [0, 1), for model choice. */
  pick: number;
}

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

export interface CityDisc {
  x: number;
  y: number;
  radius: number;
}

export interface CityRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CityPlan {
  bounds: NetworkBounds;
  /** Half-extent of the built city, from the network centre (m). */
  half: number;
  /** Street pitch, taken from the sim network (m). */
  spacing: number;
  /** Width of one traffic lane (m), for laying out the paint. */
  laneWidth: number;
  /**
   * TYPICAL half-widths, in metres from a street's centreline: asphalt, gravel
   * verge, the sidewalk band, and where a block's buildable interior starts.
   * Per-street values live on `CityStreet.half`; these are the median, for
   * callers that just need a sense of scale.
   */
  roadHalf: number;
  vergeHalf: number;
  walkInner: number;
  walkOuter: number;
  blockInset: number;
  /** Filler asphalt: everything the simulator does not already draw. */
  streets: CityStreet[];
  /** Discs for filler crossings (the sim draws its own). */
  nodes: CityDisc[];
  /** Sidewalk ribbons, along both sim and filler streets. */
  sidewalks: CityStreet[];
  /** Pads filling the corner between two streets at every crossing. */
  corners: CityRect[];
  /** Paved block interiors. */
  lots: CityRect[];
  buildings: BuildingSpot[];
  trees: TreeSpot[];
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const TUNING = {
  /** City half-extent as a multiple of the network extent, and its clamps. */
  halfFactor: 2.6,
  halfMin: 900,
  halfMax: 2400,
  /** Fallback street pitch when the network has fewer than two cross streets. */
  spacingFallback: 200,
  spacingMin: 90,
  spacingMax: 340,
  /** Planting strip between kerb and sidewalk, and the sidewalk itself (m). */
  plantingWidth: 3,
  walkWidth: 4,
  /** Gap from the block interior edge to the building facades (m). */
  setback: 2.2,
  /**
   * How far back from a crossing a block frontage starts (m). This also feeds
   * `rowInset`, which is what stops the four frontage rows knotting together at
   * the block corners — shrinking it to win frontage costs overlapping models.
   */
  cornerInset: 21,
  /** Radius of a filler crossing's paved disc (m). */
  nodeRadius: 12.5,
  /**
   * Per-tier instance budgets, nearest block first. The full-detail shells are
   * ~2-4k triangles each so they stay scarce; the decimated ones are ~60-250,
   * which is what lets the model city reach out most of a kilometre before the
   * merged boxes have to take over.
   */
  modelBudget: 2400,
  towerBudget: 110,
  midriseBudget: 420,
  maxStreetTrees: 300,
  maxParkTrees: 340,
  /** How often a downtown plot gets a tower rather than a mid-rise. */
  towerChance: 0.26,
  /** Blocks kept as parkland. */
  parkChance: 0.06,
  /** Built blocks that keep a green interior (suburban, buildings on the rim). */
  greenInteriorChance: 0.09,
  /**
   * Block interiors behind the street wall. A block built only around its rim
   * reads as a fence around a yard from above, so the middle gets a lower rank
   * of lock-ups and sheds. Denser pitch and a higher take rate fill the
   * courtyards without competing with the frontage for height.
   */
  shedPitch: 29,
  shedChance: 0.68,
} as const;

// ---------------------------------------------------------------------------
// Interval algebra (a street is a 1-D set once you fix its axis)
// ---------------------------------------------------------------------------

type Interval = [number, number];

function subtract(intervals: readonly Interval[], lo: number, hi: number): Interval[] {
  if (hi <= lo) return intervals.slice();
  const out: Interval[] = [];
  for (const [a, b] of intervals) {
    if (hi <= a || lo >= b) {
      out.push([a, b]);
      continue;
    }
    if (lo > a) out.push([a, lo]);
    if (hi < b) out.push([hi, b]);
  }
  return out;
}

function prune(intervals: readonly Interval[], minLength: number): Interval[] {
  return intervals.filter(([a, b]) => b - a >= minLength);
}

function contains(intervals: readonly Interval[], v: number): boolean {
  for (const [a, b] of intervals) if (v >= a && v <= b) return true;
  return false;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Nearest value in a sorted array, or null when nothing is within `tol`. */
function snap(sorted: readonly number[], v: number, tol: number): number | null {
  let best: number | null = null;
  let bestD = tol;
  for (const s of sorted) {
    const d = Math.abs(s - v);
    if (d <= bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Reading the sim network's own grid
// ---------------------------------------------------------------------------

/** The stretch of one grid line the simulator already paves. */
interface SimSpan {
  min: number;
  max: number;
  /** Widest lane offset seen on this line, plus half that lane (m). */
  half: number;
}

function uniqueSorted(values: readonly number[], tol = 1): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > tol) out.push(v);
  }
  return out;
}

function medianStep(sorted: readonly number[]): number | null {
  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 1) diffs.push(d);
  }
  if (diffs.length === 0) return null;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

const CACHE = new WeakMap<TrajMeta, CityPlan>();

/** Plan (and memoize) the city around one network. */
export function cityPlan(meta: TrajMeta): CityPlan {
  let plan = CACHE.get(meta);
  if (!plan) {
    plan = planCity(meta);
    CACHE.set(meta, plan);
  }
  return plan;
}

function emptyPlan(bounds: NetworkBounds): CityPlan {
  return {
    bounds,
    half: 0,
    spacing: TUNING.spacingFallback,
    laneWidth: 3.5,
    roadHalf: 7.4,
    vergeHalf: 8.4,
    walkInner: 11.4,
    walkOuter: 15.4,
    blockInset: 15.4,
    streets: [],
    nodes: [],
    sidewalks: [],
    corners: [],
    lots: [],
    buildings: [],
    trees: [],
  };
}

export function planCity(meta: TrajMeta): CityPlan {
  const bounds = networkBounds(meta);
  const segments = laneSegments(meta);
  if (segments.length === 0) return emptyPlan(bounds);

  const rand = mulberry32(hashSeed(`${meta.network_name ?? "network"}:city`));

  // --- 1. the grid --------------------------------------------------------
  const radii = intersectionRadii(meta);
  const junctions = meta.network.nodes.filter((n) => n.type === "intersection");
  const anchors = junctions.length > 0 ? junctions : meta.network.nodes;
  const simXs = uniqueSorted(anchors.map((n) => n.x));
  const simYs = uniqueSorted(anchors.map((n) => n.y));
  const spacing = clamp(
    medianStep(simXs) ?? medianStep(simYs) ?? TUNING.spacingFallback,
    TUNING.spacingMin,
    TUNING.spacingMax,
  );
  // The city has to stay on the ground plane, whose far edge is what the fog
  // and the haze band are tuned to hide.
  const half = Math.min(
    clamp(bounds.extent * TUNING.halfFactor, TUNING.halfMin, TUNING.halfMax),
    groundPlaneSize(bounds) * 0.5 - 140,
  );
  const xs = extend(simXs, spacing, bounds.centerX - half, bounds.centerX + half);
  const ys = extend(simYs, spacing, bounds.centerY - half, bounds.centerY + half);

  // --- 2. what the simulator already paves --------------------------------
  // Lanes are grouped onto the grid line they run along, so the filler asphalt
  // can butt straight up against the end of a boundary stub instead of leaving
  // a gap of lawn between the two.
  const simSpans: [Map<number, SimSpan>, Map<number, SimSpan>] = [new Map(), new Map()];
  const offGrid: Segment[] = [];
  const snapTol = spacing * 0.35;
  for (const lane of meta.network.lanes) {
    const pts = lane.polyline;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const axis: Axis = Math.abs(x1 - x0) >= Math.abs(y1 - y0) ? 1 : 0;
      const raw = axis === 1 ? (y0 + y1) / 2 : (x0 + x1) / 2;
      const line = snap(axis === 1 ? ys : xs, raw, snapTol);
      if (line === null) {
        offGrid.push({
          x0,
          y0,
          x1,
          y1,
          minX: Math.min(x0, x1),
          maxX: Math.max(x0, x1),
          minY: Math.min(y0, y1),
          maxY: Math.max(y0, y1),
        });
        continue;
      }
      const lo = axis === 1 ? Math.min(x0, x1) : Math.min(y0, y1);
      const hi = axis === 1 ? Math.max(x0, x1) : Math.max(y0, y1);
      widen(simSpans[axis], line, lo, hi, Math.abs(raw - line) + lane.width / 2);
    }
  }
  // Intersection discs plug the gaps the lane polylines leave at each junction.
  const simDiscs: CityDisc[] = [];
  for (const node of junctions) {
    const r = (radii.get(node.id) ?? 8) * 1.04 + 1;
    simDiscs.push({ x: node.x, y: node.y, radius: r });
    const lx = snap(xs, node.x, snapTol);
    const ly = snap(ys, node.y, snapTol);
    // A disc only extends the paved *run* along its two lines; it says nothing
    // about how wide the carriageway is, so it must not widen `half`.
    if (lx !== null) widen(simSpans[0], lx, node.y - r, node.y + r, 0);
    if (ly !== null) widen(simSpans[1], ly, node.x - r, node.x + r, 0);
  }

  // Filler streets inherit the carriageway width of the corridor they continue,
  // per grid line. A network with a real hierarchy (3-lane avenues, 2-lane
  // streets, 1-lane locals) therefore keeps that hierarchy all the way out: the
  // avenue stays an avenue, and the pattern tiles outward past the last
  // simulated street rather than flattening to one width everywhere.
  const laneWidths = meta.network.lanes.map((l) => l.width).sort((a, b) => a - b);
  const laneWidth = laneWidths.length > 0 ? laneWidths[Math.floor(laneWidths.length / 2)] : 3.5;
  const simHalf: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
  for (const axis of [0, 1] as Axis[]) {
    for (const [c, s] of simSpans[axis]) {
      if (s.half > laneWidth * 0.4) simHalf[axis].set(c, s.half + 0.4);
    }
  }
  const allHalves = [...simHalf[0].values(), ...simHalf[1].values()].sort((a, b) => a - b);
  const typicalHalf = allHalves.length > 0 ? allHalves[Math.floor(allHalves.length / 2)] : 7.4;
  const lineHalf: [Map<number, number>, Map<number, number>] = [
    tileWidths(xs, simHalf[0], typicalHalf),
    tileWidths(ys, simHalf[1], typicalHalf),
  ];
  const halfOf = (axis: Axis, c: number) => lineHalf[axis].get(c) ?? typicalHalf;
  const vergeOf = (axis: Axis, c: number) => halfOf(axis, c) + 1;
  const walkInnerOf = (axis: Axis, c: number) => vergeOf(axis, c) + TUNING.plantingWidth;
  const walkOuterOf = (axis: Axis, c: number) => walkInnerOf(axis, c) + TUNING.walkWidth;

  const roadHalf = typicalHalf;
  const vergeHalf = roadHalf + 1;
  const walkInner = vergeHalf + TUNING.plantingWidth;
  const walkOuter = walkInner + TUNING.walkWidth;
  const blockInset = walkOuter;
  const widestWalk = Math.max(
    walkOuter,
    ...xs.map((c) => walkOuterOf(0, c)),
    ...ys.map((c) => walkOuterOf(1, c)),
  );
  const cornerInset = Math.max(
    TUNING.cornerInset,
    widestWalk + 4,
    simDiscs.reduce((m, d) => Math.max(m, d.radius), 0) + 5,
  );

  // --- 3. street runs -----------------------------------------------------
  // Every line is trimmed back a seeded number of blocks so the outer edge of
  // the city is ragged rather than a ruler-straight wall of asphalt.
  const paved: [Map<number, Interval[]>, Map<number, Interval[]>] = [new Map(), new Map()];
  const lineSets: [number[], number[]] = [xs, ys];
  for (const axis of [0, 1] as Axis[]) {
    const crossSet = lineSets[1 - axis];
    const span = simSpans[axis];
    for (const c of lineSets[axis]) {
      const sim = span.get(c);
      // Stagger: pull each end in by 0 - 2 blocks, but never inside the sim.
      const trimLo = Math.floor(rand() * 2.6);
      const trimHi = Math.floor(rand() * 2.6);
      let lo = crossSet[Math.min(trimLo, crossSet.length - 1)];
      let hi = crossSet[Math.max(crossSet.length - 1 - trimHi, 0)];
      if (sim) {
        lo = Math.min(lo, sim.min);
        hi = Math.max(hi, sim.max);
      }
      if (hi - lo < spacing) continue;
      paved[axis].set(c, [[lo, hi]]);
    }
  }

  // A crossing is real only where both lines are paved through it. `breakHalf`
  // is how far back the sidewalk stops — far enough to clear the junction's
  // paved disc, so the corner pad can butt straight onto both sidewalks.
  // `breakX` / `breakY` are how far back from the crossing the sidewalks on the
  // y- and x-lines stop: far enough to clear the other street's pavement (and
  // the junction's paved disc), so the corner pad butts straight onto both.
  const crossings: { x: number; y: number; sim: boolean; breakX: number; breakY: number }[] = [];
  for (const x of xs) {
    const alongX = paved[0].get(x);
    if (!alongX) continue;
    for (const y of ys) {
      const alongY = paved[1].get(y);
      if (!alongY) continue;
      if (!contains(alongX, y) || !contains(alongY, x)) continue;
      let breakX = walkOuterOf(0, x);
      let breakY = walkOuterOf(1, y);
      let sim = false;
      for (const d of simDiscs) {
        if (Math.hypot(d.x - x, d.y - y) < spacing * 0.4) {
          sim = true;
          breakX = Math.max(breakX, d.radius + 1.5);
          breakY = Math.max(breakY, d.radius + 1.5);
        }
      }
      crossings.push({ x, y, sim, breakX, breakY });
    }
  }

  // Filler asphalt: the paved run minus everything the simulator draws, minus a
  // gap at each filler crossing (which gets its own disc, exactly like the sim).
  // A crossing's disc has to swallow both carriageways plus the corner sweep.
  const nodeRadiusAt = (x: number, y: number) =>
    Math.max(halfOf(0, x), halfOf(1, y)) + TUNING.nodeRadius * 0.4;
  const nodes: CityDisc[] = [];
  const streets: CityStreet[] = [];
  const detailRadius = Math.max(bounds.extent * 0.95, 520);
  for (const axis of [0, 1] as Axis[]) {
    for (const [c, runs] of paved[axis]) {
      let free = runs;
      const half = halfOf(axis, c);
      const sim = simSpans[axis].get(c);
      if (sim) free = subtract(free, sim.min, sim.max);
      // Perpendicular simulated corridors (a filler street may not cross one).
      for (const [pc, ps] of simSpans[1 - axis]) {
        if (ps.min - ps.half <= c && c <= ps.max + ps.half) {
          free = subtract(free, pc - ps.half - 1.5, pc + ps.half + 1.5);
        }
      }
      // Anything genuinely off-grid (a curved or diagonal sim road) is carved
      // out by sampling, which is general at the cost of a metre of precision.
      if (offGrid.length > 0) free = carveOffGrid(free, axis, c, half, offGrid);
      for (const cross of crossings) {
        const at = axis === 0 ? cross.y : cross.x;
        const on = axis === 0 ? cross.x : cross.y;
        if (Math.abs(on - c) > 0.5) continue;
        if (cross.sim) continue;
        const r = nodeRadiusAt(cross.x, cross.y);
        free = subtract(free, at - r, at + r);
      }
      const lanes = Math.max(1, Math.round((half - 0.4) / laneWidth));
      for (const [a, b] of prune(free, 14)) {
        streets.push({
          axis,
          c,
          a,
          b,
          half,
          lanes,
          detail:
            Math.hypot(
              (axis === 0 ? c : (a + b) / 2) - bounds.centerX,
              (axis === 0 ? (a + b) / 2 : c) - bounds.centerY,
            ) < detailRadius,
        });
      }
    }
  }
  for (const cross of crossings) {
    if (cross.sim) continue;
    nodes.push({ x: cross.x, y: cross.y, radius: nodeRadiusAt(cross.x, cross.y) });
  }

  // --- 4. sidewalks + corner pads -----------------------------------------
  // Ribbons on both flanks of every paved line, broken at each crossing so they
  // never pave across a carriageway; the corner pads close the resulting holes.
  const sidewalks: CityStreet[] = [];
  for (const axis of [0, 1] as Axis[]) {
    for (const [c, runs] of paved[axis]) {
      let free = runs;
      const inner = walkInnerOf(axis, c);
      const outer = walkOuterOf(axis, c);
      for (const cross of crossings) {
        const at = axis === 0 ? cross.y : cross.x;
        const on = axis === 0 ? cross.x : cross.y;
        if (Math.abs(on - c) > 0.5) continue;
        const back = axis === 0 ? cross.breakY : cross.breakX;
        free = subtract(free, at - back, at + back);
      }
      if (offGrid.length > 0) free = carveOffGrid(free, axis, c, outer, offGrid);
      for (const [a, b] of prune(free, 8)) {
        for (const side of [-1, 1]) {
          sidewalks.push({
            axis,
            c: c + (side * (inner + outer)) / 2,
            a,
            b,
            half: TUNING.walkWidth / 2,
            lanes: 0,
            detail: false,
          });
        }
      }
    }
  }
  // One pad per corner, filling exactly the L the two sidewalks leave.
  const corners: CityRect[] = [];
  for (const cross of crossings) {
    const innerX = walkInnerOf(0, cross.x);
    const innerY = walkInnerOf(1, cross.y);
    if (cross.breakX - innerX <= 0.2 || cross.breakY - innerY <= 0.2) continue;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        corners.push({
          x0: cross.x + sx * innerX,
          y0: cross.y + sy * innerY,
          x1: cross.x + sx * cross.breakX,
          y1: cross.y + sy * cross.breakY,
        });
      }
    }
  }

  // --- 5. blocks ----------------------------------------------------------
  interface Block {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    cx: number;
    cy: number;
    dist: number;
    /** Which of the four sides has a street to front (S, N, W, E). */
    sides: [boolean, boolean, boolean, boolean];
  }
  const blocks: Block[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const y0 = ys[j];
      const y1 = ys[j + 1];
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const dist = Math.hypot(cx - bounds.centerX, cy - bounds.centerY);
      if (dist > half) continue;
      const sides: [boolean, boolean, boolean, boolean] = [
        contains(paved[1].get(y0) ?? [], cx),
        contains(paved[1].get(y1) ?? [], cx),
        contains(paved[0].get(x0) ?? [], cy),
        contains(paved[0].get(x1) ?? [], cy),
      ];
      if (sides.filter(Boolean).length < 3) continue;
      blocks.push({ x0, y0, x1, y1, cx, cy, dist, sides });
    }
  }
  // Nearest first: the detail budget is spent where the camera actually goes.
  blocks.sort((a, b) => a.dist - b.dist || a.cx - b.cx || a.cy - b.cy);

  const buildings: BuildingSpot[] = [];
  const lots: CityRect[] = [];
  const parkBlocks: Block[] = [];
  /**
   * Spatial hash of every placed model footprint, so a candidate can be tested
   * against its real neighbours rather than against an analytically-derived
   * empty rectangle. Blocks are NOT guaranteed disjoint out in the filler grid
   * (two grid lines a couple of metres apart produce a sliver and two blocks
   * that nearly coincide), so a per-block check is not sufficient.
   */
  const OCC_CELL = 48;
  const occ = new Map<string, BuildingSpot[]>();
  const occKey = (x: number, y: number) =>
    `${Math.floor(x / OCC_CELL)}:${Math.floor(y / OCC_CELL)}`;
  const remember = (spot: BuildingSpot) => {
    const key = occKey(spot.x, spot.y);
    const bucket = occ.get(key);
    if (bucket) bucket.push(spot);
    else occ.set(key, [spot]);
  };
  /** True when a footprint of side `w` at (x, y) clears everything placed. */
  const freeAt = (x: number, y: number, w: number): boolean => {
    const cx = Math.floor(x / OCC_CELL);
    const cy = Math.floor(y / OCC_CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const o of occ.get(`${cx + dx}:${cy + dy}`) ?? []) {
          const ox = w / 2 + o.width / 2 - Math.abs(x - o.x);
          const oy = w / 2 + o.width / 2 - Math.abs(y - o.y);
          if (Math.min(ox, oy) > -1) return false;   // 1 m of daylight required
        }
      }
    }
    return true;
  };
  let modelCount = 0;
  let towerCount = 0;
  let midriseCount = 0;
  // Downtown is a RING, not a disc: the blocks the simulated streets actually
  // bound stay mid-rise, or a wall of towers hides the traffic the app exists
  // to show. The skyline starts one block out.
  const coreInner = spacing * 0.75;
  const coreRadius = Math.max(bounds.extent * 0.55, spacing * 1.9);

  for (const block of blocks) {
    // The edge of the city thins out rather than stopping at a wall.
    const fade = clamp((block.dist - half * 0.72) / (half * 0.28), 0, 1);
    if (rand() > 1 - fade * 0.52) continue;
    // Downtown land is too valuable for lawns; the further out a block is, the
    // more likely it is a park or a plot with a green yard behind the frontage.
    const outward = clamp(block.dist / half, 0, 1);
    const park = rand() < TUNING.parkChance * (0.35 + outward * 1.5);
    if (park) {
      parkBlocks.push(block);
      continue;
    }
    // Each edge is set back by ITS OWN street's pavement, so a block on a
    // three-lane avenue is shallower than one on a one-lane local.
    const ix0 = block.x0 + walkOuterOf(0, block.x0);
    const ix1 = block.x1 - walkOuterOf(0, block.x1);
    const iy0 = block.y0 + walkOuterOf(1, block.y0);
    const iy1 = block.y1 - walkOuterOf(1, block.y1);
    if (ix1 - ix0 < 24 || iy1 - iy0 < 24) continue;

    const useModels = modelCount < TUNING.modelBudget;
    const green = rand() < TUNING.greenInteriorChance * (0.3 + outward * 1.6);
    if (!green) lots.push({ x0: ix0, y0: iy0, x1: ix1, y1: iy1 });

    // Frontage step grows with distance: near the camera a block is a dozen
    // narrow shopfronts, on the horizon it is three fat slabs.
    const far = clamp(block.dist / half, 0, 1);
    const step = 19 + far * 14;
    const heightFalloff = 1 - far * 0.45;

    // Past the model budget a block stops being rows-around-a-courtyard and
    // becomes a solid raft of merged boxes covering its whole interior. Nothing
    // out there is closer than half a kilometre, and a block that is only built
    // around its rim reads from above as a brown field with a fence.
    if (!useModels) {
      const pitch = 30;
      // Blocks also empty out as they approach the edge, so the city thins in
      // two ways at once — fewer blocks built, and less on each of them.
      const density = (0.76 + rand() * 0.24) * (1 - fade * 0.4);
      for (let by = iy0 + pitch / 2; by <= iy1 - pitch / 2 + 1; by += pitch) {
        for (let bx = ix0 + pitch / 2; bx <= ix1 - pitch / 2 + 1; bx += pitch) {
          if (rand() > density) continue;
          const roll = rand();
          buildings.push({
            x: bx + (rand() - 0.5) * 7,
            y: by + (rand() - 0.5) * 7,
            rot: 0,
            width: pitch * (0.6 + rand() * 0.32),
            height: (10 + roll * roll * 34) * heightFalloff,
            tier: "massing",
            tint: 0.74 + rand() * 0.46,
            pick: rand(),
          });
        }
      }
      continue;
    }

    // A plot is square (the shells are footprint-normalized), so its frontage is
    // also its depth. `rowInset` is therefore how far a row has to start in from
    // the block corner to clear BOTH the junction and the full depth of the row
    // running up the perpendicular side — that is what stops the four rows
    // knotting together at the corners.
    const interior = Math.min(ix1 - ix0, iy1 - iy0);
    // How far in from the block's interior corner a frontage row has to start
    // to clear the junction. Measured from the interior edge, so it shrinks on a
    // narrow street where the pavement already ate less of the block.
    const junctionKeep = cornerInset - Math.min(walkOuterOf(0, block.x0), walkOuterOf(1, block.y0));
    const maxWidth = Math.min(step, (interior - 2 * junctionKeep) / 3.4, 40);
    if (maxWidth < 8) continue;
    const rowInset = Math.max(junctionKeep, TUNING.setback + maxWidth + 4);
    const blockStart = buildings.length;
    for (let side = 0; side < 4; side++) {
      if (!block.sides[side]) continue;
      const horizontal = side < 2;
      const from = (horizontal ? ix0 : iy0) + rowInset;
      const to = (horizontal ? ix1 : iy1) - rowInset;
      const runLength = to - from;
      if (runLength < maxWidth * 0.8) continue;
      const slots = Math.max(1, Math.round(runLength / step));
      const pitch = runLength / slots;
      for (let k = 0; k < slots; k++) {
        const along = from + (k + 0.5) * pitch;
        const width = Math.min(pitch * (0.8 + rand() * 0.17), maxWidth);
        const depth = width;
        const front = side === 0 ? iy0 : side === 1 ? iy1 : side === 2 ? ix0 : ix1;
        const inward = side === 0 || side === 2 ? 1 : -1;
        const centre = front + inward * (TUNING.setback + depth / 2);
        const x = horizontal ? along : centre;
        const y = horizontal ? centre : along;
        // +Z toward the street: south 0, north PI, west -PI/2, east +PI/2.
        const rot = side === 0 ? 0 : side === 1 ? Math.PI : side === 2 ? -Math.PI / 2 : Math.PI / 2;

        let tier: BuildingTier;
        let height: number;
        if (
          block.dist > coreInner &&
          block.dist < coreRadius &&
          towerCount < TUNING.towerBudget &&
          rand() < TUNING.towerChance
        ) {
          tier = "tower";
          height = 38 + rand() * 40;
          towerCount++;
        } else if (midriseCount < TUNING.midriseBudget) {
          tier = "midrise";
          height = (15 + rand() * 27) * heightFalloff + (block.dist < coreRadius ? 10 : 0);
          midriseCount++;
        } else {
          tier = "lowdetail";
          height = (11 + rand() * 23) * heightFalloff;
        }
        modelCount++;
        // The decimated shells are near-white out of the kit; without a wider,
        // darker tint spread the outer city reads as a field of sugar cubes.
        const spread = tier === "lowdetail" ? 0.6 + rand() * 0.55 : 0.78 + rand() * 0.44;
        buildings.push({
          x,
          y,
          rot,
          width,
          height,
          tier,
          tint: spread,
          pick: rand(),
        });
      }
    }

    // Courtyard infill: the four frontage rows leave a hole in the middle of
    // every block, which is invisible from the street and glaring from above.
    // Fill the near ones through with a lower, cheaper rank so a block reads as
    // built rather than as a fence around a yard. Decimated shells only — this
    // is the bulk of the added instances and none of it is ever the subject.
    for (const spot of buildings.slice(blockStart)) remember(spot);

    // Block interiors: lock-ups, sheds and parking structures behind the street
    // wall, so a block seen from above is not a ring of facades around an empty
    // courtyard.
    const shedWidth = 24;
    const shedPitch = TUNING.shedPitch;
    const shedMargin = TUNING.setback + maxWidth + 8 + shedWidth / 2;
    if (!green && ix1 - ix0 > shedMargin * 2 + 12 && iy1 - iy0 > shedMargin * 2 + 12) {
      for (let sy = iy0 + shedMargin; sy <= iy1 - shedMargin; sy += shedPitch) {
        for (let sx = ix0 + shedMargin; sx <= ix1 - shedMargin; sx += shedPitch) {
          if (rand() > TUNING.shedChance) continue;
          const sw = shedWidth * (0.58 + rand() * 0.42);
          const px = sx + (rand() - 0.5) * 12;
          const py = sy + (rand() - 0.5) * 12;
          // Jitter plus a coarse pitch means neighbours (and, where two filler
          // blocks nearly coincide, another block's frontage) can collide;
          // check what is actually there rather than trusting the margins.
          if (!freeAt(px, py, sw)) continue;
          const spot: BuildingSpot = {
            x: px,
            y: py,
            rot: Math.round(rand() * 4) * (Math.PI / 2),
            width: sw,
            height: (6 + rand() * 7) * heightFalloff,
            tier: "lowdetail",
            tint: 0.6 + rand() * 0.5,
            pick: rand(),
          };
          buildings.push(spot);
          remember(spot);
          modelCount++;
        }
      }
    }
  }

  // --- 6. greenery --------------------------------------------------------
  const trees: TreeSpot[] = [];
  const tree = (x: number, y: number, height: number) => {
    const warm = rand();
    trees.push({
      x,
      y,
      height,
      rot: rand() * Math.PI * 2,
      tintR: 0.78 + warm * 0.5,
      tintG: 0.92 + warm * 0.16,
      tintB: 1.16 - warm * 0.45,
    });
  };
  // Park blocks, planted over their whole interior.
  let parkTrees = 0;
  for (const block of parkBlocks) {
    if (parkTrees >= TUNING.maxParkTrees) break;
    const px0 = block.x0 + walkOuterOf(0, block.x0) + 4;
    const px1 = block.x1 - walkOuterOf(0, block.x1) - 4;
    const py0 = block.y0 + walkOuterOf(1, block.y0) + 4;
    const py1 = block.y1 - walkOuterOf(1, block.y1) - 4;
    for (let py = py0; py <= py1 && parkTrees < TUNING.maxParkTrees; py += 16) {
      for (let px = px0; px <= px1 && parkTrees < TUNING.maxParkTrees; px += 16) {
        if (rand() > 0.72) continue;
        tree(px + (rand() - 0.5) * 10, py + (rand() - 0.5) * 10, 6.5 + rand() * 4.5);
        parkTrees++;
      }
    }
  }
  // Street trees in the planting strip, near the middle of the map only.
  const plantOffsetOf = (axis: Axis, c: number) => (vergeOf(axis, c) + walkInnerOf(axis, c)) / 2;
  const leafyRadius = Math.max(bounds.extent * 1.1, 620);
  let streetTrees = 0;
  outer: for (const axis of [0, 1] as Axis[]) {
    for (const [c, runs] of paved[axis]) {
      for (const [a, b] of runs) {
        for (let t = a + 16; t < b - 16; t += 23) {
          if (streetTrees >= TUNING.maxStreetTrees) break outer;
          if (rand() > 0.5) continue;
          const x = axis === 0 ? c : t;
          const y = axis === 0 ? t : c;
          if (Math.hypot(x - bounds.centerX, y - bounds.centerY) > leafyRadius) continue;
          let nearCrossing = false;
          for (const cross of crossings) {
            if (Math.abs(cross.x - x) < cornerInset && Math.abs(cross.y - y) < cornerInset) {
              nearCrossing = true;
              break;
            }
          }
          if (nearCrossing) continue;
          const side = rand() < 0.5 ? -1 : 1;
          const offset = side * plantOffsetOf(axis, c);
          tree(axis === 0 ? c + offset : x, axis === 0 ? y : c + offset, 6 + rand() * 3.5);
          streetTrees++;
        }
      }
    }
  }

  return {
    bounds,
    half,
    spacing,
    laneWidth,
    roadHalf,
    vergeHalf,
    walkInner,
    walkOuter,
    blockInset,
    streets,
    nodes,
    sidewalks,
    corners,
    lots,
    buildings,
    trees,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function widen(map: Map<number, SimSpan>, key: number, lo: number, hi: number, half: number): void {
  const cur = map.get(key);
  if (!cur) {
    map.set(key, { min: lo, max: hi, half });
    return;
  }
  cur.min = Math.min(cur.min, lo);
  cur.max = Math.max(cur.max, hi);
  cur.half = Math.max(cur.half, half);
}

/**
 * Give every grid line a carriageway half-width. Lines the simulator paves keep
 * their own; lines beyond the simulated block mirror the pattern back inward,
 * so a network of alternating avenues and locals tiles that rhythm out to the
 * horizon instead of flattening into one width.
 */
function tileWidths(
  lines: readonly number[],
  known: ReadonlyMap<number, number>,
  fallback: number,
): Map<number, number> {
  const out = new Map<number, number>();
  const seen: number[] = [];
  lines.forEach((c, i) => {
    if (known.has(c)) seen.push(i);
  });
  if (seen.length === 0) {
    for (const c of lines) out.set(c, fallback);
    return out;
  }
  const lo = seen[0];
  const hi = seen[seen.length - 1];
  const period = Math.max(hi - lo, 1);
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    if (i < lo) j = lo + ((lo - i) % period);
    else if (i > hi) j = hi - ((i - hi) % period);
    out.set(lines[i], known.get(lines[j]) ?? fallback);
  }
  return out;
}

/** Grow a sorted coordinate set outward by `step` until it spans [lo, hi]. */
function extend(base: readonly number[], step: number, lo: number, hi: number): number[] {
  const out = base.length > 0 ? [...base] : [0];
  let guard = 0;
  while (out[0] > lo && guard++ < 200) out.unshift(out[0] - step);
  guard = 0;
  while (out[out.length - 1] < hi && guard++ < 200) out.push(out[out.length - 1] + step);
  return out;
}

/**
 * Carve the footprint of non-axis-aligned simulated roads out of a line's free
 * intervals, by walking the line and testing a few points across its width.
 * Only networks with curved or diagonal links ever reach this.
 */
function carveOffGrid(
  free: readonly Interval[],
  axis: Axis,
  c: number,
  halfWidth: number,
  segments: readonly Segment[],
): Interval[] {
  const keepout = 2.6;
  const reach = halfWidth + keepout;
  let out = free.slice();
  for (const [a, b] of free) {
    let blockStart: number | null = null;
    for (let t = a; t <= b + 2; t += 2) {
      const x = axis === 0 ? c : t;
      const y = axis === 0 ? t : c;
      let hit = false;
      for (const s of segments) {
        if (x < s.minX - reach || x > s.maxX + reach || y < s.minY - reach || y > s.maxY + reach) {
          continue;
        }
        if (crossesBand(x, y, axis, halfWidth, s, keepout)) {
          hit = true;
          break;
        }
      }
      if (hit && blockStart === null) blockStart = t;
      if (!hit && blockStart !== null) {
        out = subtract(out, blockStart - 2, t);
        blockStart = null;
      }
    }
    if (blockStart !== null) out = subtract(out, blockStart - 2, b + 2);
  }
  return out;
}

/** Does the street's cross-section at (x, y) come within `keepout` of `s`? */
function crossesBand(
  x: number,
  y: number,
  axis: Axis,
  halfWidth: number,
  s: Segment,
  keepout: number,
): boolean {
  for (let k = -1; k <= 1; k += 0.5) {
    const px = axis === 0 ? x + k * halfWidth : x;
    const py = axis === 0 ? y : y + k * halfWidth;
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - s.x0) * dx + (py - s.y0) * dy) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = s.x0 + dx * t;
    const qy = s.y0 + dy * t;
    if ((px - qx) * (px - qx) + (py - qy) * (py - qy) < keepout * keepout) return true;
  }
  return false;
}
