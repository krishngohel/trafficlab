/**
 * Pure geometric facts about a .traj network: its bounding box, the radius of
 * every intersection's paved disc, and how big the ground plane under it has to
 * be. No three.js, no assets — so `roads.ts`, `scatter.ts` and `city.ts` can all
 * share them without importing each other.
 *
 * Coordinates are SIM coordinates (X east, Y north).
 */

import type { TrajMeta } from "../traj";

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
 * Edge length of the ground plane. It has to reach past the outer edge of the
 * filler city (`city.ts` builds out to at most 1750 m from the network centre,
 * which this clears on every fixture), but stay *inside* the horizon haze band
 * (see `haze.ts`), which is what hides its edge — a plane that pokes through
 * the haze cuts a visible line across the horizon at overview zoom. The haze
 * radius is derived from this number, so growing it also lifts the band's top
 * edge and lets the HDRI's skyline back into frame: leave it alone.
 */
export function groundPlaneSize(bounds: NetworkBounds): number {
  return Math.max(bounds.extent * 5, 3000);
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
