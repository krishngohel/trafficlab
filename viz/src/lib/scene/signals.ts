import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { SceneAssets } from "./assets";
import type { ThemeSpec } from "./theme";
import type { TrajFrame, TrajLane, TrajMeta } from "../traj";
import { networkBounds } from "./roads";

/**
 * Mast-arm traffic signals: one mast per approach link, one signal head per
 * approach lane.
 *
 * The mast is the roads-kit `light-curved` model scaled to ~6.4 m, stood on the
 * kerb beyond the outermost lane. A slim dark arm carries on from it across the
 * link and a small housing hangs over each lane's stop line. Only the 0.22 m
 * lens is emissive — the old 1.2 m glow spheres dwarfed the whole intersection
 * in a closeup. The billboarded additive halo is world-sized but *pixel
 * clamped*, so it stays legible at overview zoom without swallowing the pole up
 * close.
 *
 * State per lane, from the signal records of the connections leaving it:
 *   green  — some connection is in the active phase and the signal is green
 *   yellow — some connection is in the outgoing phase and the signal is yellow
 *   red    — otherwise (including all-red)
 *
 * Draw calls: 1 merged hardware mesh + 1 instanced lens + 1 glow Points = 3.
 */

type HeadState = 0 | 1 | 2; // green | yellow | red

interface HeadConn {
  connId: number;
  /** Index of the controlling intersection in meta.intersections_order. */
  kIndex: number;
  /** Per-phase connection-id sets for that intersection. */
  intersectionPhases: Set<number>[];
}

interface Head {
  /** Instance index in the lens mesh / glow attribute. */
  index: number;
  /** Connections leaving this lane. */
  conns: HeadConn[];
  last: HeadState | -1;
}

/** Mast height in metres (a real mast-arm signal is 5.5-7 m). */
const MAST_HEIGHT = 6.4;
/** Height of the signal lens above the road. */
const LENS_HEIGHT = 5.7;
const LENS_RADIUS = 0.22;
/** Gap between the kerb-side pole and the outermost lane edge. */
const POLE_CLEARANCE = 1.0;
/** How far upstream of the stop line the mast stands. */
const POLE_SETBACK = 1.2;
const ARM_THICKNESS = 0.15;
const HOUSING_WIDTH = 0.34;
const HOUSING_HEIGHT = 0.86;
const HOUSING_DEPTH = 0.3;

const STATE_COLORS: Record<HeadState, THREE.Color> = {
  0: new THREE.Color(0x2ee07f), // green
  1: new THREE.Color(0xffc02e), // yellow
  2: new THREE.Color(0xff3b30), // red
};

/**
 * Halo diameter in metres. Small — it marks the lens, it is not the light.
 * `clampPointSize` keeps the on-screen size sane at both ends of the zoom.
 */
function glowWorldSize(extent: number): number {
  return THREE.MathUtils.clamp(extent * 0.0022, 1.1, 2.6);
}

function makeGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.22, "rgba(255,255,255,0.45)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.13)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Box with its local transform baked in, ready for merging with the kit masts
 * — which carry position + normal only, so the UVs go.
 */
export function hardwareBox(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  rotY: number,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
  geo.deleteAttribute("uv");
  if (rotY !== 0) geo.rotateY(rotY);
  geo.translate(at[0], at[1], at[2]);
  return geo;
}

function mergeOrEmpty(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
  parts.forEach((p) => p.dispose());
  return merged;
}

export class SignalLayer {
  readonly group: THREE.Group;

  private readonly heads: Head[] = [];
  private readonly lensMesh: THREE.InstancedMesh;
  private readonly lensMaterial: THREE.MeshBasicMaterial;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly glow: THREE.Points;
  private readonly glowMaterial: THREE.PointsMaterial;
  private readonly glowColors: Float32Array;
  private readonly glowTexture: THREE.CanvasTexture;
  private readonly color = new THREE.Color();
  private lensIntensity = 2.6;
  private glowIntensity = 1;

