import * as THREE from "three";
import type { TrajLane, TrajMeta } from "../traj";

/**
 * Static road geometry built from the .traj meta network.
 *
 * Sim coordinates are X east / Y north; the scene maps (x, y) -> (x, -z) on
 * the three.js ground plane (Y up).
 *
 * Night-city read: the ground plane is near-black so the (lighter) asphalt
 * ribbons are the bright figures, and painted lane markings — dashed
 * separators, solid edge lines, double center lines, stop bars — carry most
 * of the readability. Everything static is merged into a handful of meshes:
 * ground, asphalt, intersection discs, white markings, yellow center lines.
 */

const GROUND_COLOR = 0x10141b;
const ASPHALT_COLOR = 0x313848;
const NODE_COLOR = 0x414a5b;
const MARKING_COLOR = 0xc3cad5;
const CENTER_COLOR = 0xb89a5e;

const LANE_Y = 0.02;
const NODE_Y = 0.03;
const MARK_Y = 0.05;

/** Extra asphalt shoulder beyond the lane width, per side (m). */
const SHOULDER = 0.25;
const EDGE_LINE_WIDTH = 0.35;
const DASH_LINE_WIDTH = 0.3;
const DASH_ON = 2.8;
const DASH_OFF = 3.4;
/** How far the painted edge line sits inside the lane border (m). */
const EDGE_INSET = 0.3;
const STOP_BAR_DEPTH = 0.9;

export interface NetworkBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centerX: number;
  centerY: number;
  extent: number;
}

export function networkBounds(meta: TrajMeta): NetworkBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const lane of meta.network.lanes) {
    for (const [x, y] of lane.polyline) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  for (const node of meta.network.nodes) {
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = minY = maxY = 0;
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    extent: Math.max(maxX - minX, maxY - minY, 1),
  };
}

/**
 * Radius of each intersection node's paved disc: distance from the node to
 * the nearest endpoint of every lane on links touching it, plus half a lane
 * width. Keyed by node id. Shared by road building and the pressure overlay.
 */
export function intersectionRadii(meta: TrajMeta): Map<number, number> {
  const laneById = new Map(meta.network.lanes.map((l) => [l.id, l]));
  const radii = new Map<number, number>();
  for (const node of meta.network.nodes) {
    if (node.type !== "intersection") continue;
    let radius = 0;
    for (const link of meta.network.links) {
      if (link.from_node !== node.id && link.to_node !== node.id) continue;
      for (const laneId of link.lanes) {
        const lane = laneById.get(laneId);
        if (!lane || lane.polyline.length === 0) continue;
        const first = lane.polyline[0];
        const last = lane.polyline[lane.polyline.length - 1];
        const dNear = Math.min(
          Math.hypot(first[0] - node.x, first[1] - node.y),
          Math.hypot(last[0] - node.x, last[1] - node.y),
        );
        radius = Math.max(radius, dNear + lane.width / 2);
      }
    }
    radii.set(node.id, radius > 0 ? radius : 8);
  }
  return radii;
}

/** Sim-space stop-line anchor for one approach (an incoming link). */
export interface ApproachAnchor {
  /** Stop-line center (mean of the link's lane endpoints), sim coords. */
  x: number;
  y: number;
  /** Unit travel direction at the stop line (toward the intersection). */
  dirX: number;
  dirY: number;
  /** Total width across the link's lanes. */
  width: number;
}

/**
 * One anchor per meta.approaches entry (same order as the per-frame queue
 * array). Approaches whose link/lanes cannot be resolved get a zero anchor.
 */
export function approachAnchors(meta: TrajMeta): ApproachAnchor[] {
  const linkById = new Map(meta.network.links.map((l) => [l.id, l]));
  const laneById = new Map(meta.network.lanes.map((l) => [l.id, l]));
  return meta.approaches.map((approach) => {
    const link = linkById.get(approach.link);
    let x = 0;
    let y = 0;
    let dirX = 1;
    let dirY = 0;
    let width = 0;
    let count = 0;
    if (link) {
      let dx = 0;
      let dy = 0;
      for (const laneId of link.lanes) {
        const lane = laneById.get(laneId);
        if (!lane || lane.polyline.length < 2) continue;
        const end = lane.polyline[lane.polyline.length - 1];
        const prev = lane.polyline[lane.polyline.length - 2];
        x += end[0];
        y += end[1];
        dx += end[0] - prev[0];
        dy += end[1] - prev[1];
        width += lane.width;
        count++;
      }
      if (count > 0) {
        x /= count;
        y /= count;
        const len = Math.hypot(dx, dy) || 1;
        dirX = dx / len;
        dirY = dy / len;
      }
    }
    return { x, y, dirX, dirY, width };
  });
}

// ---------------------------------------------------------------------------
// Flat-geometry accumulation (everything merges into a few meshes)
// ---------------------------------------------------------------------------

/**
 * Accumulates flat, up-facing geometry (strips, rectangles, discs) in sim
 * coordinates and builds one merged BufferGeometry with constant +Y normals.
 */
