import * as THREE from "three";
import { buildCarGeometry, CAR_HEIGHT, CAR_LENGTH, CAR_WIDTH } from "./carModel";
import { speedColor, type RGB } from "../ramps";
import { VEHICLE_PAINTS, type SceneAssets, type VehicleModelAsset } from "./assets";
import type { TrajFrame, TrajMeta } from "../traj";

/**
 * The traffic fleet: ONE InstancedMesh per vehicle model (Kenney car kit,
 * merged to a single geometry each), so a thousand cars cost ~15 draw calls
 * while still looking like a mixed street rather than a swarm of clones.
 *
 * Each vehicle id hashes deterministically into the weighted model mix and,
 * separately, into the paint palette — so a car keeps both its body and its
 * colour across seeks and matches on both sides of a comparison. The paint
 * rides on the per-instance colour and the material masks it to the bodywork
 * (see `assets.withVehicleShading`), which leaves glass, tyres and liveries
 * alone. The velocity overlay reuses the same per-instance colour and *blends*
 * it over the whole car through the material's `uTintMix` uniform.
 *
 * `flags` bit 0 is the sim's braking bit; it rides to the shader on a
 * per-instance `aBrake` attribute that lights the tail lamps.
 *
 * With no asset bundle (unit tests, or a failed asset fetch) the layer falls
 * back to the procedural low-poly car in `carModel.ts` — one mesh, same API.
 */

const TWO_PI = Math.PI * 2;
/** Power-of-two lookup table turning a hashed id into a model index. */
const MIX_TABLE_BITS = 10;
const MIX_TABLE_SIZE = 1 << MIX_TABLE_BITS;
/** `TrajFrame.flags` bit 0: the vehicle is braking. */
const FLAG_BRAKING = 1;

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

