import { describe, expect, it } from "vitest";

import { hashSeed, isClear, laneSegments, mulberry32, nodeDiscs } from "./scatter";
import { planCity, type CityStreet } from "./city";
import { networkBounds } from "./roads";
import type { TrajMeta } from "../traj";

/**
 * A `blocks` x `blocks` grid of arterials at `spacing` metres — the shape every
 * trafficlab network takes. Lanes are laid out exactly like the simulator's:
 * `lanesFor(i)` per direction at 1.75 + 3.5k from the centreline, stopping
 * `stub` metres short of each intersection so the paved disc can fill the gap.
 * `lanesFor` lets a fixture carry a real street hierarchy (city.traj mixes
 * 1-, 2- and 3-lane corridors), which the filler grid has to reproduce.
 */
function gridNetwork(
  name: string,
  blocks: number,
  spacing: number,
  lanesFor: (index: number) => number = () => 2,
): TrajMeta {
  const coords = Array.from({ length: blocks }, (_, i) => i * spacing);
  const lanes: TrajMeta["network"]["lanes"] = [];
  const nodes: TrajMeta["network"]["nodes"] = [];
  const links: TrajMeta["network"]["links"] = [];
  let laneId = 0;
  let nodeId = 0;
  const nodeAt = new Map<string, number>();
  for (const y of coords) {
    for (const x of coords) {
      nodeAt.set(`${x}:${y}`, nodeId);
      nodes.push({ id: nodeId++, x, y, type: "intersection" });
    }
  }
  const stub = 13;
  /** One carriageway of `lanes` lanes from a to b. */
  const carriageway = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    from: number,
    to: number,
    laneCount = 2,
  ) => {
    const len = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const ids: number[] = [];
    for (let n = 0; n < laneCount; n++) {
      const offset = -1.75 - n * 3.5;
      const px = -uy * offset;
      const py = ux * offset;
      lanes.push({
        id: laneId,
        link: links.length,
        index: ids.length,
        width: 3.5,
        speed_limit: 13.9,
        polyline: [
          [ax + ux * stub + px, ay + uy * stub + py],
          [bx - ux * stub + px, by - uy * stub + py],
        ],
      });
      ids.push(laneId++);
    }
    links.push({ id: links.length, from_node: from, to_node: to, lanes: ids });
  };
  const street = (ax: number, ay: number, bx: number, by: number, laneCount: number) => {
    const from = nodeAt.get(`${ax}:${ay}`)!;
    const to = nodeAt.get(`${bx}:${by}`)!;
    carriageway(ax, ay, bx, by, from, to, laneCount);
    carriageway(bx, by, ax, ay, to, from, laneCount);
  };
  coords.forEach((y, yi) => {
    for (let i = 0; i + 1 < coords.length; i++) {
      street(coords[i], y, coords[i + 1], y, lanesFor(yi));
    }
  });
  coords.forEach((x, xi) => {
    for (let i = 0; i + 1 < coords.length; i++) {
      street(x, coords[i], x, coords[i + 1], lanesFor(xi));
    }
  });
  // Boundary stubs: where traffic enters and leaves, and where the city has to
  // pick the network up and carry it onward.
  const span = (blocks - 1) * spacing;
  const stubLength = 150;
  const boundary = (x: number, y: number, ix: number, iy: number, laneCount: number) => {
    const id = nodeId++;
    nodes.push({ id, x, y, type: "boundary" });
    const inner = nodeAt.get(`${ix}:${iy}`)!;
    carriageway(x, y, ix, iy, id, inner, laneCount);
    carriageway(ix, iy, x, y, inner, id, laneCount);
  };
  coords.forEach((c, i) => {
    boundary(c, -stubLength, c, 0, lanesFor(i));
    boundary(c, span + stubLength, c, span, lanesFor(i));
    boundary(-stubLength, c, 0, c, lanesFor(i));
    boundary(span + stubLength, c, span, c, lanesFor(i));
  });
  return {
    format_version: 1,
    dt: 0.5,
    seed: 1,
    policy: "test",
    network_name: name,
    network: { nodes, links, lanes, connections: [], intersections: [] },
    intersections_order: [],
    approaches: [],
    metrics: [],
  } as unknown as TrajMeta;
}

