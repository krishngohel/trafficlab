import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildCarGeometry, carTriangleCount, CAR_LENGTH, CAR_WIDTH } from "./carModel";
import { buildMixTable, lerpAngle, VehicleLayer } from "./vehicles";
import { VEHICLE_MODELS, type SceneAssets, type VehicleModelAsset } from "./assets";
import type { TrajFrame } from "../traj";

/** Minimal TrajFrame with `n` vehicles laid out along +X at y = 0. */
function frameAt(positions: readonly [number, number][]): TrajFrame {
  const n = positions.length;
  const f = (fill: number) => new Float32Array(n).fill(fill);
  return {
    tick: 0,
    count: n,
    id: Int32Array.from(positions.map((_, i) => i + 1)),
    x: Float32Array.from(positions.map((p) => p[0])),
    y: Float32Array.from(positions.map((p) => p[1])),
    heading: f(0),
    speed: f(10),
    accel: f(0),
    lane: new Int32Array(n),
    flags: new Uint8Array(n),
    signals: {
      phase: new Uint8Array(0),
      state: new Uint8Array(0),
      timeInPhase: new Float32Array(0),
    },
    queues: new Uint16Array(0),
    rewards: new Float32Array(0),
    metrics: new Float32Array(0),
  } as unknown as TrajFrame;
}

/**
 * A stand-in for the loaded Kenney fleet: `n` distinct box geometries roughly
 * the size of a car, sharing one material — the same shape the real bundle has,
 * without needing WebGL or the network.
 */
function fakeAssets(n = 4): SceneAssets {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  const vehicles: VehicleModelAsset[] = Array.from({ length: n }, (_, i) => {
    const geometry = new THREE.BoxGeometry(4.5, 1.5, 1.9);
    geometry.translate(0, 0.75, 0);
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(1), 3),
    );
    return {
      name: `model${i}`,
      weight: VEHICLE_MODELS[i % VEHICLE_MODELS.length].weight,
      geometry,
      size: new THREE.Vector3(4.5, 1.5, 1.9),
    };
  });
  return {
    vehicles,
    vehicleMaterial: material,
    vehicleTintMix: { value: 0 },
  } as unknown as SceneAssets;
}

/** Union of every sub-mesh bounding sphere — what raycast picking sees. */
function spheres(layer: VehicleLayer): THREE.Sphere[] {
  return layer.meshes.map((m) => m.boundingSphere!);
}

function containsInstance(layer: VehicleLayer, point: THREE.Vector3): boolean {
  return spheres(layer).some((s) => !s.isEmpty() && s.containsPoint(point));
}

describe("car geometry (procedural fallback)", () => {
  const geo = buildCarGeometry();

  it("stays inside the low-poly triangle budget", () => {
    expect(carTriangleCount(geo)).toBeLessThanOrEqual(300);
    expect(carTriangleCount(geo)).toBeGreaterThan(60);
  });

  it("carries the vertex-color tint attribute used for glass and tyres", () => {
    const color = geo.getAttribute("color");
    expect(color).toBeDefined();
    expect(color.itemSize).toBe(3);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < color.count; i++) {
      min = Math.min(min, color.getX(i));
      max = Math.max(max, color.getX(i));
    }
    expect(min).toBeLessThan(0.2); // smoked glass / tyres
    expect(max).toBeGreaterThan(1); // roof highlight
  });

  it("sits on the ground and fits the declared car envelope", () => {
    const box = geo.boundingBox!;
    expect(box.min.y).toBeGreaterThanOrEqual(0);
    expect(box.max.x - box.min.x).toBeLessThanOrEqual(CAR_LENGTH + 1e-6);
    expect(box.max.z - box.min.z).toBeLessThanOrEqual(CAR_WIDTH + 1e-6);
    // Wide enough and long enough to still read as a car, not a wedge.
    expect(box.max.x - box.min.x).toBeGreaterThan(4);
    expect(box.max.z - box.min.z).toBeGreaterThan(1.5);
  });
});

describe("model mix", () => {
  it("splits the hash space in proportion to the weights", () => {
    const models = [{ weight: 3 }, { weight: 1 }];
    const table = buildMixTable(models);
    let zeros = 0;
    for (const v of table) if (v === 0) zeros++;
    expect(zeros / table.length).toBeCloseTo(0.75, 2);
  });

  it("gives a vehicle id the same model every time", () => {
    const a = new VehicleLayer(fakeAssets(), 256);
    const b = new VehicleLayer(fakeAssets(), 256);
    for (const id of [1, 7, 42, 9001, 123456]) {
      expect(a.modelIndexFor(id)).toBe(b.modelIndexFor(id));
    }
  });

  it("actually spreads a fleet across every model mesh", () => {
    const layer = new VehicleLayer(fakeAssets(), 2048);
    layer.update(
      frameAt(Array.from({ length: 600 }, (_, i) => [i * 6, 0] as [number, number])),
      null,
      0,
    );
    const counts = layer.meshes.map((m) => m.count);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(600);
    for (const c of counts) expect(c).toBeGreaterThan(0);
  });

  it("draws a 2000-vehicle frame in full at the default capacity", () => {
    // Per-type buckets are sized at twice the expected share, so an unlucky
    // hash run spills into the overflow type instead of dropping vehicles.
    const layer = new VehicleLayer(fakeAssets(10));
    layer.update(
      frameAt(Array.from({ length: 2000 }, (_, i) => [i * 3, 0] as [number, number])),
      null,
      0,
    );
    expect(layer.meshes.reduce((sum, m) => sum + m.count, 0)).toBe(2000);
  });
});

