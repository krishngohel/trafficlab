import * as THREE from "three";
import { pressureColor, type RGB } from "../../ramps";
import type { TrajFrame, TrajMeta } from "../../traj";
import { intersectionRadii } from "../roads";

/**
 * Pressure field: a translucent disc per intersection colored by the current
 * reward (rewards are negative pressure), on a symmetric diverging scale
 * around 0 — blue positive, red negative — with a gentle radius pulse whose
 * amplitude grows with |reward|.
 */

const DISC_Y = 0.14;

interface Disc {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  baseRadius: number;
}

export class PressureLayer {
  readonly group: THREE.Group;

  private readonly discs: Disc[] = [];
  private readonly geometry: THREE.CircleGeometry;
  private readonly rgb: RGB = { r: 0, g: 0, b: 0 };
  private maxAbsReward = 1;

  constructor(meta: TrajMeta) {
    this.group = new THREE.Group();
    this.group.name = "pressure";
    this.group.visible = false;

    this.geometry = new THREE.CircleGeometry(1, 40);
    this.geometry.rotateX(-Math.PI / 2);

    const radii = intersectionRadii(meta);
    const nodeById = new Map(meta.network.nodes.map((n) => [n.id, n]));
    const intersectionById = new Map(meta.network.intersections.map((i) => [i.id, i]));
    for (const id of meta.intersections_order) {
      const intersection = intersectionById.get(id);
      const node = intersection ? nodeById.get(intersection.node) : undefined;
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      const baseRadius = ((intersection && radii.get(intersection.node)) || 10) * 1.7;
      if (node) mesh.position.set(node.x, DISC_Y, -node.y);
      mesh.scale.setScalar(baseRadius);
      this.group.add(mesh);
      this.discs.push({ mesh, material, baseRadius });
    }
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
    const n = Math.min(this.discs.length, a.rewards.length);
    const pulse = Math.sin(wallSeconds * Math.PI * 1.6);
    for (let k = 0; k < n; k++) {
      const disc = this.discs[k];
      const ra = a.rewards[k];
      const rb = b !== null && k < b.rewards.length ? b.rewards[k] : ra;
      const r = ra + (rb - ra) * t;
      const u = r / this.maxAbsReward;
      const mag = Math.min(Math.abs(u), 1);
      pressureColor(u, this.rgb);
      disc.material.color.setRGB(this.rgb.r, this.rgb.g, this.rgb.b);
      disc.material.opacity = 0.16 + 0.3 * mag;
      disc.mesh.scale.setScalar(disc.baseRadius * (0.65 + 0.45 * mag) * (1 + 0.05 * pulse * mag));
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const d of this.discs) d.material.dispose();
  }
}
