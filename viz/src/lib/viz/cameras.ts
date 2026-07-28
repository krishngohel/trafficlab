import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { NetworkBounds } from "../scene";
import { fitOrtho, followOffset, smoothAlpha } from "./cameraMath";

export type CameraMode = "orbit" | "top" | "follow";

const FOLLOW_BACK = 22; // m behind the vehicle on follow start
const FOLLOW_UP = 9;
const FOLLOW_RATE = 5; // exponential smoothing rate (1/s)

/**
 * Owns the perspective (orbit / follow) and orthographic (top-down) cameras
 * plus their controls. One rig drives every viewport — in split-screen the
 * same pose renders both sides, only the aspect differs per side.
 */
export class CameraRig {
  mode: CameraMode = "orbit";

  readonly persp: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;

  private readonly orbitControls: OrbitControls;
  private readonly topControls: OrbitControls;
  private bounds: NetworkBounds | null = null;
  /** Ortho half-height at zoom 1, set when fitted; width follows aspect. */
  private orthoHalfH = 120;
  private readonly smoothTarget = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  constructor(dom: HTMLElement) {
    this.persp = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    this.persp.position.set(90, 110, 140);
    this.orbitControls = new OrbitControls(this.persp, dom);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.maxPolarAngle = Math.PI / 2 - 0.02;

    this.ortho = new THREE.OrthographicCamera(-120, 120, 120, -120, 0.1, 4000);
    this.ortho.position.set(0, 900, 0);
    this.ortho.up.set(0, 0, -1); // sim north (=-z) points up on screen
    this.ortho.lookAt(0, 0, 0);
    this.topControls = new OrbitControls(this.ortho, dom);
    this.topControls.enableRotate = false; // rotation locked: pan + zoom only
    this.topControls.screenSpacePanning = true;
    this.topControls.enableDamping = true;
    this.topControls.dampingFactor = 0.08;
    this.topControls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.topControls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    this.topControls.enabled = false;
  }

  activeCamera(): THREE.Camera {
    return this.mode === "top" ? this.ortho : this.persp;
  }

  /**
   * What the active camera is looking at, plus how much ground it can see —
   * the shadow-frustum driver. Top-down is orthographic, so its reach comes
   * from the fitted half-height instead of a distance.
   */
  focus(): { x: number; z: number; reach: number } {
    if (this.mode === "top") {
      const t = this.topControls.target;
      return { x: t.x, z: t.z, reach: (this.orthoHalfH / this.ortho.zoom) * 2 };
    }
    const t = this.orbitControls.target;
    return { x: t.x, z: t.z, reach: this.persp.position.distanceTo(t) };
  }

  /** Initial framing of a freshly loaded network (orbit + top-down). */
  frameNetwork(bounds: NetworkBounds): void {
    this.bounds = bounds;
    // ~50° elevation, distance ≈ the network extent, so the network fills
    // roughly 75-80% of the viewport instead of floating far away.
    const d = Math.max(bounds.extent * 0.95, 60);
    this.orbitControls.target.set(bounds.centerX, 0, -bounds.centerY);
    this.persp.position.set(
      bounds.centerX + d * 0.37,
      d * 0.75,
      -bounds.centerY + d * 0.53,
    );
    this.orbitControls.update();
    this.fitTopDown();
  }

  private fitTopDown(): void {
    const b = this.bounds;
    if (!b) return;
    const fit = fitOrtho(b.maxX - b.minX, b.maxY - b.minY, 1, 1.08);
    this.orthoHalfH = fit.halfH;
    this.ortho.zoom = 1;
    this.ortho.position.set(b.centerX, 900, -b.centerY);
    this.topControls.target.set(b.centerX, 0, -b.centerY);
    this.topControls.update();
  }

  /**
   * Drop the orbit camera at an exact pose. Only the headless review scripts
   * use this — it is how they frame reproducible day/night stills.
   */
  setPose(target: THREE.Vector3, position: THREE.Vector3): void {
    this.setMode("orbit");
    this.orbitControls.target.copy(target);
    this.persp.position.copy(position);
    this.orbitControls.update();
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const top = mode === "top";
    this.topControls.enabled = top;
    this.orbitControls.enabled = !top;
    if (top) this.fitTopDown();
  }

  /** Snap the chase offset behind a vehicle when following begins. */
  beginFollow(scenePos: THREE.Vector3, heading: number): void {
    const o = followOffset(heading, FOLLOW_BACK, FOLLOW_UP);
    this.smoothTarget.copy(scenePos);
    this.orbitControls.target.copy(scenePos);
    this.persp.position.set(scenePos.x + o.x, scenePos.y + o.y, scenePos.z + o.z);
    this.setMode("follow");
    this.orbitControls.update();
  }

  /**
   * Chase update: the orbit target lerps toward the vehicle and the camera
   * translates by the same delta, preserving whatever orbit offset the user
   * has dialed in by dragging while following.
   */
  updateFollow(scenePos: THREE.Vector3, dtReal: number): void {
    if (this.mode !== "follow") return;
    const alpha = smoothAlpha(dtReal, FOLLOW_RATE);
    this.smoothTarget.lerp(scenePos, alpha);
    this.scratch.copy(this.smoothTarget).sub(this.orbitControls.target);
    this.persp.position.add(this.scratch);
    this.orbitControls.target.copy(this.smoothTarget);
  }

  /** Per-viewport aspect, applied immediately before each render. */
  applyAspect(aspect: number): void {
    if (this.mode === "top") {
      const halfH = this.orthoHalfH;
      const halfW = halfH * Math.max(aspect, 1e-6);
      this.ortho.left = -halfW;
      this.ortho.right = halfW;
      this.ortho.top = halfH;
      this.ortho.bottom = -halfH;
      this.ortho.updateProjectionMatrix();
    } else if (this.persp.aspect !== aspect) {
      this.persp.aspect = aspect;
      this.persp.updateProjectionMatrix();
    }
  }

  update(): void {
    if (this.mode === "top") this.topControls.update();
    else this.orbitControls.update();
  }

  dispose(): void {
    this.orbitControls.dispose();
    this.topControls.dispose();
  }
}
