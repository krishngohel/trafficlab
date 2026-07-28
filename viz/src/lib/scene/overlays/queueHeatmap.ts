import * as THREE from "three";
import { queueColor, type RGB } from "../../ramps";
import type { TrajFrame, TrajMeta } from "../../traj";
import { approachAnchors, networkBounds } from "../roads";
import { LabelBatch } from "./labelBatch";

/**
 * Queue heatmap: one colored ground quad per approach, anchored at the stop
 * line and growing upstream with the queue, colored green -> red by queue
 * length (normalized by the file-wide max). A small label shows the count.
 *
 * Both halves are batched: every quad lives in ONE dynamic BufferGeometry
 * (per-vertex colour, hidden quads collapsed to zero area) and every count is a
 * cell in ONE `LabelBatch` atlas. A grid4x4 has 128 approaches, so the naive
 * mesh-and-sprite-per-approach version cost 256 draw calls on its own.
 */

const QUAD_Y = 0.09;
const METERS_PER_QUEUED = 6.8; // ~ vehicle length + gap
const MIN_LENGTH = 3.5;

interface Cell {
  /** Stop-line anchor, scene space. */
  x: number;
  z: number;
  /** Unit upstream direction (opposite travel), scene space. */
  ux: number;
  uz: number;
  /** Half width across the approach, scene space perpendicular. */
  px: number;
  pz: number;
  lastCount: number;
}

export class QueueHeatmapLayer {
  readonly group: THREE.Group;

  private readonly cells: Cell[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly position: THREE.BufferAttribute;
  private readonly color: THREE.BufferAttribute;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly labels: LabelBatch;
  private readonly rgb: RGB = { r: 0, g: 0, b: 0 };
  private maxQueue = 8;

  constructor(meta: TrajMeta) {
    this.group = new THREE.Group();
    this.group.name = "queueHeatmap";
    this.group.visible = false;

    // Label size follows the network extent so counts stay legible at the
    // default camera fit.
    const extent = networkBounds(meta).extent;
    const labelWidth = THREE.MathUtils.clamp(extent * 0.02, 6, 16);
    const labelHeight = THREE.MathUtils.clamp(extent * 0.013, 5, 11);

    const anchors = approachAnchors(meta);
    const n = Math.max(anchors.length, 1);
    this.labels = new LabelBatch({
      count: n,
      cellWidth: 96,
      cellHeight: 48,
      worldWidth: labelWidth,
      font: "600 30px ui-sans-serif, system-ui, sans-serif",
    });

    const positions = new Float32Array(n * 4 * 3);
    const colors = new Float32Array(n * 4 * 3);
    const indices: number[] = [];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      // Sim (x, y) -> scene (x, -z). Upstream is opposite the travel direction.
      const ux = -a.dirX;
      const uz = a.dirY;
      const halfWidth = Math.max(a.width + 1.2, 3) / 2;
      this.cells.push({
        x: a.x,
        z: -a.y,
        ux,
        uz,
        px: -uz * halfWidth,
        pz: ux * halfWidth,
        lastCount: -1,
      });
      const base = i * 4;
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      this.labels.setPosition(i, a.x, labelHeight, -a.y);
    }

    this.geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(positions, 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.BufferAttribute(colors, 3);
    this.color.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("color", this.color);
    this.geometry.setIndex(indices);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.name = "queueQuads";
    mesh.frustumCulled = false;
    this.group.add(mesh, this.labels.mesh);
  }

  /** File-wide queue maximum (from the metrics scan) for color normalization. */
  setScale(maxQueue: number): void {
    this.maxQueue = Math.max(maxQueue, 8);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  update(a: TrajFrame, b: TrajFrame | null, t: number, nowMs = 0): void {
    if (!this.group.visible) return;
    const n = Math.min(this.cells.length, a.queues.length);
    const pos = this.position.array as Float32Array;
    const col = this.color.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const cell = this.cells[i];
      const qa = a.queues[i];
      const qb = b !== null && i < b.queues.length ? b.queues[i] : qa;
      const q = qa + (qb - qa) * t;
      const o = i * 12;
      if (qa <= 0 && q <= 0) {
        if (cell.lastCount !== 0) {
          pos.fill(0, o, o + 12);
          this.labels.setText(i, "");
          cell.lastCount = 0;
        }
        continue;
      }
      const length = MIN_LENGTH + q * METERS_PER_QUEUED;
      const ex = cell.ux * length;
      const ez = cell.uz * length;
      // Stop-line edge, then the upstream edge, both offset across the width.
      pos[o] = cell.x + cell.px;
      pos[o + 1] = QUAD_Y;
      pos[o + 2] = cell.z + cell.pz;
      pos[o + 3] = cell.x - cell.px;
      pos[o + 4] = QUAD_Y;
      pos[o + 5] = cell.z - cell.pz;
      pos[o + 6] = cell.x + ex - cell.px;
      pos[o + 7] = QUAD_Y;
      pos[o + 8] = cell.z + ez - cell.pz;
      pos[o + 9] = cell.x + ex + cell.px;
      pos[o + 10] = QUAD_Y;
      pos[o + 11] = cell.z + ez + cell.pz;

      queueColor(q / this.maxQueue, this.rgb);
      for (let v = 0; v < 4; v++) {
        col[o + v * 3] = this.rgb.r;
        col[o + v * 3 + 1] = this.rgb.g;
        col[o + v * 3 + 2] = this.rgb.b;
      }
      if (qa !== cell.lastCount) {
        this.labels.setText(i, String(qa), "#f2f5f9");
        cell.lastCount = qa;
      }
    }
    this.position.needsUpdate = true;
    this.color.needsUpdate = true;
    this.labels.flush(nowMs);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.labels.dispose();
  }
}
