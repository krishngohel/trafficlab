import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildCarGeometry, carTriangleCount, CAR_LENGTH, CAR_WIDTH } from "./carModel";
import { lerpAngle, VehicleLayer } from "./vehicles";
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

describe("car geometry", () => {
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

describe("VehicleLayer bounding sphere", () => {
  it("starts empty (no instances yet)", () => {
    const layer = new VehicleLayer(16);
    expect(layer.mesh.boundingSphere).not.toBeNull();
    expect(layer.mesh.boundingSphere!.isEmpty()).toBe(true);
  });

  it("is refreshed by update() so it always contains every instance", () => {
    const layer = new VehicleLayer(16);
    layer.update(
      frameAt([
        [0, 0],
        [120, 60],
        [-40, -80],
      ]),
      null,
      0,
    );
    const sphere = layer.mesh.boundingSphere!;
    expect(sphere.isEmpty()).toBe(false);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < layer.mesh.count; i++) {
      layer.mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      expect(sphere.containsPoint(p)).toBe(true);
    }
  });

  it("follows the instances when they move far away", () => {
    const layer = new VehicleLayer(16);
    layer.update(frameAt([[0, 0]]), null, 0);
    layer.update(frameAt([[900, -900]]), null, 0);
    const sphere = layer.mesh.boundingSphere!;
    expect(sphere.center.x).toBeCloseTo(900, 3);
    expect(sphere.center.z).toBeCloseTo(900, 3);
    expect(sphere.containsPoint(new THREE.Vector3(900, 0.7, 900))).toBe(true);
  });

  it("goes back to empty when the frame has no vehicles", () => {
    const layer = new VehicleLayer(16);
    layer.update(frameAt([[10, 10]]), null, 0);
    layer.update(frameAt([]), null, 0);
    expect(layer.mesh.boundingSphere!.isEmpty()).toBe(true);
  });
});

describe("VehicleLayer picking", () => {
  /**
   * Regression for the click-to-follow bug: three caches the InstancedMesh
   * bounding sphere forever, and InstancedMesh.raycast rejects the whole mesh
   * when the ray misses it. A stale/empty sphere made every pick silently fail.
   */
  it("raycasts to the instance under a camera ray after the cars have moved", () => {
    const layer = new VehicleLayer(64);
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
    const hits = raycaster.intersectObject(layer.mesh, false);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].instanceId).toBe(0);
    expect(layer.idAt(hits[0].instanceId!)).toBe(1);
  });

  it("returns no hits when the ray misses the traffic entirely", () => {
    const layer = new VehicleLayer(64);
    layer.update(frameAt([[0, 0]]), null, 0);
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 5000);
    camera.position.set(0, 60, 60);
    camera.lookAt(1000, 0, 1000);
    camera.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    expect(raycaster.intersectObject(layer.mesh, false)).toHaveLength(0);
  });
});

describe("lerpAngle", () => {
  it("takes the short way round the wrap point", () => {
    expect(lerpAngle(3.0, -3.0, 0.5)).toBeCloseTo(3.1415926 + 0.0, 2);
  });
});
