import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clampPointSize } from "./signals";
import type { SceneAssets } from "./assets";
import type { ThemeSpec } from "./theme";
import type { TrajLane, TrajMeta } from "../traj";

/**
 * Street lamps down the kerb of every link — the roads-kit `light-square`
 * model, merged into one static mesh, with a warm additive spark at each lamp
 * head that only lights up in the night theme. Two draw calls, and the single
 * biggest thing that stops a night render reading as an empty void.
 */

const LAMP_HEIGHT = 7.4;
/** Spacing along the kerb (m). */
const LAMP_SPACING = 46;
/** Gap from the outermost lane edge out to the pole. */
const LAMP_CLEARANCE = 2.4;
const LAMP_COLOR = new THREE.Color(0xffd9a0);

export class StreetLampLayer {
  readonly group = new THREE.Group();

  private readonly mesh: THREE.Mesh | null = null;
  private readonly glow: THREE.Points | null = null;
  private readonly glowMaterial: THREE.PointsMaterial | null = null;
  private readonly glowTexture: THREE.CanvasTexture | null = null;

  constructor(meta: TrajMeta, assets: SceneAssets | null) {
    this.group.name = "streetlamps";
    if (!assets) return;

    const laneById = new Map(meta.network.lanes.map((l) => [l.id, l]));
    const parts: THREE.BufferGeometry[] = [];
    const heads: number[] = [];
    const proto = assets.lamp.geometry;
    const armReach = assets.lamp.armReach * LAMP_HEIGHT;

    for (const link of meta.network.links) {
      const lanes = link.lanes
        .map((id) => laneById.get(id))
        .filter((l): l is TrajLane => l !== undefined && l.polyline.length >= 2);
      if (lanes.length === 0) continue;
      // Kerb-side lane: the one with the smallest lateral offset (to the right).
      const ref = lanes[0].polyline;
      const p0 = ref[0];
      const p1 = ref[ref.length - 1];
      let dx = p1[0] - p0[0];
      let dy = p1[1] - p0[1];
      const length = Math.hypot(dx, dy);
      if (length < LAMP_SPACING * 0.6) continue;
      dx /= length;
      dy /= length;
      let kerb = lanes[0];
      let best = Infinity;
      for (const lane of lanes) {
        const mid = lane.polyline[Math.floor(lane.polyline.length / 2)];
        const off = (mid[0] - p0[0]) * -dy + (mid[1] - p0[1]) * dx;
        if (off < best) {
          best = off;
          kerb = lane;
        }
      }
      const kerbRef = kerb.polyline;
      const start = kerbRef[0];
      const end = kerbRef[kerbRef.length - 1];
      const span = Math.hypot(end[0] - start[0], end[1] - start[1]);
      const lateral = kerb.width / 2 + LAMP_CLEARANCE;
      const heading = Math.atan2(dy, dx);
      // Sim right-hand normal, mapped into the scene.
      const rxs = dy;
      const rzs = dx;
      const count = Math.max(1, Math.floor(span / LAMP_SPACING));
      for (let i = 0; i < count; i++) {
        const s = ((i + 0.5) / count) * span;
        const x = start[0] + dx * s;
        const y = start[1] + dy * s;
        const px = x + rxs * lateral;
        const pz = -y + rzs * lateral;
        const lamp = proto.clone();
        lamp.scale(LAMP_HEIGHT, LAMP_HEIGHT, LAMP_HEIGHT);
        lamp.rotateY(heading);
        lamp.translate(px, 0, pz);
        parts.push(lamp);
        // The kit arm reaches along the model's local -Z, which the rotation
        // above sends toward the road.
        heads.push(px - rxs * armReach, LAMP_HEIGHT * 0.95, pz - rzs * armReach);
      }
    }

    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    if (!merged) return;
    this.mesh = new THREE.Mesh(merged, assets.propMaterial);
    this.mesh.name = "streetlamp-poles";
    this.mesh.castShadow = false;
    this.group.add(this.mesh);

    const positions = new Float32Array(heads);
    const n = positions.length / 3;
    const colors = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.glowTexture = makeLampTexture();
    this.glowMaterial = new THREE.PointsMaterial({
      size: 3.4 / 0.466,
      sizeAttenuation: true,
      map: this.glowTexture,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    clampPointSize(this.glowMaterial, 3, 60);
    this.glow = new THREE.Points(geo, this.glowMaterial);
    this.glow.frustumCulled = false;
    this.glow.visible = false;
    this.group.add(this.glow);
  }

  setTheme(spec: ThemeSpec): void {
    if (!this.glow) return;
    this.glow.visible = spec.lampIntensity > 0;
    if (!this.glow.visible) return;
    const attr = this.glow.geometry.getAttribute("color") as THREE.BufferAttribute;
    const array = attr.array as Float32Array;
    for (let i = 0; i < array.length; i += 3) {
      array[i] = LAMP_COLOR.r * spec.lampIntensity;
      array[i + 1] = LAMP_COLOR.g * spec.lampIntensity;
      array[i + 2] = LAMP_COLOR.b * spec.lampIntensity;
    }
    attr.needsUpdate = true;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.glow?.geometry.dispose();
    this.glowMaterial?.dispose();
    this.glowTexture?.dispose();
    this.group.clear();
  }
}

function makeLampTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,0.8)");
    grad.addColorStop(0.3, "rgba(255,255,255,0.22)");
    grad.addColorStop(0.65, "rgba(255,255,255,0.05)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
