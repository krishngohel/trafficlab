import * as THREE from "three";
import { ASPHALT_REPEAT, GRASS_REPEAT, type SceneAssets } from "./assets";
import { cityPlan, type CityRect, type CityStreet } from "./city";
import { groundPlaneSize, intersectionRadii, networkBounds, type NetworkBounds } from "./network";
import type { ThemeSpec } from "./theme";
import type { TrajLane, TrajMeta } from "../traj";

export { groundPlaneSize, intersectionRadii, networkBounds };
export type { NetworkBounds };

/**
 * Static road geometry built from the .traj meta network.
 *
 * Sim coordinates are X east / Y north; the scene maps (x, y) -> (x, -z) on
 * the three.js ground plane (Y up).
 *
 * The ribbon geometry stays procedural — it has to follow arbitrary lane
 * polylines — but it now carries arc-length UVs (u along the road, v across it,
 * both in the same world scale) so a tiling asphalt PBR set reads correctly
 * around bends. Painted markings — dashed separators, solid edge lines, double
 * centre lines, stop bars — stay unlit geometry on top, held off the tarmac by
 * polygon offset. Everything static merges into five meshes: ground, asphalt,
 * intersection discs, white markings, yellow centre lines.
 */

const LOT_Y = 0.008;
const VERGE_Y = 0.012;
const WALK_Y = 0.016;
const LANE_Y = 0.02;
const NODE_Y = 0.03;
const MARK_Y = 0.05;

/** Extra asphalt shoulder beyond the lane width, per side (m). */
const SHOULDER = 0.4;
/** Gravel/dirt verge beyond the asphalt, per side (m). Softens the grass edge. */
const VERGE = 1.0;
const EDGE_LINE_WIDTH = 0.35;
const DASH_LINE_WIDTH = 0.3;
const DASH_ON = 2.8;
const DASH_OFF = 3.4;
/** How far the painted edge line sits inside the lane border (m). */
const EDGE_INSET = 0.3;
const STOP_BAR_DEPTH = 0.9;

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
 *
 * UVs come out in world metres divided by `repeat`, so a tiled texture keeps a
 * constant real-world scale everywhere: strips measure `u` along the polyline's
 * arc length and `v` across the ribbon, rects and discs map planar.
 */
