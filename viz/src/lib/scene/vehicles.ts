import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { TrajFrame } from "../traj";

/**
 * All vehicles as a single InstancedMesh of a beveled-box "car".
 * Per-instance color is a stable hue derived from the vehicle id.
 */

const CAR_LENGTH = 4.4; // m, along +X (heading axis)
const CAR_HEIGHT = 1.45;
const CAR_WIDTH = 1.85;
const TWO_PI = Math.PI * 2;

/** Interpolate an angle along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  const delta = ((((b - a) % TWO_PI) + TWO_PI + Math.PI) % TWO_PI) - Math.PI;
  return a + delta * t;
}

export class VehicleLayer {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;

  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private warnedCapacity = false;

  constructor(capacity = 4096) {
    this.capacity = capacity;
    // Beveled box, 2 segments per edge (spec allows ~3 max).
    const geometry = new RoundedBoxGeometry(CAR_LENGTH, CAR_HEIGHT, CAR_WIDTH, 2, 0.28);
    geometry.translate(0, CAR_HEIGHT / 2 + 0.08, 0);
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.45,
      metalness: 0.25,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = "vehicles";
    this.mesh.frustumCulled = false;
    // Allocate the instance color buffer up front.
    this.mesh.setColorAt(0, this.color.setRGB(1, 1, 1));
    this.mesh.count = 0;
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

    let bIndex: Map<number, number> | null = null;
    if (b !== null && b !== a && t > 0) {
      bIndex = new Map();
      for (let j = 0; j < b.count; j++) bIndex.set(b.id[j], j);
    }

    for (let i = 0; i < n; i++) {
      let x = a.x[i];
      let y = a.y[i];
      let heading = a.heading[i];
      if (bIndex !== null && b !== null) {
        const j = bIndex.get(a.id[i]);
        if (j !== undefined) {
          x += (b.x[j] - x) * t;
          y += (b.y[j] - y) * t;
          heading = lerpAngle(heading, b.heading[j], t);
        }
      }
      // Sim (x, y, heading CCW from +X) -> scene (x, -z, rotation about +Y).
      this.dummy.position.set(x, 0, -y);
      this.dummy.rotation.set(0, heading, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.colorForId(a.id[i]));
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private colorForId(id: number): THREE.Color {
    // Golden-ratio hue walk: stable, well-spread colors per vehicle.
    const hue = (id * 0.61803398875) % 1;
    return this.color.setHSL(hue, 0.6, 0.58);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
