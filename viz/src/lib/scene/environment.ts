import * as THREE from "three";

import { hashSeed, mulberry32, scatterEnvironment, type ScatterOptions } from "./scatter";
import type { ModelGeometry, SceneAssets } from "./assets";
import type { ThemeSpec } from "./theme";
import type { TrajMeta } from "../traj";

/**
 * Static scenery between the roads: Kenney nature-kit trees and city-kit
 * commercial buildings, one InstancedMesh per model variant (~14 static draw
 * calls) with per-instance scale/rotation jitter.
 *
 * Placement comes from `scatter.ts` (pure, seeded by the network name), so the
 * scenery is identical every time a file is opened and matches on both sides of
 * a comparison. Trees sit in a band just off the kerb, buildings further back in
 * the block interiors, turned to face the nearest road.
 *
 * With no asset bundle the layer falls back to the procedural cone-tree and
 * box-pad geometry below, so unit tests and a failed asset fetch still draw
 * something sane.
 */

/**
 * Vertex colours live in the renderer's linear working space, so authoring
 * them as sRGB hex (like every other colour in the scene) needs the same
 * conversion `THREE.Color` does for material colours.
 */
function linear(hex: number): readonly [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

const TRUNK = linear(0x3a2b1e);
const CANOPY_LOW = linear(0x2c4426);
const CANOPY_HIGH = linear(0x3a5a30);

/** Accumulates flat-shaded, vertex-coloured triangles. */
class PropBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];

  triangle(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    color: readonly number[],
  ): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const p of [a, b, c]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(nx, ny, nz);
      this.colors.push(color[0], color[1], color[2]);
    }
  }

  quad(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
    color: readonly number[],
  ): void {
    this.triangle(a, b, c, color);
    this.triangle(a, c, d, color);
  }

  /** Vertical prism from y0 to y1 (trunk / building box). */
  prism(
    radius: number,
    y0: number,
    y1: number,
    segments: number,
    color: readonly number[],
    cap = false,
  ): void {
    const pt = (i: number, y: number) => {
      const a = (i / segments) * Math.PI * 2;
      return [Math.cos(a) * radius, y, Math.sin(a) * radius];
    };
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.quad(pt(i, y0), pt(i, y1), pt(j, y1), pt(j, y0), color);
      if (cap) this.triangle([0, y1, 0], pt(j, y1), pt(i, y1), color);
    }
  }

  /** Cone with its base at y0 and apex at y1. */
  cone(radius: number, y0: number, y1: number, segments: number, color: readonly number[]): void {
    const pt = (i: number) => {
      const a = (i / segments) * Math.PI * 2;
      return [Math.cos(a) * radius, y0, Math.sin(a) * radius];
    };
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.triangle(pt(j), pt(i), [0, y1, 0], color);
      this.triangle([0, y0, 0], pt(i), pt(j), color); // underside skirt
    }
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * Fallback tree of unit height (scaled per instance): a 5-sided trunk and
 * three stacked cones. ~52 triangles.
 */
export function buildTreeGeometry(): THREE.BufferGeometry {
  const b = new PropBuilder();
  b.prism(0.035, 0, 0.3, 5, TRUNK);
  b.cone(0.3, 0.2, 0.56, 6, CANOPY_LOW);
  b.cone(0.24, 0.44, 0.78, 6, CANOPY_HIGH);
  b.cone(0.16, 0.66, 1.0, 6, CANOPY_HIGH);
  return b.build();
}

/**
 * Fallback building: a unit box with its base at y = 0 and a slightly inset,
 * lighter roof slab. Footprint 1 x 1, so the same instance scale as a Kenney
 * building drives it.
 */
export function buildPadGeometry(): THREE.BufferGeometry {
  const b = new PropBuilder();
  const wall = linear(0x6c6a63);
  const roof = linear(0x4a4d52);
  const h = 0.5;
  const box = (hx: number, hz: number, y0: number, y1: number, color: readonly number[]) => {
    // Corner index = x + 2y + 4z, matching carModel's hexahedron convention.
    const c: number[][] = [];
    for (const z of [-hz, hz]) for (const y of [y0, y1]) for (const x of [-hx, hx]) c.push([x, y, z]);
    b.quad(c[1], c[3], c[7], c[5], color); // +X
    b.quad(c[0], c[4], c[6], c[2], color); // -X
    b.quad(c[2], c[6], c[7], c[3], color); // +Y
    b.quad(c[0], c[1], c[5], c[4], color); // -Y
    b.quad(c[4], c[5], c[7], c[6], color); // +Z
    b.quad(c[0], c[2], c[3], c[1], color); // -Z
  };
  box(h, h, 0, 1.4, wall);
  box(h * 0.92, h * 0.92, 1.4, 1.45, roof);
  return b.build();
}

/**
 * Scenery for one network. Holds one InstancedMesh per tree variant and per
 * building variant; every matrix is written once at load and never touched
 * again.
 */
export class EnvironmentLayer {
  readonly group = new THREE.Group();

