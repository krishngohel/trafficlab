import * as THREE from "three";
import { pressureColor, type RGB } from "../../ramps";
import type { TrajFrame, TrajMeta } from "../../traj";
import { intersectionRadii } from "../roads";

/**
 * Pressure field: a translucent disc per intersection colored by the current
 * reward (rewards are negative pressure), on a symmetric diverging scale
 * around 0 — blue positive, red negative — with a gentle radius pulse whose
 * amplitude grows with |reward|.
 *
 * Every disc lives in one dynamic BufferGeometry with per-vertex RGBA, so the
 * whole field is a single draw call however many intersections a network has.
 */

const DISC_Y = 0.14;
const SEGMENTS = 40;
/** Vertices per disc: a centre plus a closed rim. */
const VERTS = SEGMENTS + 2;

export class PressureLayer {
  readonly group: THREE.Group;

  private readonly centers: { x: number; z: number; radius: number }[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly position: THREE.BufferAttribute;
  private readonly color: THREE.BufferAttribute;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly rgb: RGB = { r: 0, g: 0, b: 0 };
  private maxAbsReward = 1;

  constructor(meta: TrajMeta) {
    this.group = new THREE.Group();
    this.group.name = "pressure";
    this.group.visible = false;

    const radii = intersectionRadii(meta);
    const nodeById = new Map(meta.network.nodes.map((n) => [n.id, n]));
    const intersectionById = new Map(meta.network.intersections.map((i) => [i.id, i]));
    for (const id of meta.intersections_order) {
      const intersection = intersectionById.get(id);
      const node = intersection ? nodeById.get(intersection.node) : undefined;
      this.centers.push({
        x: node ? node.x : 0,
        z: node ? -node.y : 0,
        radius: ((intersection && radii.get(intersection.node)) || 10) * 1.7,
      });
    }

    const n = Math.max(this.centers.length, 1);
    const indices: number[] = [];
    for (let k = 0; k < this.centers.length; k++) {
      const base = k * VERTS;
      for (let i = 0; i < SEGMENTS; i++) {
        indices.push(base, base + 1 + i, base + 2 + i);
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(new Float32Array(n * VERTS * 3), 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.BufferAttribute(new Float32Array(n * VERTS * 4), 4);
    this.color.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("color", this.color);
    this.geometry.setIndex(indices);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.name = "pressureDiscs";
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  /** File-wide |reward| maximum (from the metrics scan), keeps the scale symmetric. */
  setScale(maxAbsReward: number): void {
    this.maxAbsReward = Math.max(maxAbsReward, 1e-6);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  update(a: TrajFrame, b: TrajFrame | null, t: number, wallSeconds: number): void {
    if (!this.group.visible) return;
    const n = Math.min(this.centers.length, a.rewards.length);
    const pulse = Math.sin(wallSeconds * Math.PI * 1.6);
    const pos = this.position.array as Float32Array;
    const col = this.color.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const disc = this.centers[k];
      const ra = a.rewards[k];
      const rb = b !== null && k < b.rewards.length ? b.rewards[k] : ra;
      const r = ra + (rb - ra) * t;
      const u = r / this.maxAbsReward;
      const mag = Math.min(Math.abs(u), 1);
      pressureColor(u, this.rgb);
      // Alpha floor keeps small-but-nonzero rewards visible.
      const alpha = 0.3 + 0.32 * mag;
      const radius = disc.radius * (0.7 + 0.4 * mag) * (1 + 0.05 * pulse * mag);

      const base = k * VERTS;
      for (let v = 0; v < VERTS; v++) {
        const o = (base + v) * 3;
        if (v === 0) {
          pos[o] = disc.x;
          pos[o + 2] = disc.z;
        } else {
          const angle = ((v - 1) / SEGMENTS) * Math.PI * 2;
          pos[o] = disc.x + Math.cos(angle) * radius;
          pos[o + 2] = disc.z + Math.sin(angle) * radius;
        }
        pos[o + 1] = DISC_Y;
        const c = (base + v) * 4;
        col[c] = this.rgb.r;
        col[c + 1] = this.rgb.g;
        col[c + 2] = this.rgb.b;
        col[c + 3] = alpha;
      }
    }
    this.position.needsUpdate = true;
    this.color.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
