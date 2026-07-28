import * as THREE from "three";

import {
  buildEnvironmentMap,
  loadedAssets,
  loadSceneAssets,
  THEMES,
  type SceneAssets,
  type Theme,
  type VehiclePose,
} from "../scene";
import { parseTraj, type TrajMeta } from "../traj";
import { CameraRig, type CameraMode } from "./cameras";
import { PlaybackClock } from "./playback";
import { CanvasRecorder, downloadBlob, sanitizeFilePart } from "./recorder";
import { DEFAULT_TOGGLES, SceneView, type OverlayToggles } from "./view";

export type { CameraMode } from "./cameras";
export type { OverlayToggles } from "./view";
export type { Theme } from "../scene";

/** Static facts about a loaded side, safe to hold in React state. */
export interface SideInfo {
  name: string;
  policy: string;
  networkName: string;
  seed: number | null;
  numFrames: number;
  dt: number;
  duration: number;
  intersectionIds: number[];
  metricNames: string[];
}

export interface RecordOptions {
  /** true: record frame 0 -> end; false: current position -> end. */
  fullFile: boolean;
  /** Playback speed while recording. */
  speed: number;
}

const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;

declare global {
  interface Window {
    /** Set by the live engine so headless scripts can inspect it. */
    trafficlabViz?: VizEngine;
  }
}

/**
 * Owns the renderer, the render loop, both scene views (split-screen), the
 * camera rig, picking, vehicle following, and video recording. React never
 * touches three.js objects — it calls methods here and subscribes to
 * `afterFrame` for HUD-frequency updates.
 */
export class VizEngine {
  readonly clock = new PlaybackClock();

  /** While true the clock does not advance (a slider/chart is being dragged). */
  private scrubbingFlag = false;

  /** Fired every rendered frame, after the scene update (HUD/canvas sync). */
  readonly afterFrame = new Set<() => void>();

  // Assignable event callbacks (React wires these up once).
  onFollowChange: (id: number | null) => void = () => {};
  onAutoPause: () => void = () => {};
  onRecordingChange: (recording: boolean) => void = () => {};
  onToast: (message: string) => void = () => {};

  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly rig: CameraRig;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly vec = new THREE.Vector3();
  private readonly pose: VehiclePose = { x: 0, y: 0, heading: 0, speed: 0 };
  private readonly recorder = new CanvasRecorder();

  private views: [SceneView | null, SceneView | null] = [null, null];
  private toggles: OverlayToggles = { ...DEFAULT_TOGGLES };
  private compareActive = false;
  private splitFraction = 0.5;
  private follow: { side: 0 | 1; id: number } | null = null;
  private themeName: Theme = "day";
  private assets: SceneAssets | null = null;
  /** Draw-call budget check: logged once, a few frames after the first load. */
  private statsFrame = -1;

  private recording = false;
  private recordCancelled = false;
  private recordEnd = 0;
  private savedState: { time: number; playing: boolean; speed: number; loop: boolean } | null =
    null;

  private width = 1;
  private height = 1;
  private raf = 0;
  private lastTime = 0;
  private readonly resizeObserver: ResizeObserver;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = THEMES[this.themeName].exposure;
    this.renderer.setClearColor(THEMES[this.themeName].skyColor);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.assets = loadedAssets();
    this.width = Math.max(host.clientWidth, 1);
    this.height = Math.max(host.clientHeight, 1);
    this.renderer.setSize(this.width, this.height);
    host.appendChild(this.renderer.domElement);

    this.rig = new CameraRig(this.renderer.domElement);