class FlatGeoBuilder {
  private readonly positions: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];

  constructor(private readonly repeat = 1) {}

  /** Ribbon of `width` along a sim-space polyline at height y. */
  addStrip(pts: readonly [number, number][], width: number, y: number): void {
    const n = pts.length;
    if (n < 2) return;
    const base = this.positions.length / 3;
    const half = width / 2;
    const inv = 1 / this.repeat;
    let arc = 0;
    for (let i = 0; i < n; i++) {
      // Tangent: average of adjacent segment directions.
      let dx = 0;
      let dy = 0;
      if (i > 0) {
        dx += pts[i][0] - pts[i - 1][0];
        dy += pts[i][1] - pts[i - 1][1];
        arc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
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
      const u = arc * inv;
      this.uvs.push(u, (0.5 + half) * inv, u, (0.5 - half) * inv);
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
    const inv = 1 / this.repeat;
    // Same vertex layout as addStrip (left, right, left, right).
    const corner = (sl: number, sw: number) => {
      const x = cx + dirX * hl * sl + px * hw * sw;
      const yy = cy + dirY * hl * sl + py * hw * sw;
      this.positions.push(x, y, -yy);
      this.uvs.push(x * inv, yy * inv);
    };
    corner(-1, 1);
    corner(-1, -1);
    corner(1, 1);
    corner(1, -1);
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
    const inv = 1 / this.repeat;
    this.positions.push(cx, y, -cy);
    this.uvs.push(cx * inv, cy * inv);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const x = cx + Math.cos(a) * radius;
      const yy = cy + Math.sin(a) * radius;
      this.positions.push(x, y, -yy);
      this.uvs.push(x * inv, yy * inv);
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
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    geo.setIndex(this.indices);
    geo.computeBoundingSphere();
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

/**
 * The static ground + road group, plus the per-theme knobs (albedo tints and
 * marking colours) that let one built network switch between day and night
 * without rebuilding any geometry.
 */
export class RoadLayer {
  readonly group = new THREE.Group();

  private readonly ground: THREE.MeshStandardMaterial;
  private readonly asphalt: THREE.MeshStandardMaterial;
  private readonly verge: THREE.MeshStandardMaterial;
  private readonly node: THREE.MeshStandardMaterial;
  private readonly walk: THREE.MeshStandardMaterial;
  private readonly lot: THREE.MeshStandardMaterial;
  /** Concrete tint scale: 1 with the PBR set loaded, dimmed without it. */
  private readonly concrete: number;
  private readonly marking: THREE.MeshBasicMaterial | null;
  private readonly centerLine: THREE.MeshBasicMaterial | null;

  constructor(meta: TrajMeta, assets: SceneAssets | null) {
    const group = this.group;
    group.name = "roads";
    const bounds = networkBounds(meta);

    // --- ground -------------------------------------------------------------
    const groundSize = groundPlaneSize(bounds);
    this.ground = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
    });
    if (assets) {
      const { map, normalMap, roughnessMap } = assets.grass;
      const repeats = groundSize / GRASS_REPEAT;
      this.ground.map = cloneRepeat(map, repeats);
      this.ground.normalMap = cloneRepeat(normalMap, repeats);
      this.ground.roughnessMap = cloneRepeat(roughnessMap, repeats);
      this.ground.normalScale.set(0.38, 0.38);
      addMacroVariation(this.ground, 1 / 11.3);
    } else {
      this.ground.color.setHex(0x2c3324);
    }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), this.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(bounds.centerX, -0.02, -bounds.centerY);
    ground.receiveShadow = true;
    ground.name = "ground";
    group.add(ground);

    const laneById = new Map(meta.network.lanes.map((l) => [l.id, l]));
    const nodeById = new Map(meta.network.nodes.map((n) => [n.id, n]));
    const linkKeys = new Set(meta.network.links.map((l) => `${l.from_node}:${l.to_node}`));

    const asphalt = new FlatGeoBuilder(ASPHALT_REPEAT);
    const verge = new FlatGeoBuilder(ASPHALT_REPEAT * 0.55);
    const nodes = new FlatGeoBuilder(ASPHALT_REPEAT);
    const markings = new FlatGeoBuilder();
    const centerLines = new FlatGeoBuilder();
    const walks = new FlatGeoBuilder(ASPHALT_REPEAT * 0.42);
    const blockLots = new FlatGeoBuilder(ASPHALT_REPEAT);

    // Asphalt ribbons (one per lane, slightly wider than the lane) over a
    // gravel verge, so the tarmac does not butt straight into lawn.
    for (const lane of meta.network.lanes) {
      if (lane.polyline.length < 2) continue;
      asphalt.addStrip(lane.polyline, lane.width + SHOULDER * 2, LANE_Y);
      verge.addStrip(lane.polyline, lane.width + (SHOULDER + VERGE) * 2, VERGE_Y);
    }

    // Intersection discs, sized to reach the lane endpoints.
    const radii = intersectionRadii(meta);
    for (const node of meta.network.nodes) {
      if (node.type !== "intersection") continue;
      const r = (radii.get(node.id) ?? 8) * 1.04;
      nodes.addDisc(node.x, node.y, r, NODE_Y);
      verge.addDisc(node.x, node.y, r + VERGE, VERGE_Y);
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
        centerLines.addStrip(offsetPolyline(left.polyline, left.width / 2 - 0.16), 0.16, MARK_Y);
        centerLines.addStrip(offsetPolyline(left.polyline, left.width / 2 - 0.52), 0.16, MARK_Y);
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

    // --- the city around the simulation ---------------------------------------
    // Filler streets feed the SAME builders as the simulated ones, so they end
    // up in the same merged meshes with the same asphalt, the same verge and the
    // same paint: zero extra draw calls and a seamless join where a boundary
    // stub turns into a street that just keeps going. `city.ts` has already
    // clipped every run out of the simulated road's footprint.
    const plan = cityPlan(meta);
    const streetPts = (s: CityStreet, offset = 0): [number, number][] =>
      s.axis === 0
        ? [
            [s.c + offset, s.a],
            [s.c + offset, s.b],
          ]
        : [
            [s.a, s.c + offset],
            [s.b, s.c + offset],
          ];
    for (const street of plan.streets) {
      // The run carries its own carriageway width, inherited from whichever
      // simulated corridor it continues, so the paint has to be laid out per
      // street rather than once for the network.
      const carriageway = street.half - SHOULDER;
      const laneWidth = carriageway / street.lanes;
      asphalt.addStrip(streetPts(street), street.half * 2, LANE_Y);
      verge.addStrip(streetPts(street), (street.half + VERGE) * 2, VERGE_Y);
      // Double centre line, matching the sim's opposing-link pair exactly.
      for (const offset of [0.16, -0.16, 0.52, -0.52]) {
        centerLines.addStrip(streetPts(street, offset), 0.16, MARK_Y);
      }
      for (const side of [1, -1]) {
        markings.addStrip(
          streetPts(street, side * (carriageway - EDGE_INSET)),
          EDGE_LINE_WIDTH,
          MARK_Y,
        );
        if (!street.detail) continue;
        for (let k = 1; k < street.lanes; k++) {
          markings.addDashedStrip(
            streetPts(street, side * k * laneWidth),
            DASH_LINE_WIDTH,
            MARK_Y,
            DASH_ON,
            DASH_OFF,
          );
        }
      }
    }
    for (const junction of plan.nodes) {
      nodes.addDisc(junction.x, junction.y, junction.radius * 1.2, NODE_Y);
      verge.addDisc(junction.x, junction.y, junction.radius * 1.2 + VERGE, VERGE_Y);
    }

    // Sidewalks down both flanks of every street (simulated ones included) with
    // a square pad closing each corner, and paved interiors for the blocks in
    // between: without them the city reads as buildings standing in a meadow.
    for (const walk of plan.sidewalks) {
      walks.addStrip(streetPts(walk), walk.half * 2, WALK_Y);
    }
    const addRect = (builder: FlatGeoBuilder, rect: CityRect, y: number) =>
      builder.addRect(
        (rect.x0 + rect.x1) / 2,
        (rect.y0 + rect.y1) / 2,
        1,
        0,
        Math.abs(rect.x1 - rect.x0),
        Math.abs(rect.y1 - rect.y0),
        y,
      );
    for (const corner of plan.corners) addRect(walks, corner, WALK_Y);
    for (const lot of plan.lots) addRect(blockLots, lot, LOT_Y);

    // Off-street parking: a concrete forecourt running from the kerb, under the
    // driveway's tarmac, to the back wall of the garage. Same merged sidewalk
    // mesh, so a whole city's worth of them costs no extra draw call — and it
    // is what stops a driveway reading as a stray 14 m stub of asphalt.
    for (const garage of plan.garages) {
      walks.addRect(
        garage.apronX,
        garage.apronY,
        garage.dirX,
        garage.dirY,
        garage.apronLength,
        garage.apronWidth,
        WALK_Y,
      );
    }

    // --- asphalt + intersections --------------------------------------------
    this.asphalt = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0,
    });
    this.node = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    if (assets) {
      const { map, normalMap, roughnessMap } = assets.asphalt;
      for (const material of [this.asphalt, this.node]) {
        material.map = map;
        material.normalMap = normalMap;
        material.roughnessMap = roughnessMap;
        material.normalScale.set(0.8, 0.8);
      }
      // The intersection disc reads a touch lighter, like polished-out tarmac.
      this.node.color.setRGB(1.1, 1.1, 1.12);
    } else {
      this.asphalt.color.setHex(0x313848);
      this.node.color.setHex(0x414a5b);
    }

    this.verge = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
    });
    if (assets) {
      this.verge.map = assets.asphalt.map;
      this.verge.roughnessMap = assets.asphalt.roughnessMap;
    } else {
      this.verge.color.setHex(0x3a3a33);
    }
    const vergeMesh = new THREE.Mesh(verge.build(), this.verge);
    vergeMesh.name = "verge";
    vergeMesh.receiveShadow = true;
    group.add(vergeMesh);

    const asphaltMesh = new THREE.Mesh(asphalt.build(), this.asphalt);
    asphaltMesh.name = "asphalt";
    asphaltMesh.receiveShadow = true;
    group.add(asphaltMesh);

    if (!nodes.empty) {
      const nodeMesh = new THREE.Mesh(nodes.build(), this.node);
      nodeMesh.name = "intersections";
      nodeMesh.receiveShadow = true;
      group.add(nodeMesh);
    }
    // --- sidewalks + block interiors ------------------------------------------
    // Both reuse the asphalt PBR set: a bright tint on the same albedo reads as
    // poured concrete, and sharing the maps costs nothing at load time.
    this.walk = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    this.lot = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
    this.concrete = assets ? 1 : 0.3;
    if (assets) {
      this.walk.map = assets.asphalt.map;
      this.walk.normalMap = assets.asphalt.normalMap;
      this.walk.roughnessMap = assets.asphalt.roughnessMap;
      this.walk.normalScale.set(0.35, 0.35);
      // Block interiors carpet square kilometres of screen, so they get the
      // albedo and nothing else: at this scale a normal map is invisible and a
      // fourth texture fetch across most of the frame is not free.
      this.lot.map = assets.asphalt.map;
    }
    if (!walks.empty) {
      const walkMesh = new THREE.Mesh(walks.build(), this.walk);
      walkMesh.name = "sidewalks";
      walkMesh.receiveShadow = true;
      group.add(walkMesh);
    }
    if (!blockLots.empty) {
      const lotMesh = new THREE.Mesh(blockLots.build(), this.lot);
      lotMesh.name = "blocks";
      lotMesh.receiveShadow = true;
      group.add(lotMesh);
    }

    this.marking = markings.empty ? null : markingMaterial(0xffffff);
    this.centerLine = centerLines.empty ? null : markingMaterial(0xffffff);
    if (this.marking) group.add(new THREE.Mesh(markings.build(), this.marking));
    if (this.centerLine) group.add(new THREE.Mesh(centerLines.build(), this.centerLine));
  }

  setTheme(spec: ThemeSpec): void {
    const g = spec.groundTint;
    this.ground.color.setRGB(g, g, g);
    const a = spec.asphaltTint;
    this.asphalt.color.setRGB(a, a, a);
    this.node.color.setRGB(a * 1.12, a * 1.12, a * 1.14);
    // Dust/gravel: warmer and lighter than the tarmac it borders.
    this.verge.color.setRGB(a * 0.82, a * 0.76, a * 0.62);
    // Concrete: the same albedo map pushed well past 1, so it reads pale. With
    // no texture loaded the colour *is* the albedo, so it has to come back down.
    const c = a * this.concrete;
    this.walk.color.setRGB(c * 2.6, c * 2.62, c * 2.66);
    this.lot.color.setRGB(c * 1.4, c * 1.44, c * 1.52);
    this.marking?.color.setHex(spec.markingColor);
    this.centerLine?.color.setHex(spec.centerLineColor);
  }

  dispose(): void {
    disposeGroup(this.group);
  }
}