/**
 * Bolt off-street parking onto a grid network the way the simulator does: every
 * street link is split at driveway points by an uncontrolled "junction" node,
 * and a short perpendicular single-lane driveway runs from there to a "parking"
 * node. Driveways sit MID-BLOCK and run across the street's axis, which is
 * exactly what fooled the planner into treating them as streets.
 */
function withParking(meta: TrajMeta, spacing: number): TrajMeta {
  const net = meta.network as unknown as {
    nodes: { id: number; x: number; y: number; type: string }[];
    links: { id: number; from_node: number; to_node: number; lanes: number[] }[];
    lanes: { id: number; link: number; index: number; width: number; speed_limit: number; polyline: number[][] }[];
  };
  let nodeId = Math.max(...net.nodes.map((n) => n.id)) + 1;
  let linkId = Math.max(...net.links.map((l) => l.id)) + 1;
  let laneId = Math.max(...net.lanes.map((l) => l.id)) + 1;

  // One driveway per street centreline crossing, offset to mid-block.
  const coords: number[] = [];
  for (const n of net.nodes) if (!coords.includes(n.x)) coords.push(n.x);
  coords.sort((a, b) => a - b);

  for (const cx of coords) {
    for (let i = 0; i + 1 < coords.length; i++) {
      const my = (coords[i] + coords[i + 1]) / 2;      // mid-block along y
      const junction = nodeId++;
      const parking = nodeId++;
      net.nodes.push({ id: junction, x: cx, y: my, type: "junction" });
      net.nodes.push({ id: parking, x: cx + 14 + spacing * 0.02, y: my, type: "parking" });
      const lane = laneId++;
      net.lanes.push({
        id: lane,
        link: linkId,
        index: 0,
        width: 3.5,
        speed_limit: 5.6,
        polyline: [
          [cx + 8, my],
          [cx + 8 + 14, my],
        ],
      });
      net.links.push({ id: linkId++, from_node: junction, to_node: parking, lanes: [lane] });
    }
  }
  return meta;
}

/** Distance from a point to the nearest lane polyline. */
function distanceToLanes(meta: TrajMeta, x: number, y: number): number {
  let best = Infinity;
  for (const lane of meta.network.lanes) {
    const pts = lane.polyline;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 0 ? ((x - x0) * dx + (y - y0) * dy) / lenSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      best = Math.min(best, Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t)));
    }
  }
  return best;
}

/** Distance from `v` to the nearest multiple of `pitch` (a street centreline). */
function offGrid(v: number, pitch = 200): number {
  const m = ((v % pitch) + pitch) % pitch;
  return Math.min(m, pitch - m);
}

/** Sample points down the centreline of a filler street. */
function samples(street: CityStreet, step = 4): [number, number][] {
  const out: [number, number][] = [];
  for (let t = street.a; t <= street.b; t += step) {
    out.push(street.axis === 0 ? [street.c, t] : [t, street.c]);
  }
  return out;
}

