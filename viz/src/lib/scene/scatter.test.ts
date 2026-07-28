import { describe, expect, it } from "vitest";

import { hashSeed, mulberry32, scatterEnvironment } from "./scatter";
import { networkBounds } from "./roads";
import type { TrajMeta } from "../traj";

/**
 * A `size` x `size` grid of arterials, `blocks` streets each way — the shape
 * every trafficlab network takes. Lanes run the full length of each street.
 */
function gridNetwork(name: string, blocks: number, spacing: number): TrajMeta {
  const coords = Array.from({ length: blocks }, (_, i) => i * spacing);
  const lanes: TrajMeta["network"]["lanes"] = [];
  const nodes: TrajMeta["network"]["nodes"] = [];
  let laneId = 0;
  let nodeId = 0;
  for (const y of coords) {
    for (const x of coords) {
      nodes.push({ id: nodeId++, x, y, type: "intersection" });
    }
  }
  const span = (blocks - 1) * spacing;
  for (const y of coords) {
    lanes.push({
      id: laneId++,
      link: 0,
      index: 0,
      width: 3.5,
      speed_limit: 13.9,
      polyline: [
        [0, y],
        [span, y],
      ],
    });
  }
  for (const x of coords) {
    lanes.push({
      id: laneId++,
      link: 0,
      index: 0,
      width: 3.5,
      speed_limit: 13.9,
      polyline: [
        [x, 0],
        [x, span],
      ],
    });
  }
  return {
    format_version: 1,
    dt: 0.5,
    seed: 1,
    policy: "test",
    network_name: name,
    network: { nodes, links: [], lanes, connections: [], intersections: [] },
    intersections_order: [],
    approaches: [],
    metrics: [],
  } as unknown as TrajMeta;
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

describe("scatterEnvironment", () => {
  const grid = gridNetwork("grid2x2", 3, 200);

  it("is deterministic for the same network name", () => {
    const a = scatterEnvironment(grid);
    const b = scatterEnvironment(gridNetwork("grid2x2", 3, 200));
    expect(a.trees).toEqual(b.trees);
    expect(a.pads).toEqual(b.pads);
  });

  it("keeps every tree clear of the roads", () => {
    const { trees } = scatterEnvironment(grid, { clearance: 14 });
    expect(trees.length).toBeGreaterThan(30);
    for (const t of trees) {
      expect(distanceToLanes(grid, t.x, t.y)).toBeGreaterThanOrEqual(14 - 1e-6);
    }
  });

  it("keeps every building pad well clear of the roads", () => {
    const { pads } = scatterEnvironment(grid, { padClearance: 34 });
    expect(pads.length).toBeGreaterThan(4);
    for (const p of pads) {
      expect(distanceToLanes(grid, p.x, p.y)).toBeGreaterThanOrEqual(34 - 1e-6);
    }
  });

  it("lines buildings up along the street frontages", () => {
    // Regression for the "towers dropped in a field" look: pads are placed by
    // walking each lane at a setback, so none may drift into open country.
    const { pads } = scatterEnvironment(grid, { padClearance: 30 });
    expect(pads.length).toBeGreaterThan(8);
    for (const p of pads) {
      // setback = padClearance + up to 14 m of jitter.
      expect(distanceToLanes(grid, p.x, p.y)).toBeLessThanOrEqual(30 + 14 + 1e-6);
    }
  });

  it("does not let two building footprints overlap", () => {
    const { pads } = scatterEnvironment(grid);
    for (let i = 0; i < pads.length; i++) {
      for (let j = i + 1; j < pads.length; j++) {
        const gap =
          Math.max(pads[i].width, pads[i].depth) / 2 + Math.max(pads[j].width, pads[j].depth) / 2;
        const apart =
          Math.abs(pads[i].x - pads[j].x) > gap || Math.abs(pads[i].y - pads[j].y) > gap;
        expect(apart).toBe(true);
      }
    }
  });

  it("honours the caps", () => {
    const { trees, pads } = scatterEnvironment(grid, { maxTrees: 25, maxPads: 4 });
    expect(trees.length).toBeLessThanOrEqual(25);
    expect(pads.length).toBeLessThanOrEqual(4);
  });

  it("scales the building count with how much street there is to line", () => {
    // A single-intersection network should get a handful of buildings, not the
    // same crowd as a 4x4 grid.
    const small = scatterEnvironment(gridNetwork("tiny", 2, 120));
    const big = scatterEnvironment(gridNetwork("grid4x4", 5, 260));
    expect(small.pads.length).toBeLessThan(big.pads.length);
    expect(big.pads.length).toBeLessThanOrEqual(40);
    expect(small.pads.length).toBeGreaterThanOrEqual(4);
  });

  it("gives trees a plausible size and a hue tint", () => {
    const { trees } = scatterEnvironment(grid);
    for (const t of trees) {
      expect(t.height).toBeGreaterThanOrEqual(6);
      expect(t.height).toBeLessThanOrEqual(10);
      expect(t.tintR).toBeGreaterThan(0);
      expect(t.tintG).toBeGreaterThan(0);
      expect(t.tintB).toBeGreaterThan(0);
    }
    // Not all identical: the tint and rotation actually vary.
    expect(new Set(trees.map((t) => t.tintR.toFixed(4))).size).toBeGreaterThan(5);
    expect(new Set(trees.map((t) => t.rot.toFixed(4))).size).toBeGreaterThan(5);
  });

  it("spreads trees over the whole network, not just one strip", () => {
    // Regression: capping inside the sweep used to leave every tree in the
    // first few rows of a big grid.
    const big = gridNetwork("grid4x4", 5, 260);
    const bounds = networkBounds(big);
    const { trees } = scatterEnvironment(big);
    expect(trees.length).toBeGreaterThan(100);
    const midX = bounds.centerX;
    const midY = bounds.centerY;
    const quadrants = [0, 0, 0, 0];
    for (const t of trees) {
      quadrants[(t.x > midX ? 1 : 0) + (t.y > midY ? 2 : 0)]++;
    }
    for (const q of quadrants) {
      expect(q).toBeGreaterThan(trees.length * 0.1);
    }
  });

  it("keeps trees in the band hugging the network rather than open country", () => {
    const { trees } = scatterEnvironment(grid, { clearance: 14 });
    for (const t of trees) {
      expect(distanceToLanes(grid, t.x, t.y)).toBeLessThanOrEqual(200);
    }
  });

  it("survives a network with no lanes at all", () => {
    const empty = gridNetwork("empty", 1, 0);
    empty.network.lanes = [];
    empty.network.nodes = [];
    const { trees, pads } = scatterEnvironment(empty);
    // No roads means no "between the roads" — nothing should be placed.
    expect(trees).toHaveLength(0);
    expect(pads).toHaveLength(0);
  });
});