/** A texture sharing the loaded image but with its own repeat. */
function cloneRepeat(texture: THREE.Texture, repeats: number): THREE.Texture {
  const clone = texture.clone();
  clone.repeat.set(repeats, repeats);
  clone.needsUpdate = true;
  return clone;
}

/**
 * Break up the visible tiling grid of a ground texture by multiplying it with
 * itself sampled at a much lower frequency, remapped around 1. Two extra texture
 * fetches, no extra assets, and the 26 m repeat stops reading as a quilt across
 * a 3.6 km plane.
 */
function addMacroVariation(material: THREE.MeshStandardMaterial, frequency: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMacro = { value: frequency };
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform float uMacro;\nvoid main() {")
      .replace(
        "#include <map_fragment>",
        /* glsl */ `
        #include <map_fragment>
        vec3 macro = texture2D( map, vMapUv * uMacro ).rgb;
        vec3 macro2 = texture2D( map, vMapUv * uMacro * 0.37 + vec2( 0.37 ) ).rgb;
        float m = ( dot( macro, vec3( 0.33 ) ) + dot( macro2, vec3( 0.33 ) ) ) * 0.5;
        diffuseColor.rgb *= mix( 0.8, 1.2, clamp( m * 2.2, 0.0, 1.0 ) );
        `,
      );
  };
  material.customProgramCacheKey = () => "trafficlab-macro";
}

function markingMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/** Build the static road group for one network. */
export function buildRoads(meta: TrajMeta, assets: SceneAssets | null = null): RoadLayer {
  return new RoadLayer(meta, assets);
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