  private readonly owned: THREE.Material[] = [];
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];

  constructor(meta: TrajMeta, assets: SceneAssets | null, options?: ScatterOptions) {
    this.group.name = "environment";
    const { trees, pads } = scatterEnvironment(meta, options);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const rand = mulberry32(hashSeed(`${meta.network_name ?? "network"}:models`));

    // --- trees --------------------------------------------------------------
    const treeModels: ModelGeometry[] = assets?.trees?.length
      ? assets.trees
      : [{ name: "cone", geometry: this.own(buildTreeGeometry()), size: new THREE.Vector3(1, 1, 1) }];
    const treeMaterial =
      assets?.treeMaterial ??
      this.ownMaterial(
        new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, vertexColors: true }),
      );
    // Bushes (the short models) want their own, smaller height range.
    const treeBuckets: number[][] = treeModels.map(() => []);
    for (let i = 0; i < trees.length; i++) {
      treeBuckets[Math.floor(rand() * treeModels.length) % treeModels.length].push(i);
    }
    for (let m = 0; m < treeModels.length; m++) {
      const indices = treeBuckets[m];
      if (indices.length === 0) continue;
      const model = treeModels[m];
      const short = model.name.startsWith("plant_");
      const mesh = new THREE.InstancedMesh(model.geometry, treeMaterial, indices.length);
      mesh.name = `trees:${model.name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      for (let k = 0; k < indices.length; k++) {
        const t = trees[indices[k]];
        const height = short ? t.height * 0.42 : t.height;
        // Sim (x, y) -> scene (x, -z); slight width jitter keeps rows from rhyming.
        dummy.position.set(t.x, 0, -t.y);
        dummy.rotation.set(0, t.rot, 0);
        dummy.scale.set(height * 0.94, height, height * 0.94);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
        mesh.setColorAt(k, color.setRGB(t.tintR, t.tintG, t.tintB));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }

    // --- buildings ------------------------------------------------------------
    const buildingModels: ModelGeometry[] = assets?.buildings?.length
      ? assets.buildings
      : [{ name: "pad", geometry: this.own(buildPadGeometry()), size: new THREE.Vector3(1, 1, 1) }];
    const buildingMaterial =
      assets?.buildingMaterial ??
      this.ownMaterial(
        new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.05, vertexColors: true }),
      );
    /** Paved lot under each building, so nothing sits straight on lawn. */
    const aprons: { x: number; y: number; rot: number; size: number }[] = [];
    const padBuckets: number[][] = buildingModels.map(() => []);
    for (let i = 0; i < pads.length; i++) {
      padBuckets[Math.floor(rand() * buildingModels.length) % buildingModels.length].push(i);
    }
    for (let m = 0; m < buildingModels.length; m++) {
      const indices = padBuckets[m];
      if (indices.length === 0) continue;
      const model = buildingModels[m];
      const mesh = new THREE.InstancedMesh(model.geometry, buildingMaterial, indices.length);
      mesh.name = `buildings:${model.name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (let k = 0; k < indices.length; k++) {
        const p = pads[indices[k]];
        // The models are normalized to a 1 x 1 footprint, so one uniform scale
        // sets the plot size and each model keeps its own storey proportions.
        // A tall model would otherwise turn a 25 m plot into a 50 m tower, so
        // the plot's own height budget caps it.
        const scale = Math.min(Math.max(p.width, p.depth), p.height / Math.max(model.size.y, 0.5));
        dummy.position.set(p.x, 0, -p.y);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
        mesh.setColorAt(k, color.setRGB(p.tint, p.tint, p.tint * 1.03));
        aprons.push({ x: p.x, y: p.y, rot: p.rot, size: scale * 1.22 });
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }

    // --- paved lots -----------------------------------------------------------
    // One merged quad per building, a shade of concrete just above the ground
    // plane: buildings meeting raw grass at a hard edge is the single most
    // model-viewer-looking thing left in a mid-zoom shot.
    if (aprons.length > 0) {
      const positions = new Float32Array(aprons.length * 12);
      const indices: number[] = [];
      aprons.forEach((a, i) => {
        const h = a.size / 2;
        const cos = Math.cos(a.rot);
        const sin = Math.sin(a.rot);
        const corners: [number, number][] = [
          [-h, -h],
          [h, -h],
          [h, h],
          [-h, h],
        ];
        corners.forEach(([cx, cz], v) => {
          const o = (i * 4 + v) * 3;
          positions[o] = a.x + cx * cos + cz * sin;
          positions[o + 1] = 0.015;
          positions[o + 2] = -a.y - cx * sin + cz * cos;
        });
        const base = i * 4;
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const material = this.ownMaterial(
        new THREE.MeshStandardMaterial({
          color: 0x8b8880,
          roughness: 0.95,
          metalness: 0,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      );
      const lots = new THREE.Mesh(this.own(geometry), material);
      lots.name = "lots";
      lots.receiveShadow = true;
      this.group.add(lots);
    }
  }

  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  setTheme(spec: ThemeSpec): void {
    // Scenery reads entirely off the shared lighting/IBL; nothing per-theme yet.
  }

  setShadows(cast: boolean): void {
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = cast;
    });
  }

  private own(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    this.ownedGeometries.push(geometry);
    return geometry;
  }

  private ownMaterial<T extends THREE.Material>(material: T): T {
    this.owned.push(material);
    return material;
  }

  dispose(): void {
    for (const object of this.group.children) (object as THREE.InstancedMesh).dispose?.();
    this.ownedGeometries.forEach((g) => g.dispose());
    this.owned.forEach((m) => m.dispose());
    this.group.clear();
  }
}

/** Build the scenery group for one network. */
export function buildEnvironment(
  meta: TrajMeta,
  assets: SceneAssets | null = null,
  options?: ScatterOptions,
): EnvironmentLayer {
  return new EnvironmentLayer(meta, assets, options);
}