    this.resizeObserver = new ResizeObserver(() => {
      this.width = Math.max(host.clientWidth, 1);
      this.height = Math.max(host.clientHeight, 1);
      this.renderer.setSize(this.width, this.height);
    });
    this.resizeObserver.observe(host);

    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    // Headless-test handle: the playwright drivers in scripts/ read follow
    // state and camera poses through this. Nothing in the app uses it.
    window.trafficlabViz = this;
  }

  /** Live camera world position — the headless camera-tracking checks read it. */
  cameraPose(): { x: number; y: number; z: number } {
    const p = this.rig.activeCamera().position;
    return { x: p.x, y: p.y, z: p.z };
  }

  /**
   * Place the orbit camera exactly, for the headless review scripts that need
   * reproducible framing. Nothing in the app calls this.
   */
  setCameraPose(
    target: { x: number; y?: number; z: number },
    position: { x: number; y: number; z: number },
  ): void {
    if (this.follow) this.exitFollow();
    this.rig.setPose(
      this.vec.set(target.x, target.y ?? 0, target.z),
      new THREE.Vector3(position.x, position.y, position.z),
    );
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get isCompare(): boolean {
    return this.compareActive;
  }

  get split(): number {
    return this.splitFraction;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get cameraMode(): CameraMode {
    return this.rig.mode;
  }

  get theme(): Theme {
    return this.themeName;
  }

  getView(side: 0 | 1): SceneView | null {
    return side === 1 && !this.compareActive ? null : this.views[side];
  }

  // --- assets / theme --------------------------------------------------------

  /**
   * Fetch the model/texture/HDRI bundle (idempotent, shared page-wide). React
   * awaits this before handing over a .traj so a scene is never built with a
   * half-loaded art set.
   */
  async ensureAssets(): Promise<void> {
    if (this.assets) return;
    try {
      this.assets = await loadSceneAssets();
      console.log(
        `[trafficlab] assets ready in ${this.assets.loadMs.toFixed(0)} ms` +
          (this.assets.bytes ? ` (${(this.assets.bytes / 1024).toFixed(0)} KB)` : ""),
      );
      this.applyTheme();
    } catch (err) {
      console.warn("[trafficlab] asset load failed, falling back to procedural scenery", err);
    }
  }

  /** Milliseconds the asset bundle took to load, or -1 if it has not. */
  get assetLoadMs(): number {
    return this.assets?.loadMs ?? -1;
  }

  get assetBytes(): number {
    return this.assets?.bytes ?? 0;
  }

  /** Live renderer counters, for the headless perf checks. */
  renderStats(): { calls: number; triangles: number; programs: number } {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      programs: this.renderer.info.programs?.length ?? 0,
    };
  }

  setTheme(theme: Theme): void {
    if (theme === this.themeName) return;
    this.themeName = theme;
    this.applyTheme();
  }

  private applyTheme(): void {
    const spec = THEMES[this.themeName];
    this.renderer.toneMappingExposure = spec.exposure;
    this.renderer.setClearColor(spec.skyColor);
    const hdr = this.assets?.hdri[this.themeName] ?? null;
    const environment = hdr ? buildEnvironmentMap(this.renderer, hdr) : null;
    for (const view of this.views) view?.setTheme(this.themeName, hdr, environment);
  }

  // --- loading -------------------------------------------------------------

  loadPrimary(buffer: ArrayBuffer, name: string): SideInfo {
    const traj = parseTraj(buffer); // throws TrajParseError on bad input
    const view = new SceneView(traj, this.assets, this.themeName);
    this.closeCompare();
    this.views[0]?.dispose();
    this.views[0] = view;
    view.applyToggles(this.toggles);
    this.exitFollow();
    this.clock.duration = view.duration;
    this.clock.seek(0);
    this.clock.playing = true;
    this.rig.frameNetwork(view.bounds);
    this.applyTheme();
    this.statsFrame = 0;
    return VizEngine.sideInfo(traj.meta, name, traj.numFrames, view.duration);
  }

  /** Load the comparison file. Returns non-blocking warnings (seed/network). */
  loadCompare(buffer: ArrayBuffer, name: string): { info: SideInfo; warnings: string[] } {
    const primary = this.views[0];
    if (!primary) throw new Error("load a primary .traj before comparing");
    const traj = parseTraj(buffer);
    const view = new SceneView(traj, this.assets, this.themeName);
    this.views[1]?.dispose();
    this.views[1] = view;
    view.applyToggles(this.toggles);
    this.compareActive = true;
    this.clock.duration = Math.max(primary.duration, view.duration);
    this.applyTheme();

    const a = primary.traj.meta;
    const b = traj.meta;
    const warnings: string[] = [];
    if (a.network_name !== b.network_name) {
      warnings.push(`Networks differ: ${a.network_name} vs ${b.network_name}`);
    }
    if (a.seed !== b.seed) {
      warnings.push(`Seeds differ: ${a.seed ?? "null"} vs ${b.seed ?? "null"}`);
    }
    return {
      info: VizEngine.sideInfo(b, name, traj.numFrames, view.duration),
      warnings,
    };
  }

  closeCompare(): void {
    if (this.follow?.side === 1) this.exitFollow();
    this.views[1]?.dispose();
    this.views[1] = null;
    this.compareActive = false;
    if (this.views[0]) this.clock.duration = this.views[0].duration;
  }

  private static sideInfo(
    meta: TrajMeta,
    name: string,
    numFrames: number,
    duration: number,
  ): SideInfo {
    return {
      name,
      policy: meta.policy ?? "unknown",
      networkName: meta.network_name ?? "unknown",
      seed: meta.seed ?? null,
      numFrames,
      dt: meta.dt,
      duration,
      intersectionIds: [...meta.intersections_order],
      metricNames: [...meta.metrics],
    };
  }

  // --- playback / overlays / cameras ---------------------------------------

  get scrubbing(): boolean {
    return this.scrubbingFlag;
  }

  setScrubbing(value: boolean): void {
    this.scrubbingFlag = value;
  }

  setPlaying(value: boolean): void {
    if (this.recording) return;
    this.clock.playing = value;
  }

  setSpeed(value: number): void {
    if (this.recording) return;
    this.clock.speed = value;
  }

  seek(time: number): void {
    this.clock.seek(time);
  }

  stepFrames(delta: number): void {
    this.clock.stepFrames(this.primaryDt(), delta);
  }

  setToggles(toggles: OverlayToggles): void {
    this.toggles = { ...toggles };
    for (const view of this.views) view?.applyToggles(this.toggles);
  }

  setSplit(fraction: number): void {
    this.splitFraction = Math.min(Math.max(fraction, MIN_SPLIT), MAX_SPLIT);
  }

  primaryDt(): number {
    return this.views[0]?.traj.meta.dt ?? 0.5;
  }

  setCameraMode(mode: Exclude<CameraMode, "follow">): void {
    if (this.follow) {
      this.follow = null;
      this.onFollowChange(null);
    }
    this.rig.setMode(mode);
  }

  /** Click-to-follow: raycast the vehicle InstancedMesh under the pointer. */
  pick(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    let side: 0 | 1 = 0;
    let vx = 0;
    let vw = rect.width;
    if (this.compareActive && this.views[1]) {
      const wl = rect.width * this.splitFraction;
      if (px >= wl) {
        side = 1;
        vx = wl;
        vw = rect.width - wl;
      } else {
        vw = wl;
      }
    }
    const view = this.views[side];
    if (!view || vw <= 0) return;

    this.ndc.set(((px - vx) / vw) * 2 - 1, -(py / rect.height) * 2 + 1);
    this.rig.applyAspect(vw / rect.height);
    const camera = this.rig.activeCamera();
    // The pointer event can arrive between renders (and OrbitControls damping
    // moves the camera outside of render), so refresh the world matrix before
    // building the ray from it.
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, camera);
    const id = view.vehicles.pick(this.raycaster);
    if (id >= 0) this.beginFollow(side, id);
  }

  beginFollow(side: 0 | 1, id: number): void {
    const view = this.views[side];
    if (!view || !view.getVehiclePose(id, this.pose)) return;
    this.follow = { side, id };
    this.vec.set(this.pose.x, 1.0, -this.pose.y);
    this.rig.beginFollow(this.vec, this.pose.heading);
    this.onFollowChange(id);
  }

  exitFollow(): void {
    if (!this.follow) return;
    this.follow = null;
    this.rig.setMode("orbit");
    this.onFollowChange(null);
  }

  get followedId(): number | null {
    return this.follow?.id ?? null;
  }

  // --- recording -------------------------------------------------------------

  /** Returns an error message, or null when recording started. */
  startRecording(options: RecordOptions): string | null {
    const primary = this.views[0];
    if (!primary) return "Load a .traj file first";
    if (this.recording) return "Already recording";

    const started = this.recorder.start(this.renderer.domElement, (blob) => {
      if (blob) {
        const meta = primary.traj.meta;
        const file = `${sanitizeFilePart(meta.policy ?? "replay")}_${sanitizeFilePart(
          meta.network_name ?? "network",
        )}.webm`;
        downloadBlob(blob, file);
        this.onToast(`Saved ${file}`);
      } else if (!this.recordCancelled) {
        // Never fail silently: an empty blob means the capture stream handed
        // the encoder no frames, and the user would otherwise see nothing.
        this.onToast("Recording produced no video — nothing was saved");
      }
      const saved = this.savedState;
      if (saved) {
        this.clock.loop = saved.loop;
        this.clock.speed = saved.speed;
        this.clock.seek(saved.time);
        this.clock.playing = saved.playing;
        this.savedState = null;
      }
      this.recording = false;
      this.onRecordingChange(false);
    });
    if (!started) return "Video recording is not supported in this browser";

    this.savedState = {
      time: this.clock.time,
      playing: this.clock.playing,
      speed: this.clock.speed,
      loop: this.clock.loop,
    };
    this.clock.loop = false;
    this.clock.speed = options.speed;
    if (options.fullFile || this.clock.time >= this.clock.duration - 1e-6) {
      this.clock.seek(0);
    }
    this.clock.playing = true;
    this.recordEnd = this.clock.duration;
    this.recording = true;
    this.recordCancelled = false;
    this.onRecordingChange(true);
    return null;
  }

  stopRecording(cancel = false): void {
    if (!this.recording) return;
    this.recordCancelled = cancel;
    this.recorder.stop(cancel);
  }

  // --- render loop -----------------------------------------------------------

  private readonly tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const dtReal = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;
    const wallSeconds = now / 1000;

    if (!this.scrubbing) {
      const wasPlaying = this.clock.playing;
      this.clock.advance(dtReal);
      if (wasPlaying && !this.clock.playing && !this.recording) this.onAutoPause();
    }
    if (this.recording && (this.clock.time >= this.recordEnd - 1e-9 || !this.clock.playing)) {
      this.stopRecording(false);
    }

    const followSide = this.follow ? this.follow.side : -1;
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const view = this.views[s];
      if (!view || (s === 1 && !this.compareActive)) continue;
      const selectedId = followSide === s && this.follow ? this.follow.id : -1;
      const found = view.updateFrame(this.clock, selectedId, now, wallSeconds);
      if (followSide === s && this.follow) {
        if (!found) {
          this.onToast(`Vehicle #${this.follow.id} left the network`);
          this.exitFollow();
        } else {
          view.getVehiclePose(this.follow.id, this.pose);
          this.vec.set(this.pose.x, 1.0, -this.pose.y);
          this.rig.updateFollow(this.vec, dtReal);
        }
      }
    }

    this.rig.update();
    this.focusShadows();
    this.renderFrame();
    if (this.statsFrame >= 0 && ++this.statsFrame === 30) {
      this.statsFrame = -1;
      const stats = this.renderStats();
      console.log(
        `[trafficlab] draw calls ${stats.calls}, triangles ${stats.triangles.toLocaleString()}, ` +
          `programs ${stats.programs}, theme ${this.themeName}`,
      );
    }
    // Offer the just-drawn frame to the recorder while the WebGL drawing buffer
    // is still intact. The recorder rate-limits internally: capturing every
    // rendered frame overruns the browser's readback/encode pipeline on dense
    // scenes and yields an empty video.
    if (this.recording) this.recorder.captureFrame(now);
    for (const cb of this.afterFrame) cb();
  };

  /**
   * Retarget both views' shadow frusta at whatever the camera is looking at,
   * sized by how far away it is — one 2048 map covering a whole grid4x4 would
   * put an entire car inside a single texel.
   */
  private focusShadows(): void {
    const target = this.rig.focus();
    for (const view of this.views) view?.setShadowFocus(target.x, target.z, target.reach);
  }

  private renderFrame(): void {
    const renderer = this.renderer;
    const w = this.width;
    const h = this.height;
    const camera = this.rig.activeCamera();
    const left = this.views[0];
    const right = this.compareActive ? this.views[1] : null;

    if (!left) {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      renderer.clear();
      return;
    }
    if (!right) {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      this.rig.applyAspect(w / h);
      renderer.render(left.scene, camera);
      return;
    }

    // Split view: clear the whole canvas (divider gap keeps the clear color),
    // then render each side scissored with the shared camera pose.
    const wl = Math.max(1, Math.round(w * this.splitFraction) - 1);
    const wr = Math.max(1, w - wl - 2);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.clear();
    renderer.setScissorTest(true);

    renderer.setViewport(0, 0, wl, h);
    renderer.setScissor(0, 0, wl, h);
    this.rig.applyAspect(wl / h);
    renderer.render(left.scene, camera);

    renderer.setViewport(wl + 2, 0, wr, h);
    renderer.setScissor(wl + 2, 0, wr, h);
    this.rig.applyAspect(wr / h);
    renderer.render(right.scene, camera);
  }

  dispose(): void {
    if (window.trafficlabViz === this) delete window.trafficlabViz;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.recorder.stop(true);
    this.views[0]?.dispose();
    this.views[1]?.dispose();
    this.views = [null, null];
    this.rig.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.afterFrame.clear();
  }
}
