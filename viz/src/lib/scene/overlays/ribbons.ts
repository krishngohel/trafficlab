import * as THREE from "three";
import { idHue } from "../../ramps";
import type { TrajFrame } from "../../traj";

/**
 * Trajectory ribbons: fading polylines of the last ~15 s of vehicle
 * positions. Ring buffer per vehicle id, fed from frames the player already
 * decodes as playback advances (never a whole-file scan). One LineSegments
 * draw call for everything; all vertex buffers are preallocated.
 *
 * Tracks the selected/followed vehicle, plus (optionally) every vehicle up
 * to a hard cap of 200.
 */

const MAX_TRACKED = 200;
const TRAIL_SECONDS = 15;
const TRAIL_Y = 0.55;
/** A playhead jump larger than this resets all trails instead of replaying. */
const MAX_CATCHUP_FRAMES = 90;

interface Trail {
  slot: number;
  px: Float32Array;
  py: Float32Array;
  head: number;
  len: number;
  seenAt: number;
}

export class RibbonLayer {
  readonly line: THREE.LineSegments;

  /** Track all vehicles (capped) instead of only the selected one. */
  allVehicles = false;

  private readonly pointsPerTrail: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.LineBasicMaterial;
  private readonly trails = new Map<number, Trail>();
  private readonly freeSlots: number[] = [];
  private readonly color = new THREE.Color();
  private lastFrame = -1;
  private dirty = false;

  constructor(dt: number) {
    this.pointsPerTrail = Math.max(4, Math.round(TRAIL_SECONDS / Math.max(dt, 1e-3)) + 1);
    const maxVerts = MAX_TRACKED * (this.pointsPerTrail - 1) * 2;
    this.positions = new Float32Array(maxVerts * 3);
    this.colors = new Float32Array(maxVerts * 3);

    this.geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(this.colors, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", posAttr);
    this.geometry.setAttribute("color", colAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.line = new THREE.LineSegments(this.geometry, this.material);
    this.line.name = "ribbons";
    this.line.frustumCulled = false;
    this.line.visible = false;

    for (let i = MAX_TRACKED - 1; i >= 0; i--) this.freeSlots.push(i);
  }

  setVisible(visible: boolean): void {
    if (visible === this.line.visible) return;
    this.line.visible = visible;
    if (visible) {
      // Start fresh: history before the toggle is unknown.
      this.reset();
    }
  }

  reset(): void {
    for (const trail of this.trails.values()) this.freeSlots.push(trail.slot);
    this.trails.clear();
    this.lastFrame = -1;
    this.geometry.setDrawRange(0, 0);
    this.dirty = false;
  }

  /**
   * Advance trail history to integer frame `fa`, decoding any skipped frames
   * via `getFrame`. Large jumps (scrubs) reset instead of replaying. Then
   * rebuild the vertex buffers if anything changed.
   */
  advanceTo(fa: number, getFrame: (i: number) => TrajFrame, selectedId: number): void {
    if (!this.line.visible) return;
    if (fa < this.lastFrame || fa - this.lastFrame > MAX_CATCHUP_FRAMES) this.reset();
    if (this.lastFrame < 0) this.lastFrame = fa - 1;
    for (let f = this.lastFrame + 1; f <= fa; f++) {
      this.append(getFrame(f), selectedId);
    }
    this.lastFrame = fa;
    if (this.dirty) {
      this.rebuild(selectedId);
      this.dirty = false;
    }
  }

  private append(frame: TrajFrame, selectedId: number): void {
    const tick = frame.tick;
    const all = this.allVehicles;
    for (let i = 0; i < frame.count; i++) {
      const id = frame.id[i];
      let trail = this.trails.get(id);
      if (trail === undefined) {
        const wanted = all || id === selectedId;
        if (!wanted) continue;
        let slot = this.freeSlots.pop();
        if (slot === undefined) {
          if (id !== selectedId) continue;
          // Cap reached: evict an arbitrary non-selected trail for the selection.
          const victim = this.trails.keys().next();
          if (victim.done) continue;
          slot = this.trails.get(victim.value)!.slot;
          this.trails.delete(victim.value);
        }
        trail = {
          slot,
          px: new Float32Array(this.pointsPerTrail),
          py: new Float32Array(this.pointsPerTrail),
          head: 0,
          len: 0,
          seenAt: -1,
        };
        this.trails.set(id, trail);
      }
      trail.px[trail.head] = frame.x[i];
      trail.py[trail.head] = frame.y[i];
      trail.head = (trail.head + 1) % this.pointsPerTrail;
      if (trail.len < this.pointsPerTrail) trail.len++;
      trail.seenAt = tick;
    }
    // Age out trails whose vehicle was absent this frame (despawned), and in
    // selected-only mode any trail that is no longer the selection.
    for (const [id, trail] of this.trails) {
      const stale = trail.seenAt !== tick || (!all && id !== selectedId);
      if (stale) {
        trail.len -= 2;
        if (trail.len <= 0) {
          this.freeSlots.push(trail.slot);
          this.trails.delete(id);
        }
      }
    }
    this.dirty = true;
  }

  private rebuild(selectedId: number): void {
    const { positions, colors, pointsPerTrail } = this;
    let v = 0; // vertex index
    for (const [id, trail] of this.trails) {
      if (trail.len < 2) continue;
      const selected = id === selectedId;
      if (selected) this.color.setRGB(0.82, 0.92, 1);
      else this.color.setHSL(idHue(id), 0.7, 0.55);
      const r = this.color.r;
      const g = this.color.g;
      const b = this.color.b;
      const boost = selected ? 1 : 0.55;
      // Oldest point first: ring index of point j (0 = oldest).
      const start = (trail.head - trail.len + pointsPerTrail * 2) % pointsPerTrail;
      for (let j = 0; j < trail.len - 1; j++) {
        const i0 = (start + j) % pointsPerTrail;
        const i1 = (start + j + 1) % pointsPerTrail;
        const fade0 = ((j + 1) / trail.len) * boost;
        const fade1 = ((j + 2) / trail.len) * boost;
        let p = v * 3;
        positions[p] = trail.px[i0];
        positions[p + 1] = TRAIL_Y;
        positions[p + 2] = -trail.py[i0];
        colors[p] = r * fade0;
        colors[p + 1] = g * fade0;
        colors[p + 2] = b * fade0;
        v++;
        p += 3;
        positions[p] = trail.px[i1];
        positions[p + 1] = TRAIL_Y;
        positions[p + 2] = -trail.py[i1];
        colors[p] = r * fade1;
        colors[p + 1] = g * fade1;
        colors[p + 2] = b * fade1;
        v++;
      }
    }
    this.geometry.setDrawRange(0, v);
    const posAttr = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colAttr = this.geometry.getAttribute("color") as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
