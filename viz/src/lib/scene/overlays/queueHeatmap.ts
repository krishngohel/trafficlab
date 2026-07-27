import * as THREE from "three";
import { queueColor, type RGB } from "../../ramps";
import type { TrajFrame, TrajMeta } from "../../traj";
import { approachAnchors, networkBounds } from "../roads";
import { TextSprite } from "./textSprite";

/**
 * Queue heatmap: one colored ground quad per approach, anchored at the stop
 * line and growing upstream with the queue, colored green -> red by queue
 * length (normalized by the file-wide max). A small sprite shows the count.
 */

const QUAD_Y = 0.09;
const METERS_PER_QUEUED = 6.8; // ~ vehicle length + gap
const MIN_LENGTH = 3.5;

interface Cell {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  label: TextSprite;
  lastCount: number;
}

export class QueueHeatmapLayer {
  readonly group: THREE.Group;

  private readonly cells: Cell[] = [];
  private readonly geometry: THREE.PlaneGeometry;
  private readonly rgb: RGB = { r: 0, g: 0, b: 0 };
  private readonly color = new THREE.Color();
  private maxQueue = 8;

  constructor(meta: TrajMeta) {
    this.group = new THREE.Group();
    this.group.name = "queueHeatmap";
    this.group.visible = false;

    // Unit quad in the XZ plane whose local +X edge starts at the origin, so
    // scale.x stretches it upstream from the stop line.
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.geometry.rotateX(-Math.PI / 2);
    this.geometry.translate(0.5, 0, 0);

    // Label size follows the network extent so counts stay legible at the
    // default camera fit.
    const extent = networkBounds(meta).extent;
    const labelWidth = THREE.MathUtils.clamp(extent * 0.02, 6, 16);
    const labelHeight = THREE.MathUtils.clamp(extent * 0.013, 5, 11);

    const anchors = approachAnchors(meta);
    for (const anchor of anchors) {
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      // Local +X must point UPSTREAM (opposite travel). Sim upstream vector
      // (-dirX, -dirY) maps to scene (-dirX, 0, +dirY); rotation.y = theta
      // sends local +X to (cos theta, 0, -sin theta), so:
      mesh.rotation.y = Math.atan2(-anchor.dirY, -anchor.dirX);
      mesh.position.set(anchor.x, QUAD_Y, -anchor.y);
      mesh.scale.set(MIN_LENGTH, 1, Math.max(anchor.width + 1.2, 3));
      mesh.visible = false;
      this.group.add(mesh);

      const label = new TextSprite({ worldWidth: labelWidth, width: 128, height: 64 });
      label.sprite.position.set(anchor.x, labelHeight, -anchor.y);
      this.group.add(label.sprite);

      this.cells.push({ mesh, material, label, lastCount: -1 });
    }
  }

  /** File-wide queue maximum (from the metrics scan) for color normalization. */
  setScale(maxQueue: number): void {
    this.maxQueue = Math.max(maxQueue, 8);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  update(a: TrajFrame, b: TrajFrame | null, t: number): void {
    if (!this.group.visible) return;
    const n = Math.min(this.cells.length, a.queues.length);
    for (let i = 0; i < n; i++) {
      const cell = this.cells[i];
      const qa = a.queues[i];
      const qb = b !== null && i < b.queues.length ? b.queues[i] : qa;
      const q = qa + (qb - qa) * t;
      if (qa <= 0 && q <= 0) {
        if (cell.lastCount !== 0) {
          cell.mesh.visible = false;
          cell.label.setText("");
          cell.lastCount = 0;
        }
        continue;
      }
      cell.mesh.visible = true;
      cell.mesh.scale.x = MIN_LENGTH + q * METERS_PER_QUEUED;
      queueColor(q / this.maxQueue, this.rgb);
      cell.material.color.setRGB(this.rgb.r, this.rgb.g, this.rgb.b);
      if (qa !== cell.lastCount) {
        cell.label.setText(String(qa), "#f2f5f9");
        cell.lastCount = qa;
      }
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const cell of this.cells) {
      cell.material.dispose();
      cell.label.dispose();
    }
  }
}
