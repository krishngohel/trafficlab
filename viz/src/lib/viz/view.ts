import * as THREE from "three";

import {
  buildRoads,
  disposeGroup,
  networkBounds,
  PhaseTimerLayer,
  PressureLayer,
  QueueHeatmapLayer,
  RibbonLayer,
  SignalLayer,
  VehicleLayer,
  type NetworkBounds,
  type VehiclePose,
} from "../scene";
import { seriesMax, seriesMaxAbs } from "../series";
import type { TrajFile, TrajFrame, TrajScan } from "../traj";
import type { PlaybackClock } from "./playback";

export interface OverlayToggles {
  queues: boolean;
  timers: boolean;
  speedColor: boolean;
  ribbons: boolean;
  ribbonsAll: boolean;
  pressure: boolean;
}

export const DEFAULT_TOGGLES: OverlayToggles = {
  queues: false,
  timers: false,
  speedColor: false,
  ribbons: false,
  ribbonsAll: false,
  pressure: false,
};

/**
 * One loaded replay and everything needed to draw it: its own THREE.Scene,
 * static roads, vehicle/signal layers, and all overlay layers. Knows nothing
 * about React, the renderer, or the other side of a comparison.
 */
export class SceneView {
  readonly traj: TrajFile;
  readonly scan: TrajScan;
  readonly bounds: NetworkBounds;
  readonly scene: THREE.Scene;
  readonly vehicles: VehicleLayer;
  readonly duration: number;

  /** Column indices into scan.metrics for the live HUD (or -1 if absent). */
  readonly delayCol: number;
  readonly throughputCol: number;

  private readonly roads: THREE.Group;
  private readonly signals: SignalLayer;
  private readonly queueHeat: QueueHeatmapLayer;
  private readonly phaseTimers: PhaseTimerLayer;
  private readonly pressure: PressureLayer;
  private readonly ribbons: RibbonLayer;
  private readonly highlight: THREE.Mesh;
  private readonly highlightMaterial: THREE.MeshBasicMaterial;
  private readonly pose: VehiclePose = { x: 0, y: 0, heading: 0, speed: 0 };
  private readonly getFrame: (i: number) => TrajFrame;
  private lastSignalFrame = -1;

  constructor(traj: TrajFile) {
    this.traj = traj;
    this.scan = traj.scanMeta();
    this.bounds = networkBounds(traj.meta);
    this.duration = Math.max(0, (traj.numFrames - 1) * traj.meta.dt);
    this.getFrame = (i) => traj.frame(i);

    this.delayCol = traj.meta.metrics.indexOf("cumulative_delay");
    this.throughputCol = traj.meta.metrics.indexOf("throughput");

    this.scene = new THREE.Scene();
    // Very dark desaturated blue night sky with matching linear fog whose far
    // plane sits ~3x the network diagonal out.
    const sky = new THREE.Color(0x0b0e14);
    const diagonal = Math.max(
      Math.hypot(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY),
      300,
    );
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, diagonal * 1.5, diagonal * 3);
    // Cool sky dome + warm ground bounce, and one warm key light at ~45°.
    this.scene.add(new THREE.HemisphereLight(0x93aad4, 0x30291f, 1.25));
    const sun = new THREE.DirectionalLight(0xffe7c4, 2.5);
    sun.position.set(0.7, 0.85, 0.45).multiplyScalar(400);
    this.scene.add(sun);

    this.roads = buildRoads(traj.meta);
    this.vehicles = new VehicleLayer();
    this.vehicles.setNetwork(traj.meta);
    this.signals = new SignalLayer(traj.meta);
    this.queueHeat = new QueueHeatmapLayer(traj.meta);
    this.queueHeat.setScale(seriesMax(this.scan.queues));
    this.phaseTimers = new PhaseTimerLayer(traj.meta);
    this.pressure = new PressureLayer(traj.meta);
    this.pressure.setScale(seriesMaxAbs(this.scan.rewards));
    this.ribbons = new RibbonLayer(traj.meta.dt);

