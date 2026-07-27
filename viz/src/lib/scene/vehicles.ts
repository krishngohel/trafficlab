import * as THREE from "three";
import { buildCarGeometry, CAR_HEIGHT, CAR_LENGTH, CAR_WIDTH } from "./carModel";
import { idHue, speedColor, type RGB } from "../ramps";
import type { TrajFrame, TrajMeta } from "../traj";

/**
 * All vehicles as a single InstancedMesh of a low-poly car (see `carModel.ts`).
 * Color modes: stable per-id hue, or speed/speed_limit ramp (red = stopped,
 * white = half the limit, blue = at the limit).
 */

const TWO_PI = Math.PI * 2;

export type VehicleColorMode = "id" | "speed";

/** Interpolate an angle along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  const delta = ((((b - a) % TWO_PI) + TWO_PI + Math.PI) % TWO_PI) - Math.PI;
  return a + delta * t;
}

export interface VehiclePose {
  x: number;
  y: number;
  heading: number;
  speed: number;
}

export class VehicleLayer {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;

  colorMode: VehicleColorMode = "id";

  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private readonly rgb: RGB = { r: 0, g: 0, b: 0 };
  private warnedCapacity = false;

  /** Speed limit per lane id (dense array), for the speed color mode. */
  private laneLimits: Float32Array = new Float32Array(0);
  private fallbackLimit = 13.9; // ~50 km/h

  /** Last update() inputs, kept for picking + pose queries. */
  private frameA: TrajFrame | null = null;
  private frameB: TrajFrame | null = null;
  private frac = 0;

  /** Persistent id -> index maps, rebuilt only when the frame object changes. */
  private readonly aIndex = new Map<number, number>();
  private readonly bIndex = new Map<number, number>();
  private aIndexOf: TrajFrame | null = null;
  private bIndexOf: TrajFrame | null = null;

  /** Half the diagonal of one car, the padding for the instance bounding sphere. */
  private readonly instanceRadius: number;

  constructor(capacity = 4096) {
    this.capacity = capacity;
    const geometry = buildCarGeometry();
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.42,
      metalness: 0.25,
      // Emissive floor so no car ever reads as a black speck at night.
      emissive: 0x0e1015,
      // Windows / tyres / roof highlight ride on the geometry's vertex colors,
      // which three multiplies with the per-instance body color.
      vertexColors: true,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = "vehicles";
    this.mesh.frustumCulled = false;
    // Allocate the instance color buffer up front.
    this.mesh.setColorAt(0, this.color.setRGB(1, 1, 1));
    this.mesh.count = 0;
    this.instanceRadius = Math.hypot(CAR_LENGTH, CAR_WIDTH, CAR_HEIGHT) / 2;
    // Own the bounding sphere from the start. If it were left null the renderer
    // would compute it on the first render — when count is still 0, yielding an
    // EMPTY sphere that is never invalidated, which silently kills every
    // subsequent InstancedMesh raycast (click-to-follow). update() refreshes it.
    this.mesh.boundingSphere = new THREE.Sphere();
    this.mesh.boundingSphere.makeEmpty();
  }

  /** Build the lane-id -> speed-limit table from a file's meta. */
  setNetwork(meta: TrajMeta): void {
    let maxId = 0;
    let maxLimit = 0;
    for (const lane of meta.network.lanes) {
      if (lane.id > maxId) maxId = lane.id;
      if (lane.speed_limit > maxLimit) maxLimit = lane.speed_limit;
    }
    this.laneLimits = new Float32Array(maxId + 1).fill(0);
    for (const lane of meta.network.lanes) this.laneLimits[lane.id] = lane.speed_limit;
    if (maxLimit > 0) this.fallbackLimit = maxLimit;
  }

  /**
   * Position instances from frame `a`, linearly interpolated toward frame `b`
   * at fraction `t` (0..1). Positions lerp; headings take the shortest arc.
   * Vehicles present in `a` but not in `b` hold their `a` state.
   */
  update(a: TrajFrame, b: TrajFrame | null, t: number): void {
    const n = Math.min(a.count, this.capacity);
    if (a.count > this.capacity && !this.warnedCapacity) {
      this.warnedCapacity = true;
      console.warn(
        `VehicleLayer: frame has ${a.count} vehicles, capacity is ${this.capacity}; extra vehicles are not drawn`,
      );
    }

    this.frameA = a;
    this.frameB = b;
    this.frac = t;

    const interpolate = b !== null && b !== a && t > 0;
    const bIndex = interpolate && b !== null ? this.indexFor(b, false) : null;
    const speedMode = this.colorMode === "speed";
    const limits = this.laneLimits;
    const nLimits = limits.length;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < n; i++) {
      let x = a.x[i];
      let y = a.y[i];
      let heading = a.heading[i];
      let speed = a.speed[i];
      if (bIndex !== null && b !== null) {
        const j = bIndex.get(a.id[i]);
        if (j !== undefined) {
          x += (b.x[j] - x) * t;
          y += (b.y[j] - y) * t;
          heading = lerpAngle(heading, b.heading[j], t);
          speed += (b.speed[j] - speed) * t;
        }
      }
      // Sim (x, y, heading CCW from +X) -> scene (x, -z, rotation about +Y).
      this.dummy.position.set(x, 0, -y);
      this.dummy.rotation.set(0, heading, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (-y < minZ) minZ = -y;
      if (-y > maxZ) maxZ = -y;

      if (speedMode) {
        const lane = a.lane[i];
        const limit = lane < nLimits && limits[lane] > 0 ? limits[lane] : this.fallbackLimit;
        speedColor(speed / limit, this.rgb);
        this.mesh.setColorAt(i, this.color.setRGB(this.rgb.r, this.rgb.g, this.rgb.b));
      } else {
        this.mesh.setColorAt(i, this.color.setHSL(idHue(a.id[i]), 0.85, 0.6));
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    // Keep the instance bounding sphere in step with the instances themselves:
    // three caches it forever once computed, and InstancedMesh.raycast rejects
    // the whole mesh when the sphere misses. Derived from the min/max collected
    // above, so this costs nothing beyond the loop that was already running.
    const sphere = this.mesh.boundingSphere!;
    if (n === 0) {
      sphere.makeEmpty();
    } else {
      sphere.center.set((minX + maxX) / 2, CAR_HEIGHT / 2, (minZ + maxZ) / 2);
      sphere.radius = Math.hypot(maxX - minX, maxZ - minZ) / 2 + this.instanceRadius;
    }
  }

  /** Vehicle id rendered at instance `instanceId` in the last update, or -1. */
  idAt(instanceId: number): number {
    const a = this.frameA;
    if (!a || instanceId < 0 || instanceId >= Math.min(a.count, this.capacity)) return -1;
    return a.id[instanceId];
  }

  /**
   * Interpolated pose of vehicle `id` at the last update's playhead, written
   * into `out`. Returns false (out untouched) if the vehicle is not present.
   */
  getPose(id: number, out: VehiclePose): boolean {
    const a = this.frameA;
    if (!a) return false;
    const i = this.indexFor(a, true).get(id);
    if (i === undefined) return false;
    out.x = a.x[i];
    out.y = a.y[i];
    out.heading = a.heading[i];
    out.speed = a.speed[i];
    const b = this.frameB;
    const t = this.frac;
    if (b !== null && b !== a && t > 0) {
      const j = this.indexFor(b, false).get(id);
      if (j !== undefined) {
        out.x += (b.x[j] - out.x) * t;
        out.y += (b.y[j] - out.y) * t;
        out.heading = lerpAngle(out.heading, b.heading[j], t);
        out.speed += (b.speed[j] - out.speed) * t;
      }
    }
    return true;
  }

  private indexFor(frame: TrajFrame, isA: boolean): Map<number, number> {
    const map = isA ? this.aIndex : this.bIndex;
    const current = isA ? this.aIndexOf : this.bIndexOf;
    if (current !== frame) {
      map.clear();
      for (let i = 0; i < frame.count; i++) map.set(frame.id[i], i);
      if (isA) this.aIndexOf = frame;
      else this.bIndexOf = frame;
    }
    return map;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