  constructor(meta: TrajMeta, assets: SceneAssets | null = null) {
    this.group = new THREE.Group();
    this.group.name = "signals";

    const { network, intersections_order } = meta;
    const kIndexByIntersection = new Map<number, number>();
    intersections_order.forEach((id, k) => kIndexByIntersection.set(id, k));

    const intersectionById = new Map(network.intersections.map((i) => [i.id, i]));
    const laneById = new Map(network.lanes.map((l) => [l.id, l]));

    // Group connections by their from_lane.
    const connsByLane = new Map<number, typeof network.connections>();
    for (const conn of network.connections) {
      const list = connsByLane.get(conn.from_lane);
      if (list) list.push(conn);
      else connsByLane.set(conn.from_lane, [conn]);
    }

    // Per-link lane geometry: which lane is on the kerb, and how wide the link
    // is, so the mast lands outside the traffic and the arm spans every lane.
    const linkOfLane = new Map<number, number>();
    /** Lane id -> lateral distance from its centre to the kerb-side pole. */
    const toKerbOfLane = new Map<number, number>();
    /** Link id -> arm length needed to reach the far lane. */
    const armOfLink = new Map<number, number>();
    for (const link of network.links) {
      const lanes = link.lanes
        .map((id) => laneById.get(id))
        .filter((l): l is TrajLane => l !== undefined && l.polyline.length >= 2);
      if (lanes.length === 0) continue;
      const ref = lanes[0].polyline;
      const p0 = ref[0];
      const p1 = ref[ref.length - 1];
      let dx = p1[0] - p0[0];
      let dy = p1[1] - p0[1];
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      // Lateral offset of each lane, positive to the LEFT of travel.
      const offsets = lanes.map((lane) => {
        const mid = lane.polyline[Math.floor(lane.polyline.length / 2)];
        return (mid[0] - p0[0]) * -dy + (mid[1] - p0[1]) * dx;
      });
      const minOff = Math.min(...offsets);
      let arm = 0;
      lanes.forEach((lane, i) => {
        linkOfLane.set(lane.id, link.id);
        const toKerb = offsets[i] - minOff + lane.width / 2 + POLE_CLEARANCE;
        toKerbOfLane.set(lane.id, toKerb);
        arm = Math.max(arm, toKerb);
      });
      armOfLink.set(link.id, arm);
    }

    const hardwareGeos: THREE.BufferGeometry[] = [];
    const lensPositions: [number, number, number][] = [];
    const mastedLinks = new Set<number>();

    for (const [laneId, conns] of connsByLane) {
      const lane = laneById.get(laneId);
      if (!lane || lane.polyline.length < 2) continue;

      const headConns: HeadConn[] = [];
      for (const conn of conns) {
        const kIndex = kIndexByIntersection.get(conn.intersection);
        const intersection = intersectionById.get(conn.intersection);
        if (kIndex === undefined || intersection === undefined) continue;
        headConns.push({
          connId: conn.id,
          kIndex,
          intersectionPhases: intersection.phases.map((p) => new Set(p.connections)),
        });
      }
      if (headConns.length === 0) continue;

      const pts = lane.polyline;
      const end = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      let fx = end[0] - prev[0];
      let fy = end[1] - prev[1];
      const fl = Math.hypot(fx, fy) || 1;
      fx /= fl;
      fy /= fl;
      // Sim (x, y) -> scene (x, -z): forward, and its right-hand normal.
      const fxs = fx;
      const fzs = -fy;
      const rxs = -fzs;
      const rzs = fxs;
      // Scene heading of this approach. Rotating the kit mast by it swings the
      // model's arm (local -Z) out over the road.
      const heading = Math.atan2(-fzs, fxs);

      // Stop-line point for this lane, in scene space.
      const sx = end[0];
      const sz = -end[1];
      const toKerb = toKerbOfLane.get(laneId) ?? lane.width / 2 + POLE_CLEARANCE;

      const linkId = linkOfLane.get(laneId);
      if (linkId !== undefined && !mastedLinks.has(linkId)) {
        mastedLinks.add(linkId);
        const px = sx + rxs * toKerb - fxs * POLE_SETBACK;
        const pz = sz + rzs * toKerb - fzs * POLE_SETBACK;
        if (assets) {
          const mast = assets.mast.geometry.clone();
          mast.scale(MAST_HEIGHT, MAST_HEIGHT, MAST_HEIGHT);
          mast.rotateY(heading);
          mast.translate(px, 0, pz);
          hardwareGeos.push(mast);
        } else {
          hardwareGeos.push(hardwareBox([0.2, MAST_HEIGHT, 0.2], [px, MAST_HEIGHT / 2, pz], 0));
        }
        // Arm reaching from the pole across every lane of the link. Its local
        // +X ends up along the LEFT of travel, i.e. from kerb toward the road.
        const armLength = (armOfLink.get(linkId) ?? toKerb) + 0.3;
        hardwareGeos.push(
          hardwareBox(
            [armLength, ARM_THICKNESS, ARM_THICKNESS],
            [
              px - rxs * (armLength / 2 - 0.15),
              LENS_HEIGHT + HOUSING_HEIGHT * 0.72,
              pz - rzs * (armLength / 2 - 0.15),
            ],
            heading + Math.PI / 2,
          ),
        );
        // Vertical drop tying the arm to the mast tip.
        hardwareGeos.push(
          hardwareBox(
            [ARM_THICKNESS, MAST_HEIGHT - LENS_HEIGHT, ARM_THICKNESS],
            [px, (MAST_HEIGHT + LENS_HEIGHT) / 2, pz],
            heading,
          ),
        );
      }

      // Housing hanging over this lane's stop line, set back with the mast.
      const hx = sx - fxs * POLE_SETBACK;
      const hz = sz - fzs * POLE_SETBACK;
      hardwareGeos.push(
        hardwareBox(
          [HOUSING_DEPTH, HOUSING_HEIGHT, HOUSING_WIDTH],
          [hx, LENS_HEIGHT + HOUSING_HEIGHT * 0.16, hz],
          heading,
        ),
      );

      this.heads.push({ index: lensPositions.length, conns: headConns, last: -1 });
      // The lens sits on the face the approaching traffic sees.
      const face = HOUSING_DEPTH / 2 + LENS_RADIUS * 0.5;
      lensPositions.push([hx - fxs * face, LENS_HEIGHT, hz - fzs * face]);
    }
    const n = lensPositions.length;

    // --- hardware ------------------------------------------------------------
    // Kit masts and the procedural arms/housings share one galvanised-steel
    // material, so the whole intersection's hardware is a single merged mesh.
    let material = assets?.propMaterial;
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: 0x2a2f36,
        roughness: 0.55,
        metalness: 0.45,
      });
      this.ownedMaterials.push(material);
    }
    const hardware = new THREE.Mesh(mergeOrEmpty(hardwareGeos), material);
    hardware.name = "signal-hardware";
    hardware.castShadow = true;
    this.meshes.push(hardware);
    this.group.add(hardware);

    // --- lenses --------------------------------------------------------------
    this.lensMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.lensMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(LENS_RADIUS, 10, 8),
      this.lensMaterial,
      Math.max(n, 1),
    );
    this.lensMesh.name = "signal-lenses";
    this.lensMesh.frustumCulled = false;
    const dummy = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const [x, y, z] = lensPositions[i];
      dummy.makeTranslation(x, y, z);
      this.lensMesh.setMatrixAt(i, dummy);
      this.lensMesh.setColorAt(i, this.color.copy(STATE_COLORS[2]));
    }
    this.lensMesh.count = n;
    this.lensMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.lensMesh);

    // --- glow halos (one additive Points draw, billboarded for free) ----------
    const glowPositions = new Float32Array(n * 3);
    this.glowColors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      glowPositions[i * 3] = lensPositions[i][0];
      glowPositions[i * 3 + 1] = lensPositions[i][1];
      glowPositions[i * 3 + 2] = lensPositions[i][2];
      this.glowColors[i * 3] = STATE_COLORS[2].r;
      this.glowColors[i * 3 + 1] = STATE_COLORS[2].g;
      this.glowColors[i * 3 + 2] = STATE_COLORS[2].b;
    }
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
    const colorAttr = new THREE.BufferAttribute(this.glowColors, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    glowGeo.setAttribute("color", colorAttr);
    this.glowTexture = makeGlowTexture();
    this.glowMaterial = new THREE.PointsMaterial({
      // At fov 50 a point of `size` covers the pixels a world-space object of
      // size * tan(fov/2) ≈ size * 0.466 would.
      size: glowWorldSize(networkBounds(meta).extent) / 0.466,
      sizeAttenuation: true,
      map: this.glowTexture,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    clampPointSize(this.glowMaterial, 5, 44);
    this.glow = new THREE.Points(glowGeo, this.glowMaterial);
    this.glow.frustumCulled = false;
    this.glow.visible = n > 0;
    this.group.add(this.glow);
  }

  setTheme(spec: ThemeSpec): void {
    this.lensIntensity = spec.lensIntensity;
    this.glowIntensity = spec.glowIntensity;
    for (const head of this.heads) {
      this.writeState(head.index, STATE_COLORS[head.last === -1 ? 2 : head.last]);
    }
    if (this.lensMesh.instanceColor) this.lensMesh.instanceColor.needsUpdate = true;
    (this.glow.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Recolor every head from the frame's per-intersection signal records. */
  update(frame: TrajFrame): void {
    let dirty = false;
    for (const head of this.heads) {
      let state: HeadState = 2;
      for (const c of head.conns) {
        const sig = frame.signals[c.kIndex];
        if (!sig) continue;
        const phaseConns = c.intersectionPhases[sig.phase];
        const inPhase = phaseConns !== undefined && phaseConns.has(c.connId);
        if (inPhase && sig.state === 0) {
          state = 0;
          break; // green wins
        }
        if (inPhase && sig.state === 1 && state === 2) {
          state = 1;
        }
      }
      if (state !== head.last) {
        head.last = state;
        this.writeState(head.index, STATE_COLORS[state]);
        dirty = true;
      }
    }
    if (dirty) {
      if (this.lensMesh.instanceColor) this.lensMesh.instanceColor.needsUpdate = true;
      (this.glow.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  private writeState(index: number, tint: THREE.Color): void {
    this.lensMesh.setColorAt(index, this.color.copy(tint).multiplyScalar(this.lensIntensity));
    this.glowColors[index * 3] = tint.r * this.glowIntensity;
    this.glowColors[index * 3 + 1] = tint.g * this.glowIntensity;
    this.glowColors[index * 3 + 2] = tint.b * this.glowIntensity;
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.geometry.dispose();
    this.ownedMaterials.forEach((m) => m.dispose());
    this.lensMesh.geometry.dispose();
    this.lensMaterial.dispose();
    this.lensMesh.dispose();
    this.glow.geometry.dispose();
    this.glowMaterial.dispose();
    this.glowTexture.dispose();
  }
}

/**
 * Keep an attenuated Points sprite inside a pixel range. Without this a
 * world-sized halo is a couple of pixels across at overview zoom and a
 * screen-filling blob in a follow closeup — the exact complaint about the old
 * signal heads.
 */
export function clampPointSize(
  material: THREE.PointsMaterial,
  minPx: number,
  maxPx: number,
): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "gl_PointSize *= ( scale / - mvPosition.z );",
      `gl_PointSize = clamp( gl_PointSize * ( scale / - mvPosition.z ), ${minPx.toFixed(
        1,
      )}, ${maxPx.toFixed(1)} );`,
    );
  };
  material.customProgramCacheKey = () => `trafficlab-glow-${minPx}-${maxPx}`;
}
