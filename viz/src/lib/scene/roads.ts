import * as THREE from "three";
import type { TrajMeta } from "../traj";

/**
 * Static road geometry built from the .traj meta network.
 *
 * Sim coordinates are X east / Y north; the scene maps (x, y) -> (x, -z) on
 * the three.js ground plane (Y up).
 */

const GROUND_COLOR = 0x0c0e12;
const LANE_COLOR = 0x22262e;
const NODE_COLOR = 0x2e333d;

const LANE_Y = 0.02;
const NODE_Y = 0.035;

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

/** Flat ribbon of the given width along a sim-space polyline, at height y. */
function ribbonGeometry(
  polyline: [number, number][],
  width: number,
  y: number,
): THREE.BufferGeometry {
  const n = polyline.length;
  const positions = new Float32Array(n * 2 * 3);
  const half = width / 2;

  for (let i = 0; i < n; i++) {
    // Tangent: average of adjacent segment directions.
    let dx = 0;
    let dy = 0;
    if (i > 0) {
      dx += polyline[i][0] - polyline[i - 1][0];
      dy += polyline[i][1] - polyline[i - 1][1];
    }
    if (i < n - 1) {
      dx += polyline[i + 1][0] - polyline[i][0];
      dy += polyline[i + 1][1] - polyline[i][1];
    }
    const len = Math.hypot(dx, dy) || 1;
    // Perpendicular (left of travel direction) in sim space.
    const px = -dy / len;
    const py = dx / len;

    const [x, yy] = polyline[i];
    // Sim (x, y) -> scene (x, y_up, -y).
    positions[i * 6 + 0] = x + px * half;
    positions[i * 6 + 1] = y;
    positions[i * 6 + 2] = -(yy + py * half);
    positions[i * 6 + 3] = x - px * half;
    positions[i * 6 + 4] = y;
    positions[i * 6 + 5] = -(yy - py * half);
  }

  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = i * 2 + 2;
    const d = i * 2 + 3;
    indices.push(a, b, c, b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build the static road group: a large ground plane, one flat dark ribbon per
 * lane (width from meta), and a lighter disc per intersection node.
 */
export function buildRoads(meta: TrajMeta): THREE.Group {
  const group = new THREE.Group();
  group.name = "roads";
  const bounds = networkBounds(meta);

  // Ground plane.
  const groundSize = Math.max(bounds.extent * 2.5, 600);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(bounds.centerX, -0.02, -bounds.centerY);
  group.add(ground);

  // Lane ribbons.
  const laneMaterial = new THREE.MeshStandardMaterial({
    color: LANE_COLOR,
    roughness: 0.95,
    metalness: 0,
  });
  for (const lane of meta.network.lanes) {
    if (lane.polyline.length < 2) continue;
    group.add(new THREE.Mesh(ribbonGeometry(lane.polyline, lane.width, LANE_Y), laneMaterial));
  }

  // Intersection node discs, sized to reach the nearest lane endpoints.
  const nodeMaterial = new THREE.MeshStandardMaterial({
    color: NODE_COLOR,
    roughness: 0.9,
    metalness: 0,
  });
  const radii = intersectionRadii(meta);
  for (const node of meta.network.nodes) {
    if (node.type !== "intersection") continue;
    const radius = radii.get(node.id) ?? 8;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius * 1.02, 48), nodeMaterial);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(node.x, NODE_Y, -node.y);
    group.add(disc);
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
