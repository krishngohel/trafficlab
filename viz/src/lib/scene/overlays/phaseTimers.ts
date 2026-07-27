import * as THREE from "three";
import type { TrajFrame, TrajMeta } from "../../traj";
import { TextSprite } from "./textSprite";

/**
 * One billboard per intersection showing the current phase name and seconds
 * in phase. Canvas text redraws are throttled to at most 4 Hz.
 */

const UPDATE_INTERVAL_MS = 250;
const STATE_COLORS = ["#59d98a", "#f0cb56", "#f07a72"]; // green / yellow / all-red
const STATE_SUFFIX = ["", " · Y", " · R"];

interface Timer {
  label: TextSprite;
  /** Phase names of the intersection at this order slot. */
  phaseNames: string[];
}

export class PhaseTimerLayer {
  readonly group: THREE.Group;

  private readonly timers: Timer[] = [];
  private lastDraw = 0;

  constructor(meta: TrajMeta) {
    this.group = new THREE.Group();
    this.group.name = "phaseTimers";
    this.group.visible = false;

    const nodeById = new Map(meta.network.nodes.map((n) => [n.id, n]));
    const intersectionById = new Map(meta.network.intersections.map((i) => [i.id, i]));
    for (const id of meta.intersections_order) {
      const intersection = intersectionById.get(id);
      const node = intersection ? nodeById.get(intersection.node) : undefined;
      const label = new TextSprite({
        worldWidth: 26,
        width: 320,
        height: 72,
        font: "600 40px ui-sans-serif, system-ui, sans-serif",
      });
      if (node) label.sprite.position.set(node.x, 17, -node.y);
      this.group.add(label.sprite);
      this.timers.push({
        label,
        phaseNames: intersection ? intersection.phases.map((p) => p.name) : [],
      });
    }
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

    const n = Math.min(this.timers.length, frame.signals.length);
    for (let k = 0; k < n; k++) {
      const timer = this.timers[k];
      const sig = frame.signals[k];
      const name = timer.phaseNames[sig.phase] ?? `P${sig.phase}`;
      const state = sig.state === 1 || sig.state === 2 ? sig.state : 0;
      const seconds = sig.timeInPhase + subFrameSeconds;
      timer.label.setText(
        `${name}${STATE_SUFFIX[state]}  ${seconds.toFixed(1)}s`,
        STATE_COLORS[state],
      );
    }
  }

  dispose(): void {
    for (const t of this.timers) t.label.dispose();
  }
}
