import * as THREE from "three";

import {
  buildEnvironment,
  buildRoads,
  groundPlaneSize,
  HorizonHaze,
  networkBounds,
  PhaseTimerLayer,
  PressureLayer,
  QueueHeatmapLayer,
  RibbonLayer,
  SignalLayer,
  StreetLampLayer,
  THEMES,
  VehicleLayer,
  type EnvironmentLayer,
  type NetworkBounds,
  type RoadLayer,
  type SceneAssets,
  type Theme,
  type VehiclePose,
} from "../scene";
import { seriesMax, seriesMaxAbs } from "../series";
import type { TrajFile, TrajFrame, TrajScan } from "../traj";
import { waitColumns, type WaitColumns } from "../wait";
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

/** Shadow-map resolution for the single directional light. */
const SHADOW_MAP = 2048;
/** Half-width of the shadow frustum, as a fraction of the camera's reach. */
const SHADOW_SPAN = 0.62;
const SHADOW_MIN = 55;
const SHADOW_MAX = 340;

/**
 * One loaded replay and everything needed to draw it: its own THREE.Scene,
 * static roads/scenery, vehicle/signal layers, and all overlay layers. Knows
 * nothing about React, the renderer, or the other side of a comparison.
 *
 * Lighting is a single key light (sun or moon) plus image-based lighting from
 * the theme's HDRI, with one 2048 shadow map whose frustum is retargeted every
 * frame around whatever the camera is looking at — a fixed frustum big enough
 * for a grid4x4 would put a whole car inside one shadow texel.
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
  /** Columns backing the mean-wait HUD. */
  readonly waitCols: WaitColumns;

  private readonly roads: RoadLayer;
  private readonly environment: EnvironmentLayer;
  private readonly lamps: StreetLampLayer;
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

  private readonly key: THREE.DirectionalLight;
  private readonly fill: THREE.HemisphereLight;
  private readonly fog: THREE.Fog;
  private readonly haze: HorizonHaze;
  private readonly diagonal: number;
  private theme: Theme = "day";
  private shadowSpan = 0;

  constructor(traj: TrajFile, assets: SceneAssets | null = null, theme: Theme = "day") {
    this.traj = traj;
    this.scan = traj.scanMeta();
    this.bounds = networkBounds(traj.meta);
    this.duration = Math.max(0, (traj.numFrames - 1) * traj.meta.dt);
    this.getFrame = (i) => traj.frame(i);

    this.delayCol = traj.meta.metrics.indexOf("cumulative_delay");
    this.throughputCol = traj.meta.metrics.indexOf("throughput");
    this.waitCols = waitColumns(traj.meta.metrics);

    this.scene = new THREE.Scene();
    this.diagonal = Math.max(
      Math.hypot(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY),
      300,
    );
    this.fog = new THREE.Fog(0xffffff, this.diagonal, this.diagonal * 3);
    this.scene.fog = this.fog;

    this.fill = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.3);
    this.scene.add(this.fill);

    this.key = new THREE.DirectionalLight(0xffffff, 1);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 900;
    this.key.shadow.normalBias = 0.05;
    this.scene.add(this.key, this.key.target);

    // Outside the ground plane, so the plane's edge is hidden behind the band
    // rather than cutting a line across the horizon.
    this.haze = new HorizonHaze(groundPlaneSize(this.bounds) * 0.62);

    this.roads = buildRoads(traj.meta, assets);
    this.environment = buildEnvironment(traj.meta, assets);
    this.lamps = new StreetLampLayer(traj.meta, assets);
    this.vehicles = new VehicleLayer(assets);
    this.vehicles.setNetwork(traj.meta);
    this.signals = new SignalLayer(traj.meta, assets);
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
      this.haze.mesh,
      this.roads.group,
      this.environment.group,
      this.lamps.group,
      this.vehicles.group,
      this.signals.group,
      this.queueHeat.group,
      this.phaseTimers.group,
      this.pressure.group,
      this.ribbons.line,
      this.highlight,
    );

    this.setTheme(theme, null, null);
    this.setShadowFocus(this.bounds.centerX, -this.bounds.centerY, this.bounds.extent);
  }

  /**
   * Apply a lighting look. `background` is the raw equirect HDRI and
   * `environment` its prefiltered radiance map — both come from the engine,
   * which owns the renderer PMREM needs. Passing null keeps the flat fallback.
   */
  setTheme(theme: Theme, background: THREE.Texture | null, environment: THREE.Texture | null): void {
    this.theme = theme;
    const spec = THEMES[theme];

    this.scene.background = background ?? new THREE.Color(spec.skyColor);
    this.scene.environment = environment;
    this.scene.environmentIntensity = spec.envIntensity;
    this.scene.backgroundIntensity = spec.backgroundIntensity;

    this.fog.color.setHex(spec.fogColor);
    this.fog.near = this.diagonal * spec.fogNear;
    this.fog.far = this.diagonal * spec.fogFar;

    this.fill.color.setHex(spec.skyFill);
    this.fill.groundColor.setHex(spec.groundFill);
    this.fill.intensity = spec.fillIntensity;

    this.key.color.setHex(spec.keyColor);
    this.key.intensity = spec.keyIntensity;
    this.key.shadow.bias = spec.shadowBias;

    this.haze.setTheme(spec);
    this.roads.setTheme(spec);
    this.environment.setTheme(spec);
    this.lamps.setTheme(spec);
    this.signals.setTheme(spec);
  }

  /**
   * Point the shadow frustum at what the camera is looking at. `reach` is the
   * camera's distance to its target, which sets how much ground needs crisp
   * shadows: a follow closeup gets ~55 m of tight shadow, an overview widens
   * out until the whole network is covered (coarsely, which is all it needs).
   */
  setShadowFocus(x: number, z: number, reach: number): void {
    const span = THREE.MathUtils.clamp(reach * SHADOW_SPAN, SHADOW_MIN, SHADOW_MAX);
    const dir = THEMES[this.theme].keyDirection;
    // Snap the focus to shadow-texel steps so a moving camera does not make the
    // shadow edges crawl.
    const step = (2 * span) / SHADOW_MAP;
    const fx = Math.round(x / step) * step;
    const fz = Math.round(z / step) * step;
    this.key.target.position.set(fx, 0, fz);
    this.key.position.set(fx + dir[0] * 320, dir[1] * 320, fz + dir[2] * 320);
    this.key.target.updateMatrixWorld();
    if (span !== this.shadowSpan) {
      this.shadowSpan = span;
      const camera = this.key.shadow.camera;
      camera.left = -span;
      camera.right = span;
      camera.top = span;
      camera.bottom = -span;
      camera.updateProjectionMatrix();
    }
  }

  /** Turn vehicle shadow casting on/off (the first thing to drop under load). */
  setVehicleShadows(cast: boolean): void {
    this.vehicles.setShadows(cast);
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
    this.queueHeat.update(frameA, frameB, t, wallMs);
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
    this.haze.dispose();
    this.roads.dispose();
    this.environment.dispose();
    this.lamps.dispose();
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