class FlatGeoBuilder {
  private readonly positions: number[] = [];
  private readonly indices: number[] = [];

  /** Ribbon of `width` along a sim-space polyline at height y. */
  addStrip(pts: readonly [number, number][], width: number, y: number): void {
    const n = pts.length;
    if (n < 2) return;
    const base = this.positions.length / 3;
    const half = width / 2;
    for (let i = 0; i < n; i++) {
      // Tangent: average of adjacent segment directions.
      let dx = 0;
      let dy = 0;
      if (i > 0) {
        dx += pts[i][0] - pts[i - 1][0];
        dy += pts[i][1] - pts[i - 1][1];
      }
      if (i < n - 1) {
        dx += pts[i + 1][0] - pts[i][0];
        dy += pts[i + 1][1] - pts[i][1];
      }
      const len = Math.hypot(dx, dy) || 1;
      // Perpendicular (left of travel direction) in sim space.
      const px = -dy / len;
      const py = dx / len;
      const [x, yy] = pts[i];
      // Sim (x, y) -> scene (x, y_up, -y).
      this.positions.push(x + px * half, y, -(yy + py * half));
      this.positions.push(x - px * half, y, -(yy - py * half));
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      this.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  /** Rectangle centered at (cx, cy), long axis along unit (dirX, dirY). */
  addRect(
    cx: number,
    cy: number,
    dirX: number,
    dirY: number,
    length: number,
    width: number,
    y: number,
  ): void {
    const hl = length / 2;
    const hw = width / 2;
    const px = -dirY;
    const py = dirX;
    const base = this.positions.length / 3;
    // Same vertex layout as addStrip (left, right, left, right).
    this.positions.push(cx - dirX * hl + px * hw, y, -(cy - dirY * hl + py * hw));
    this.positions.push(cx - dirX * hl - px * hw, y, -(cy - dirY * hl - py * hw));
    this.positions.push(cx + dirX * hl + px * hw, y, -(cy + dirY * hl + py * hw));
    this.positions.push(cx + dirX * hl - px * hw, y, -(cy + dirY * hl - py * hw));
    this.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }

  /** Dashed ribbon: `on` meters painted, `off` meters gap, along the polyline. */
  addDashedStrip(
    pts: readonly [number, number][],
    width: number,
    y: number,
    on: number,
    off: number,
  ): void {
    const cycle = on + off;
    let pattern = 0; // arclength position within the on/off cycle
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const segLen = Math.hypot(x1 - x0, y1 - y0);
      if (segLen < 1e-6) continue;
      const ux = (x1 - x0) / segLen;
      const uy = (y1 - y0) / segLen;
      let s = 0;
      while (s < segLen - 1e-9) {
        const at = pattern % cycle;
        let e: number;
        if (at < on) {
          e = Math.min(s + (on - at), segLen);
          if (e - s > 1e-4) {
            const mid = (s + e) / 2;
            this.addRect(x0 + ux * mid, y0 + uy * mid, ux, uy, e - s, width, y);
          }
        } else {
          e = Math.min(s + (cycle - at), segLen);
        }
        // Guarantee forward progress across float boundaries.
        const step = Math.max(e - s, 1e-4);
        pattern += step;
        s += step;
      }
    }
  }

  /** Filled disc at sim (cx, cy). */
  addDisc(cx: number, cy: number, radius: number, y: number, segments = 48): void {
    const base = this.positions.length / 3;
    this.positions.push(cx, y, -cy);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      this.positions.push(cx + Math.cos(a) * radius, y, -(cy + Math.sin(a) * radius));
    }
    for (let i = 0; i < segments; i++) {
      this.indices.push(base, base + 1 + i, base + 2 + i);
    }
  }

  get empty(): boolean {
    return this.indices.length === 0;
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(this.positions);
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setIndex(this.indices);
    return geo;
  }
}

/** Polyline shifted `lateral` meters to the left of the travel direction. */
function offsetPolyline(
  pts: readonly [number, number][],
  lateral: number,
): [number, number][] {
  const n = pts.length;
  const out: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) {
    let dx = 0;
    let dy = 0;
    if (i > 0) {
      dx += pts[i][0] - pts[i - 1][0];
      dy += pts[i][1] - pts[i - 1][1];
    }
    if (i < n - 1) {
      dx += pts[i + 1][0] - pts[i][0];
      dy += pts[i + 1][1] - pts[i][1];
    }
    const len = Math.hypot(dx, dy) || 1;
    out[i] = [pts[i][0] + (-dy / len) * lateral, pts[i][1] + (dx / len) * lateral];
  }
  return out;
}

function markingMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/**
 * Build the static road group. Five merged meshes total: ground plane,
 * asphalt ribbons, intersection discs, white/gray markings (edges, dashes,
 * stop bars), and yellow center lines between opposing directions.
 */