describe("mulberry32 / hashSeed", () => {
  it("is deterministic and stays in [0, 1)", () => {
    const a = mulberry32(hashSeed("grid2x2"));
    const b = mulberry32(hashSeed("grid2x2"));
    for (let i = 0; i < 50; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("gives different networks different streams", () => {
    expect(hashSeed("grid2x2")).not.toBe(hashSeed("grid4x4"));
    expect(mulberry32(hashSeed("grid2x2"))()).not.toBe(mulberry32(hashSeed("grid4x4"))());
  });
});

describe("planCity", () => {
  const grid = gridNetwork("grid2x2", 3, 200);
  const plan = planCity(grid);

  it("is deterministic for the same network name", () => {
    const other = planCity(gridNetwork("grid2x2", 3, 200));
    expect(other.buildings).toEqual(plan.buildings);
    expect(other.trees).toEqual(plan.trees);
    expect(other.streets).toEqual(plan.streets);
    expect(other.lots).toEqual(plan.lots);
  });

  it("continues the network out to several times its own extent", () => {
    const bounds = networkBounds(grid);
    expect(plan.half).toBeGreaterThan(bounds.extent * 1.5);
    let reach = 0;
    for (const street of plan.streets) {
      for (const [x, y] of samples(street, 25)) {
        reach = Math.max(reach, Math.hypot(x - bounds.centerX, y - bounds.centerY));
      }
    }
    // Filler asphalt reaches the far ring, not just past the boundary stubs.
    expect(reach).toBeGreaterThan(bounds.extent * 1.4);
  });

  it("picks up the sim network's own axes and spacing", () => {
    expect(plan.spacing).toBe(200);
    for (const street of plan.streets) {
      expect(Math.abs(street.c % 200)).toBeLessThan(1e-6);
    }
  });

  it("keeps every filler street off the simulated road footprint", () => {
    // The whole point of the clip: filler asphalt must never overlap a lane's
    // tarmac or an intersection disc, or the two z-fight all over the network.
    // Butting end-to-end at a boundary stub is exactly what we *do* want, so the
    // test is rectangle overlap, not point clearance.
    const segments = laneSegments(grid);
    const discs = nodeDiscs(grid);
    const laneHalf = 3.5 / 2 + 0.4;
    const violations: string[] = [];
    for (const street of plan.streets) {
      for (const [x, y] of samples(street, 3)) {
        for (const k of [-1, -0.5, 0, 0.5, 1]) {
          const px = street.axis === 0 ? x + k * plan.roadHalf : x;
          const py = street.axis === 0 ? y : y + k * plan.roadHalf;
          for (const s of segments) {
            if (
              px < s.minX - laneHalf ||
              px > s.maxX + laneHalf ||
              py < s.minY - laneHalf ||
              py > s.maxY + laneHalf
            ) {
              continue;
            }
            const dx = s.x1 - s.x0;
            const dy = s.y1 - s.y0;
            const len = Math.hypot(dx, dy) || 1;
            const along = ((px - s.x0) * dx + (py - s.y0) * dy) / len;
            const perp = Math.abs((px - s.x0) * -dy + (py - s.y0) * dx) / len;
            if (perp < laneHalf - 1e-6 && along > 1e-6 && along < len - 1e-6) {
              violations.push(`lane @ ${px.toFixed(1)},${py.toFixed(1)}`);
            }
          }
          for (const d of discs) {
            if (Math.hypot(px - d.x, py - d.y) < d.radius) {
              violations.push(`disc @ ${px.toFixed(1)},${py.toFixed(1)}`);
            }
          }
        }
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // …and the clip is not just "delete everything near the sim": the network's
    // own streets still have filler running off both ends of every stub.
    expect(isClear(0, 600, segments, discs, 2)).toBe(true);
  });

  it("joins the boundary stubs instead of leaving a gap of lawn", () => {
    // grid2x2's stubs run out to y = -137 on the x = 0 street; the filler run
    // on that line has to start within a couple of metres of the stub's end.
    const onLine = plan.streets.filter((s) => s.axis === 0 && s.c === 0);
    expect(onLine.length).toBeGreaterThan(0);
    const southern = onLine.filter((s) => s.b <= 0).sort((a, b) => b.b - a.b)[0];
    expect(southern).toBeDefined();
    expect(southern.b).toBeGreaterThan(-141);
    expect(southern.b).toBeLessThanOrEqual(-137);
  });

  it("leaves a gap and a disc at every filler crossing", () => {
    expect(plan.nodes.length).toBeGreaterThan(20);
    // A node can only foul a street that runs along its own grid line, so index
    // the nodes by line instead of testing every pair.
    const byLine = [new Map<number, number[]>(), new Map<number, number[]>()];
    for (const node of plan.nodes) {
      for (const axis of [0, 1]) {
        const c = axis === 0 ? node.x : node.y;
        const at = axis === 0 ? node.y : node.x;
        const bucket = byLine[axis].get(c) ?? [];
        bucket.push(at);
        byLine[axis].set(c, bucket);
      }
    }
    for (const street of plan.streets) {
      for (const at of byLine[street.axis].get(street.c) ?? []) {
        const gap = Math.min(Math.abs(street.a - at), Math.abs(street.b - at));
        const spans = at > street.a && at < street.b;
        expect(spans).toBe(false);
        expect(gap).toBeGreaterThan(plan.roadHalf);
      }
    }
  });

  it("stands buildings in rows along the block frontages", () => {
    expect(plan.buildings.length).toBeGreaterThan(300);
    let fronting = 0;
    for (const b of plan.buildings) {
      // Rotation is snapped to a quarter turn: every facade faces its street.
      const quarter = Math.round((b.rot / (Math.PI / 2)) * 2) / 2;
      expect(Math.abs(quarter - Math.round(quarter))).toBeLessThan(1e-9);
      if (Math.min(offGrid(b.x), offGrid(b.y)) < 60) fronting++;
    }
    // The great majority sit within 60 m of a street, not adrift mid-block.
    expect(fronting).toBeGreaterThan(plan.buildings.length * 0.75);
  });

  it("keeps every building clear of the simulated carriageway", () => {
    for (const b of plan.buildings) {
      expect(distanceToLanes(grid, b.x, b.y)).toBeGreaterThan(plan.blockInset - 6);
    }
  });

  // Regression: the simulator's off-street parking feature adds "junction" and
  // "parking" nodes plus mid-block perpendicular driveway links. The planner
  // predated them and mistook driveways for streets, which wrecked the grid
  // derivation — sparse blocks, stray paved discs, buildings clustered in block
  // centres instead of fronting streets.
  describe("parking-enabled networks", () => {
    const plain = planCity(gridNetwork("parkcity", 3, 200));
    const parked = planCity(withParking(gridNetwork("parkcity", 3, 200), 200));

    it("does not let driveways corrupt the derived street pitch", () => {
      // The core of the regression: a mid-block perpendicular stub is not a
      // street and must not become one. (`half` and the street count DO move a
      // little, because garages sit outside the junctions and genuinely enlarge
      // the network's bounding box — that part is correct.)
      expect(parked.spacing).toBeCloseTo(plain.spacing, 6);
      expect(parked.laneWidth).toBeCloseTo(plain.laneWidth, 6);
      expect(parked.roadHalf).toBeCloseTo(plain.roadHalf, 6);
    });

    it("still builds a full city rather than thinning out", () => {
      // The visible symptom was blocks emptying out; the count should track the
      // slightly larger extent, not collapse.
      const ratio = parked.buildings.length / plain.buildings.length;
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.2);
    });

    it("keeps buildings off the driveways and garages", () => {
      const meta = withParking(gridNetwork("parkcity", 3, 200), 200);
      for (const b of parked.buildings) {
        expect(distanceToLanes(meta, b.x, b.y)).toBeGreaterThan(b.width / 2 - 0.5);
      }
    });

    it("never overlaps two building footprints with parking present", () => {
      // Same cheap grid broadphase as the no-parking case; the pairwise loop is
      // far too slow at this instance count.
      const cell = new Map<string, { x: number; y: number; r: number }[]>();
      for (const b of parked.buildings) {
        if (b.tier === "massing") continue;
        const r = b.width / 2;
        const cx = Math.round(b.x / 40);
        const cy = Math.round(b.y / 40);
        for (const dx of [-1, 0, 1]) {
          for (const dy of [-1, 0, 1]) {
            for (const other of cell.get(`${cx + dx}:${cy + dy}`) ?? []) {
              const ox = r + other.r - Math.abs(b.x - other.x);
              const oy = r + other.r - Math.abs(b.y - other.y);
              expect(Math.min(ox, oy)).toBeLessThan(1.5);
            }
          }
        }
        const bucket = cell.get(`${cx}:${cy}`) ?? [];
        bucket.push({ x: b.x, y: b.y, r });
        cell.set(`${cx}:${cy}`, bucket);
      }
    });
  });

  it("never overlaps two building footprints", () => {
    // Cheap grid broadphase: shoulder-to-shoulder is fine, interpenetrating is
    // not. The horizon massing is exempt — those boxes are merged into one mesh
    // and are *meant* to fuse into a solid raft.
    const cell = new Map<string, { x: number; y: number; r: number }[]>();
    for (const b of plan.buildings) {
      if (b.tier === "massing") continue;
      const r = b.width / 2;
      const key = `${Math.round(b.x / 40)}:${Math.round(b.y / 40)}`;
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          const near = cell.get(`${Math.round(b.x / 40) + dx}:${Math.round(b.y / 40) + dy}`) ?? [];
          for (const other of near) {
            const overlapX = r + other.r - Math.abs(b.x - other.x);
            const overlapY = r + other.r - Math.abs(b.y - other.y);
            expect(Math.min(overlapX, overlapY)).toBeLessThan(1.5);
          }
        }
      }
      const bucket = cell.get(key) ?? [];
      bucket.push({ x: b.x, y: b.y, r });
      cell.set(key, bucket);
    }
  });

  it("puts the tall models downtown and the cheap ones on the horizon", () => {
    // A network big enough to run past the model budget, so all four tiers exist.
    const big = gridNetwork("grid4x4", 5, 200);
    const plan = planCity(big);
    const bounds = networkBounds(big);
    const towers = plan.buildings.filter((b) => b.tier === "tower");
    const massing = plan.buildings.filter((b) => b.tier === "massing");
    expect(towers.length).toBeGreaterThan(10);
    expect(massing.length).toBeGreaterThan(50);
    // How far out each tier reaches (90th percentile). A mean would be the wrong
    // stat: `lowdetail` also fills the courtyards of the innermost blocks, and
    // towers deliberately skip the very centre so they never hide the traffic.
    const reach = (tier: string) => {
      const d = plan.buildings
        .filter((b) => b.tier === tier)
        .map((b) => Math.hypot(b.x - bounds.centerX, b.y - bounds.centerY))
        .sort((a, b) => a - b);
      return d[Math.floor(d.length * 0.9)] ?? 0;
    };
    expect(reach("midrise")).toBeLessThan(reach("lowdetail"));
    expect(reach("lowdetail")).toBeLessThan(reach("massing"));
    // Towers are a downtown ring: never out in the suburbs, and never on the
    // blocks the simulated streets bound, where they would hide the traffic.
    const towerDist = towers.map((t) => Math.hypot(t.x - bounds.centerX, t.y - bounds.centerY));
    expect(Math.max(...towerDist)).toBeLessThan(plan.half * 0.45);
    expect(Math.min(...towerDist)).toBeGreaterThan(plan.spacing * 0.5);
    for (const t of towers) expect(t.height).toBeGreaterThan(35);
  });

  it("thins out towards the city edge instead of stopping at a wall", () => {
    const bounds = networkBounds(grid);
    // Built blocks per unit area: the outer ring has to be visibly sparser, or
    // the city ends at a wall of buildings instead of dissolving into the haze.
    const ring = (lo: number, hi: number) =>
      plan.lots.filter((l) => {
        const d = Math.hypot((l.x0 + l.x1) / 2 - bounds.centerX, (l.y0 + l.y1) / 2 - bounds.centerY);
        return d >= lo * plan.half && d < hi * plan.half;
      }).length;
    const inner = ring(0.4, 0.7) / (0.7 * 0.7 - 0.4 * 0.4);
    const outer = ring(0.85, 1.0) / (1.0 - 0.85 * 0.85);
    expect(inner).toBeGreaterThan(0);
    expect(outer).toBeLessThan(inner * 0.6);
  });

  it("paves sidewalks and block interiors, and keeps some blocks green", () => {
    expect(plan.sidewalks.length).toBeGreaterThan(50);
    expect(plan.corners.length).toBeGreaterThan(50);
    expect(plan.lots.length).toBeGreaterThan(20);
    // Sidewalks sit outside the verge and inside the block frontage.
    for (const walk of plan.sidewalks) {
      const offset = offGrid(walk.c);
      expect(offset).toBeGreaterThan(plan.vergeHalf - 1e-6);
      expect(offset).toBeLessThan(plan.walkOuter + 1e-6);
    }
    // Parks: trees that are nowhere near a street.
    expect(plan.trees.length).toBeGreaterThan(120);
    const parkTrees = plan.trees.filter((t) => distanceToLanes(grid, t.x, t.y) > 60);
    expect(parkTrees.length).toBeGreaterThan(20);
  });

  it("keeps every tree off the carriageway", () => {
    // Street trees live in the planting strip between kerb and sidewalk, so the
    // bar is "off the tarmac", not "off the street".
    for (const t of plan.trees) {
      expect(distanceToLanes(grid, t.x, t.y)).toBeGreaterThan(3);
      expect(Math.min(offGrid(t.x), offGrid(t.y))).toBeGreaterThan(plan.roadHalf - 1e-6);
    }
  });

  it("scales the city with the network it wraps", () => {
    const big = planCity(gridNetwork("grid4x4", 5, 200));
    expect(big.half).toBeGreaterThan(plan.half);
    expect(big.buildings.length).toBeGreaterThan(plan.buildings.length);
  });

  it("carries a mixed street hierarchy outward instead of flattening it", () => {
    // city.traj has 1-, 2- and 3-lane corridors. A filler street continuing a
    // three-lane avenue has to BE three lanes wide, and the alternation has to
    // keep going past the last simulated intersection.
    const mixed = planCity(gridNetwork("mixed", 5, 220, (i) => [1, 3, 2, 3, 1][i]));
    const widthsOn = (axis: 0 | 1, c: number) =>
      new Set(mixed.streets.filter((s) => s.axis === axis && s.c === c).map((s) => s.half));
    // The x = 220 line is a 3-lane avenue in the sim; its continuations match.
    expect([...widthsOn(0, 220)]).toEqual([3 * 3.5 + 0.4]);
    expect([...widthsOn(0, 0)]).toEqual([1 * 3.5 + 0.4]);
    // Beyond the network the pattern is mirrored back, so the far city still has
    // wide roads and narrow ones rather than one uniform width.
    const outer = new Set(
      mixed.streets.filter((s) => s.axis === 0 && s.c > 880).map((s) => Math.round(s.half)),
    );
    expect(outer.size).toBeGreaterThan(1);
    // Lane counts follow, so the paint is right on every one of them.
    for (const street of mixed.streets) {
      expect(street.lanes).toBe(Math.round((street.half - 0.4) / 3.5));
    }
    // Wider streets push their blocks further back.
    const wide = mixed.buildings.filter((b) => Math.abs(b.y - 220) < 60 && b.y > 220);
    const narrow = mixed.buildings.filter((b) => Math.abs(b.y - 0) < 60 && b.y > 0);
    expect(Math.min(...wide.map((b) => b.y - 220))).toBeGreaterThan(
      Math.min(...narrow.map((b) => b.y)),
    );
  });

  it("survives a network with no lanes at all", () => {
    const empty = gridNetwork("empty", 1, 0);
    empty.network.lanes = [];
    empty.network.nodes = [];
    const bare = planCity(empty);
    expect(bare.streets).toHaveLength(0);
    expect(bare.buildings).toHaveLength(0);
    expect(bare.trees).toHaveLength(0);
  });
});