    this.highlightMaterial = new THREE.MeshBasicMaterial({
      color: 0x8fd0ff,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.highlight = new THREE.Mesh(new THREE.RingGeometry(2.3, 2.75, 40), this.highlightMaterial);
    this.highlight.rotation.x = -Math.PI / 2;
    this.highlight.position.y = 0.3;
    this.highlight.visible = false;

    this.scene.add(
      this.roads,
      this.vehicles.mesh,
      this.signals.group,
      this.queueHeat.group,
      this.phaseTimers.group,
      this.pressure.group,
      this.ribbons.line,
      this.highlight,
    );
  }

  applyToggles(t: OverlayToggles): void {
    this.vehicles.colorMode = t.speedColor ? "speed" : "id";
    this.queueHeat.setVisible(t.queues);
    this.phaseTimers.setVisible(t.timers);
    this.pressure.setVisible(t.pressure);
    this.ribbons.allVehicles = t.ribbonsAll;
    this.ribbons.setVisible(t.ribbons || t.ribbonsAll);
  }

  /**
   * Advance this view to the shared clock. `selectedId` is the followed
   * vehicle if it belongs to this view, else -1. Returns true if the
   * selected vehicle is still present (false triggers follow exit).
   */
  updateFrame(
    clock: PlaybackClock,
    selectedId: number,
    wallMs: number,
    wallSeconds: number,
  ): boolean {
    const traj = this.traj;
    if (traj.numFrames === 0) return false;
    const f = clock.frameAt(traj.meta.dt, traj.numFrames);
    const fa = Math.floor(f);
    const fb = Math.min(fa + 1, traj.numFrames - 1);
    const t = f - fa;

    const frameA = traj.frame(fa);
    const frameB = fb !== fa ? traj.frame(fb) : null;
    this.vehicles.update(frameA, frameB, t);
    if (this.lastSignalFrame !== fa) {
      this.signals.update(frameA);
      this.lastSignalFrame = fa;
    }
    this.queueHeat.update(frameA, frameB, t);
    this.phaseTimers.update(frameA, t * traj.meta.dt, wallMs);
    this.pressure.update(frameA, frameB, t, wallSeconds);
    this.ribbons.advanceTo(fa, this.getFrame, selectedId);

    // Selection highlight ring.
    let found = false;
    if (selectedId >= 0 && this.vehicles.getPose(selectedId, this.pose)) {
      found = true;
      this.highlight.position.set(this.pose.x, 0.3, -this.pose.y);
      this.highlight.rotation.z = wallSeconds * 0.9;
      this.highlightMaterial.opacity = 0.55 + 0.2 * Math.sin(wallSeconds * 3);
      this.highlight.visible = true;
    } else {
      this.highlight.visible = false;
    }
    return found;
  }

  /** Current integer frame for this view under the shared clock. */
  frameIndexAt(clock: PlaybackClock): number {
    return Math.floor(clock.frameAt(this.traj.meta.dt, this.traj.numFrames));
  }

  /** Metric value at the clock's current frame, by scan column (-1 -> NaN). */
  metricAt(clock: PlaybackClock, col: number): number {
    if (col < 0 || this.scan.m === 0) return NaN;
    return this.scan.metrics[this.frameIndexAt(clock) * this.scan.m + col];
  }

  getVehiclePose(id: number, out: VehiclePose): boolean {
    return this.vehicles.getPose(id, out);
  }

  dispose(): void {
    disposeGroup(this.roads);
    this.vehicles.dispose();
    this.signals.dispose();
    this.queueHeat.dispose();
    this.phaseTimers.dispose();
    this.pressure.dispose();
    this.ribbons.dispose();
    this.highlight.geometry.dispose();
    this.highlightMaterial.dispose();
  }
}