describe("VehicleLayer bounding spheres", () => {
  it("start empty (no instances yet)", () => {
    const layer = new VehicleLayer(fakeAssets(), 16);
    for (const sphere of spheres(layer)) expect(sphere.isEmpty()).toBe(true);
  });

  it("are refreshed by update() so they always contain every instance", () => {
    const layer = new VehicleLayer(fakeAssets(), 64);
    layer.update(
      frameAt([
        [0, 0],
        [120, 60],
        [-40, -80],
      ]),
      null,
      0,
    );
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let drawn = 0;
    for (const mesh of layer.meshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        expect(mesh.boundingSphere!.containsPoint(p)).toBe(true);
        drawn++;
      }
    }
    expect(drawn).toBe(3);
  });

  it("follow the instances when they move far away", () => {
    const layer = new VehicleLayer(fakeAssets(), 16);
    layer.update(frameAt([[0, 0]]), null, 0);
    layer.update(frameAt([[900, -900]]), null, 0);
    expect(containsInstance(layer, new THREE.Vector3(900, 0.7, 900))).toBe(true);
    expect(containsInstance(layer, new THREE.Vector3(0, 0.7, 0))).toBe(false);
  });

  it("go back to empty when the frame has no vehicles", () => {
    const layer = new VehicleLayer(fakeAssets(), 16);
    layer.update(frameAt([[10, 10]]), null, 0);
    layer.update(frameAt([]), null, 0);
    for (const sphere of spheres(layer)) expect(sphere.isEmpty()).toBe(true);
  });
});

describe("VehicleLayer picking", () => {
  /**
   * Regression for the click-to-follow bug: three caches each InstancedMesh
   * bounding sphere forever, and InstancedMesh.raycast rejects the whole mesh
   * when the ray misses it. A stale/empty sphere made every pick silently fail
   * — and with the fleet split over ten meshes there are now ten of them.
   */
  it("raycasts to the vehicle under a camera ray after the cars have moved", () => {
    const layer = new VehicleLayer(fakeAssets(), 64);
    layer.update(frameAt([[0, 0]]), null, 0);
    // Move the traffic far from where it started.
    layer.update(
      frameAt([
        [200, -150],
        [400, 300],
      ]),
      null,
      0,
    );

    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 5000);
    camera.position.set(200, 60, 210); // above and behind vehicle #1 (200, 0, 150)
    camera.lookAt(200, 0.7, 150);
    camera.updateMatrixWorld();

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    expect(layer.pick(raycaster)).toBe(1);
  });

  it("picks the nearest car when two meshes are both under the ray", () => {
    const layer = new VehicleLayer(fakeAssets(), 64);
    // Two vehicles 40 m apart along +X, camera looking down the line.
    layer.update(
      frameAt([
        [0, 0],
        [40, 0],
      ]),
      null,
      0,
    );
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 5000);
    camera.position.set(-60, 0.75, 0);
    camera.lookAt(100, 0.75, 0);
    camera.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    expect(layer.pick(raycaster)).toBe(1); // the nearer one
  });

  it("returns no hit when the ray misses the traffic entirely", () => {
    const layer = new VehicleLayer(fakeAssets(), 64);
    layer.update(frameAt([[0, 0]]), null, 0);
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 5000);
    camera.position.set(0, 60, 60);
    camera.lookAt(1000, 0, 1000);
    camera.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    expect(layer.pick(raycaster)).toBe(-1);
  });

  it("works with the procedural fallback (no asset bundle)", () => {
    const layer = new VehicleLayer(null, 64);
    expect(layer.meshes).toHaveLength(1);
    layer.update(frameAt([[200, -150]]), null, 0);
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 5000);
    camera.position.set(200, 60, 210);
    camera.lookAt(200, 0.7, 150);
    camera.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    expect(layer.pick(raycaster)).toBe(1);
  });
});

describe("velocity coloring", () => {
  it("drives the material's blend uniform instead of multiplying the paint", () => {
    const assets = fakeAssets();
    const layer = new VehicleLayer(assets, 64);
    layer.update(frameAt([[0, 0]]), null, 0);
    expect(assets.vehicleTintMix.value).toBe(0);
    layer.colorMode = "speed";
    layer.update(frameAt([[0, 0]]), null, 0);
    expect(assets.vehicleTintMix.value).toBe(1);
  });
});

describe("lerpAngle", () => {
  it("takes the short way round the wrap point", () => {
    expect(lerpAngle(3.0, -3.0, 0.5)).toBeCloseTo(3.1415926 + 0.0, 2);
  });
});
