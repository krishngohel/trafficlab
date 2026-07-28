import * as THREE from "three";
import type { TrajFrame, TrajMeta } from "../../traj";
import { networkBounds } from "../roads";
import { LabelBatch } from "./labelBatch";

/**
 * One billboard per intersection showing the current phase name and seconds
 * in phase. All of them share a single batched label atlas (one draw call),
 * and canvas text redraws are throttled to at most 4 Hz.
 */

const UPDATE_INTERVAL_MS = 250;
const STATE_COLORS = ["#59d98a", "#f0cb56", "#f07a72"]; // green / yellow / all-red
const STATE_SUFFIX = ["", " · Y", " · R"];

export class PhaseTimerLayer {
  readonly group: THREE.Group;

  private readonly labels: LabelBatch;
  /** Phase names of the intersection at each order slot. */
  private readonly phaseNames: string[][] = [];
  private lastDraw = 0;

  constructor(meta: TrajMeta) {
    this.group = new THREE.Group();
    this.group.name = "phaseTimers";
    this.group.visible = false;

    // Scale labels with the network so they stay legible at the default fit.
    const extent = networkBounds(meta).extent;
    const worldWidth = THREE.MathUtils.clamp(extent * 0.062, 22, 64);
    const height = THREE.MathUtils.clamp(extent * 0.03, 14, 30);

    this.labels = new LabelBatch({
      count: Math.max(meta.intersections_order.length, 1),
      cellWidth: 256,
      cellHeight: 58,
      worldWidth,
      font: "600 34px ui-sans-serif, system-ui, sans-serif",
    });

    const nodeById = new Map(meta.network.nodes.map((n) => [n.id, n]));
    const intersectionById = new Map(meta.network.intersections.map((i) => [i.id, i]));
    meta.intersections_order.forEach((id, k) => {
      const intersection = intersectionById.get(id);
      const node = intersection ? nodeById.get(intersection.node) : undefined;
      if (node) this.labels.setPosition(k, node.x, height, -node.y);
      this.phaseNames.push(intersection ? intersection.phases.map((p) => p.name) : []);
    });
    this.group.add(this.labels.mesh);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    if (!visible) this.lastDraw = 0;
  }

  /**
   * `subFrameSeconds` is the interpolation offset (t * dt) added to the
   * frame's time_in_phase; `nowMs` is wall time used for the 4 Hz throttle.
   */
  update(frame: TrajFrame, subFrameSeconds: number, nowMs: number): void {
    if (!this.group.visible) return;
    if (nowMs - this.lastDraw < UPDATE_INTERVAL_MS) return;
    this.lastDraw = nowMs;

    const n = Math.min(this.phaseNames.length, frame.signals.length);
    for (let k = 0; k < n; k++) {
      const sig = frame.signals[k];
      const name = this.phaseNames[k][sig.phase] ?? `P${sig.phase}`;
      const state = sig.state === 1 || sig.state === 2 ? sig.state : 0;
      const seconds = sig.timeInPhase + subFrameSeconds;
      this.labels.setText(
        k,
        `${name}${STATE_SUFFIX[state]}  ${seconds.toFixed(1)}s`,
        STATE_COLORS[state],
      );
    }
    this.labels.flush(nowMs);
  }

  dispose(): void {
    this.labels.dispose();
  }
}