/** Cheap integer avalanche so consecutive ids do not land in the same model. */
function hashId(id: number): number {
  let h = id | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Paint colours are a second, independent draw from the same id. */
function paintHash(id: number): number {
  return hashId((id ^ 0x5f356495) | 0);
}

/** Flat linear-rgb palette, indexed by `paintTable` (3 floats per entry). */
const PAINT_RGB = new Float32Array(VEHICLE_PAINTS.length * 3);
for (let i = 0; i < VEHICLE_PAINTS.length; i++) PAINT_RGB.set(VEHICLE_PAINTS[i].rgb, i * 3);
const PAINT_TABLE = buildWeightedTable(VEHICLE_PAINTS);

interface TypeMesh {
  mesh: THREE.InstancedMesh;
  /** Per-instance braking flags feeding the tail-lamp glow. */
  brake: THREE.InstancedBufferAttribute;
  /** Half-diagonal of one instance, padding for the bounding sphere. */
  radius: number;
  count: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export class VehicleLayer {
  /** Holds one InstancedMesh per model type; add this to the scene. */
  readonly group = new THREE.Group();
  readonly meshes: THREE.InstancedMesh[] = [];
  readonly capacity: number;

  colorMode: VehicleColorMode = "id";

  private readonly types: TypeMesh[] = [];
  /** hash -> model index, precomputed from the model weights. */
  private readonly mixTable: Uint8Array;
  /**
   * Per-layer geometry wrappers. The model geometries are shared by every view,
   * so the per-instance braking attribute cannot live on them; each layer gets
   * its own BufferGeometry that re-uses the shared attributes and adds its own.
   */
  private readonly ownGeometries: THREE.BufferGeometry[] = [];
  /** Source geometries this layer built itself (the procedural fallback only). */
  private readonly fallbackGeometries: THREE.BufferGeometry[] = [];
  private readonly ownMaterial: THREE.Material | null;
  private readonly tintMix: { value: number } | null;
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
  /** Instance slot each drawn vehicle landed in, parallel to frame order. */
  private slotType = new Uint8Array(0);
  private slotIndex = new Uint16Array(0);

  /** Persistent id -> index maps, rebuilt only when the frame object changes. */
  private readonly aIndex = new Map<number, number>();
  private readonly bIndex = new Map<number, number>();
  private aIndexOf: TrajFrame | null = null;
  private bIndexOf: TrajFrame | null = null;

  constructor(assets: SceneAssets | null = null, capacity = 4096) {
    this.capacity = capacity;
    this.group.name = "vehicles";

    const models: VehicleModelAsset[] = assets?.vehicles?.length
      ? assets.vehicles
      : [fallbackModel()];
    const material = assets?.vehicles?.length
      ? assets.vehicleMaterial
      : new THREE.MeshStandardMaterial({
          roughness: 0.42,
          metalness: 0.25,
          emissive: 0x0e1015,
          vertexColors: true,
        });
    this.ownMaterial = assets?.vehicles?.length ? null : material;
    this.tintMix = assets?.vehicleTintMix ?? null;

    const total = models.reduce((sum, m) => sum + m.weight, 0) || 1;
    for (const model of models) {
      // Twice the expected share plus a floor, so a lucky hash run never spills
      // the whole fleet into the overflow type.
      const share = Math.min(
        capacity,
        Math.max(48, Math.ceil(((capacity * model.weight) / total) * 2)),
      );
      const geometry = instanceGeometry(model.geometry, share);
      this.ownGeometries.push(geometry);
      if (this.ownMaterial) this.fallbackGeometries.push(model.geometry);
      const mesh = new THREE.InstancedMesh(geometry, material, share);
      mesh.name = `vehicles:${model.name}`;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      // Not receiveShadow: at this shadow-map resolution a car's own cast
      // shadow lands back on its flanks and blacks out everything below the
      // beltline, which costs far more than the shadow it would pick up.
      mesh.receiveShadow = false;
      mesh.setColorAt(0, this.color.setRGB(1, 1, 1));
      mesh.count = 0;
      // Own the bounding sphere from the start: three caches it forever once
      // computed, and computing it at count 0 yields an EMPTY sphere that is
      // never invalidated — which silently kills every InstancedMesh raycast
      // (click-to-follow). update() refreshes it.
      mesh.boundingSphere = new THREE.Sphere();
      mesh.boundingSphere.makeEmpty();
      this.meshes.push(mesh);
      this.group.add(mesh);
      this.types.push({
        mesh,
        brake: geometry.getAttribute("aBrake") as THREE.InstancedBufferAttribute,
        radius: Math.hypot(model.size.x, model.size.y, model.size.z) / 2,
        count: 0,
        minX: 0,
        maxX: 0,
        minZ: 0,
        maxZ: 0,
      });
    }

    this.mixTable = buildMixTable(models);
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

  /** Model index a vehicle id always renders as. */
  modelIndexFor(id: number): number {
    return this.mixTable[hashId(id) & (MIX_TABLE_SIZE - 1)];
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
    if (this.slotType.length < n) {
      this.slotType = new Uint8Array(n);
      this.slotIndex = new Uint16Array(n);
    }

    const interpolate = b !== null && b !== a && t > 0;
    const bIndex = interpolate && b !== null ? this.indexFor(b, false) : null;
    const speedMode = this.colorMode === "speed";
    if (this.tintMix) this.tintMix.value = speedMode ? 1 : 0;
    const limits = this.laneLimits;
    const nLimits = limits.length;
    const types = this.types;
    const nTypes = types.length;
    for (let k = 0; k < nTypes; k++) {
      const type = types[k];
      type.count = 0;
      type.minX = Infinity;
      type.maxX = -Infinity;
      type.minZ = Infinity;
      type.maxZ = -Infinity;
    }

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

      // Pick the model, spilling into the commonest type when a bucket is full.
      let k = nTypes === 1 ? 0 : this.mixTable[hashId(a.id[i]) & (MIX_TABLE_SIZE - 1)];
      let type = types[k];
      if (type.count >= type.mesh.instanceMatrix.count) {
        k = 0;
        type = types[0];
        if (type.count >= type.mesh.instanceMatrix.count) continue;
      }
      const slot = type.count++;
      this.slotType[i] = k;
      this.slotIndex[i] = slot;

      // Sim (x, y, heading CCW from +X) -> scene (x, -z, rotation about +Y).
      this.dummy.position.set(x, 0, -y);
      this.dummy.rotation.set(0, heading, 0);
      this.dummy.updateMatrix();
      type.mesh.setMatrixAt(slot, this.dummy.matrix);
      const z = -y;
      if (x < type.minX) type.minX = x;
      if (x > type.maxX) type.maxX = x;
      if (z < type.minZ) type.minZ = z;
      if (z > type.maxZ) type.maxZ = z;

      type.brake.array[slot] = a.flags[i] & FLAG_BRAKING ? 1 : 0;

      if (speedMode) {
        const lane = a.lane[i];
        const limit = lane < nLimits && limits[lane] > 0 ? limits[lane] : this.fallbackLimit;
        speedColor(speed / limit, this.rgb);
        type.mesh.setColorAt(slot, this.color.setRGB(this.rgb.r, this.rgb.g, this.rgb.b));
      } else if (this.tintMix === null) {
        // Fallback material multiplies instanceColor in, so a slot left over
        // from speed mode has to be reset — the fallback car has no paint mask.
        type.mesh.setColorAt(slot, this.color.setRGB(1, 1, 1));
      } else {
        // Paint. The material masks this to the bodywork, so liveries and glass
        // are unaffected; it is also what the velocity ramp overwrites above.
        const p = PAINT_TABLE[paintHash(a.id[i]) & (MIX_TABLE_SIZE - 1)] * 3;
        type.mesh.setColorAt(
          slot,
          this.color.setRGB(PAINT_RGB[p], PAINT_RGB[p + 1], PAINT_RGB[p + 2]),
        );
      }
    }

    for (let k = 0; k < nTypes; k++) {
      const type = types[k];
      const mesh = type.mesh;
      mesh.count = type.count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      type.brake.needsUpdate = true;
      // Keep each instance bounding sphere in step with its instances: three
      // caches it forever once computed, and InstancedMesh.raycast rejects the
      // whole mesh when the sphere misses.
      const sphere = mesh.boundingSphere!;
      if (type.count === 0) {
        sphere.makeEmpty();
      } else {
        sphere.center.set(
          (type.minX + type.maxX) / 2,
          type.radius / 2,
          (type.minZ + type.maxZ) / 2,
        );
        sphere.radius =
          Math.hypot(type.maxX - type.minX, type.maxZ - type.minZ) / 2 + type.radius;
      }
    }
  }

  /** Vehicle id drawn at `instanceId` of `mesh` in the last update, or -1. */
  idAt(mesh: THREE.InstancedMesh, instanceId: number): number {
    const a = this.frameA;
    if (!a) return -1;
    const k = this.meshes.indexOf(mesh);
    if (k < 0) return -1;
    const n = Math.min(a.count, this.capacity);
    for (let i = 0; i < n; i++) {
      if (this.slotType[i] === k && this.slotIndex[i] === instanceId) return a.id[i];
    }
    return -1;
  }

  /** Nearest vehicle id under `raycaster`, or -1. */
  pick(raycaster: THREE.Raycaster): number {
    let best = Infinity;
    let bestId = -1;
    for (const mesh of this.meshes) {
      if (mesh.count === 0) continue;
      for (const hit of raycaster.intersectObject(mesh, false)) {
        if (hit.instanceId === undefined || hit.distance >= best) continue;
        const id = this.idAt(mesh, hit.instanceId);
        if (id >= 0) {
          best = hit.distance;
          bestId = id;
        }
      }
    }
    return bestId;
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

  setShadows(cast: boolean): void {
    for (const mesh of this.meshes) mesh.castShadow = cast;
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
    for (const mesh of this.meshes) mesh.dispose();
    // Model geometries and the atlas material are shared with every other view.
    // Each wrapper is ours, but its vertex attributes are not: drop the shared
    // ones first so disposing frees only this layer's `aBrake` buffer.
    for (const geometry of this.ownGeometries) {
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== "aBrake") geometry.deleteAttribute(name);
      }
      geometry.setIndex(null);
      geometry.dispose();
    }
    this.ownGeometries.length = 0;
    // Only a locally built fallback material — and its geometry — is ours.
    this.ownMaterial?.dispose();
    if (this.ownMaterial) {
      for (const model of this.fallbackGeometries) model.dispose();
    }
    this.fallbackGeometries.length = 0;
    this.meshes.length = 0;
    this.types.length = 0;
    this.group.clear();
  }
}

/**
 * A per-layer geometry that shares the model's vertex buffers (so the GPU still
 * stores one copy of each car) but carries this layer's own per-instance
 * braking attribute, which an InstancedMesh can only read off its geometry.
 */
function instanceGeometry(source: THREE.BufferGeometry, count: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(name, attribute);
  }
  if (source.index) geometry.setIndex(source.index);
  geometry.setAttribute("aBrake", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  source.computeBoundingBox();
  source.computeBoundingSphere();
  geometry.boundingBox = source.boundingBox;
  geometry.boundingSphere = source.boundingSphere;
  return geometry;
}

/** Weighted hash -> index lookup table over a `MIX_TABLE_SIZE` hash space. */
export function buildWeightedTable(entries: readonly { weight: number }[]): Uint8Array {
  const table = new Uint8Array(MIX_TABLE_SIZE);
  const total = entries.reduce((sum, m) => sum + m.weight, 0) || 1;
  let cursor = 0;
  for (let k = 0; k < entries.length; k++) {
    const end =
      k === entries.length - 1
        ? MIX_TABLE_SIZE
        : Math.min(
            MIX_TABLE_SIZE,
            cursor + Math.round((entries[k].weight / total) * MIX_TABLE_SIZE),
          );
    table.fill(k, cursor, end);
    cursor = end;
  }
  return table;
}

/** Weighted hash -> model-index lookup table (exported for the unit tests). */
export const buildMixTable = buildWeightedTable;

/** The procedural low-poly car, wrapped as a model asset. */
function fallbackModel(): VehicleModelAsset {
  return {
    name: "lowpoly",
    weight: 1,
    geometry: buildCarGeometry(),
    size: new THREE.Vector3(CAR_LENGTH, CAR_HEIGHT, CAR_WIDTH),
  };
}