export function buildRoads(meta: TrajMeta): THREE.Group {
  const group = new THREE.Group();
  group.name = "roads";
  const bounds = networkBounds(meta);

  // Ground plane: near-black so roads are the bright figures.
  const groundSize = Math.max(bounds.extent * 6, 2400);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(bounds.centerX, -0.02, -bounds.centerY);
  group.add(ground);

  const laneById = new Map(meta.network.lanes.map((l) => [l.id, l]));
  const nodeById = new Map(meta.network.nodes.map((n) => [n.id, n]));
  const linkKeys = new Set(meta.network.links.map((l) => `${l.from_node}:${l.to_node}`));

  const asphalt = new FlatGeoBuilder();
  const nodes = new FlatGeoBuilder();
  const markings = new FlatGeoBuilder();
  const centerLines = new FlatGeoBuilder();

  // Asphalt ribbons (one per lane, slightly wider than the lane).
  for (const lane of meta.network.lanes) {
    if (lane.polyline.length < 2) continue;
    asphalt.addStrip(lane.polyline, lane.width + SHOULDER * 2, LANE_Y);
  }

  // Intersection discs, one step lighter, sized to reach the lane endpoints.
  const radii = intersectionRadii(meta);
  for (const node of meta.network.nodes) {
    if (node.type !== "intersection") continue;
    nodes.addDisc(node.x, node.y, (radii.get(node.id) ?? 8) * 1.04, NODE_Y);
  }

  // Per-link lane markings.
  for (const link of meta.network.links) {
    const lanes = link.lanes
      .map((id) => laneById.get(id))
      .filter((l): l is TrajLane => l !== undefined && l.polyline.length >= 2);
    if (lanes.length === 0) continue;

    // Link travel direction + left perpendicular, from the first lane.
    const ref = lanes[0].polyline;
    const p0 = ref[0];
    const p1 = ref[ref.length - 1];
    let dx = p1[0] - p0[0];
    let dy = p1[1] - p0[1];
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const perpX = -dy;
    const perpY = dx;

    // Sort lanes leftmost-first by lateral offset from the reference lane.
    const sorted = lanes
      .map((lane) => {
        const mid = lane.polyline[Math.floor(lane.polyline.length / 2)];
        return { lane, off: (mid[0] - p0[0]) * perpX + (mid[1] - p0[1]) * perpY };
      })
      .sort((a, b) => b.off - a.off)
      .map((e) => e.lane);

    // Left border: double center line when an opposing link exists, else a
    // solid edge line.
    const left = sorted[0];
    if (linkKeys.has(`${link.to_node}:${link.from_node}`)) {
      centerLines.addStrip(
        offsetPolyline(left.polyline, left.width / 2 - 0.16),
        0.16,
        MARK_Y,
      );
      centerLines.addStrip(
        offsetPolyline(left.polyline, left.width / 2 - 0.52),
        0.16,
        MARK_Y,
      );
    } else {
      markings.addStrip(
        offsetPolyline(left.polyline, left.width / 2 - EDGE_INSET),
        EDGE_LINE_WIDTH,
        MARK_Y,
      );
    }

    // Right border: solid edge line.
    const right = sorted[sorted.length - 1];
    markings.addStrip(
      offsetPolyline(right.polyline, -(right.width / 2 - EDGE_INSET)),
      EDGE_LINE_WIDTH,
      MARK_Y,
    );

    // Dashed separators between adjacent same-direction lanes.
    for (let i = 0; i < sorted.length - 1; i++) {
      markings.addDashedStrip(
        offsetPolyline(sorted[i].polyline, -sorted[i].width / 2),
        DASH_LINE_WIDTH,
        MARK_Y,
        DASH_ON,
        DASH_OFF,
      );
    }

    // Stop bar across each lane where the link enters an intersection.
    if (nodeById.get(link.to_node)?.type === "intersection") {
      for (const lane of sorted) {
        const pts = lane.polyline;
        const end = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        let ex = end[0] - prev[0];
        let ey = end[1] - prev[1];
        const el = Math.hypot(ex, ey) || 1;
        ex /= el;
        ey /= el;
        const setback = STOP_BAR_DEPTH / 2 + 0.15;
        markings.addRect(
          end[0] - ex * setback,
          end[1] - ey * setback,
          -ey,
          ex,
          lane.width - 0.5,
          STOP_BAR_DEPTH,
          MARK_Y + 0.005,
        );
      }
    }
  }

  const asphaltMesh = new THREE.Mesh(
    asphalt.build(),
    new THREE.MeshStandardMaterial({ color: ASPHALT_COLOR, roughness: 0.92, metalness: 0 }),
  );
  group.add(asphaltMesh);

  if (!nodes.empty) {
    const nodeMaterial = new THREE.MeshStandardMaterial({
      color: NODE_COLOR,
      roughness: 0.88,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    group.add(new THREE.Mesh(nodes.build(), nodeMaterial));
  }
  if (!markings.empty) {
    group.add(new THREE.Mesh(markings.build(), markingMaterial(MARKING_COLOR)));
  }
  if (!centerLines.empty) {
    group.add(new THREE.Mesh(centerLines.build(), markingMaterial(CENTER_COLOR)));
  }
  return group;
}

export function disposeGroup(group: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) {
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(m);
      }
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
}
