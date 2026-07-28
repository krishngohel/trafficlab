import * as THREE from "three";

import { cityPlan, type BuildingSpot, type BuildingTier, type TreeSpot } from "./city";
import { hashSeed, mulberry32 } from "./scatter";
import type { ModelGeometry, SceneAssets } from "./assets";
import type { ThemeSpec } from "./theme";
import type { TrajMeta } from "../traj";

/**
 * Everything standing up out of the ground in the city: buildings and trees.
 *
 * Placement comes from `city.ts` (pure, seeded by the network name), which fills
 * the blocks between the streets with rows of buildings fronting the kerb. This
 * layer only decides which *model* draws each plot, in four tiers that trade
 * detail for distance:
 *
 *   tower      Kenney skyscrapers, downtown core only
 *   midrise    the 14 full-detail commercial shells, middle ring
 *   lowdetail  the 16 decimated shells, outer ring and block interiors
 *   massing    procedural boxes merged into ONE mesh, out to the horizon
 *
 * The first three are one InstancedMesh per model variant, all sharing
 * `assets.buildingMaterial`, so the whole city costs draw calls but not
 * programs; the fourth costs one call for however many thousand boxes the
 * horizon needs. Every matrix is written once at load and never touched again.
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

  /** Axis-aligned box, base at y0, centred on (cx, cz). */
  box(
    cx: number,
    cz: number,
    hx: number,
    hz: number,
    y0: number,
    y1: number,
    color: readonly number[],
    roof: readonly number[] = color,
  ): void {
    const c: number[][] = [];
    // Corner index = x + 2y + 4z, matching carModel's hexahedron convention.
    for (const z of [cz - hz, cz + hz]) {
      for (const y of [y0, y1]) {
        for (const x of [cx - hx, cx + hx]) c.push([x, y, z]);
      }
    }
    this.quad(c[1], c[3], c[7], c[5], color); // +X
    this.quad(c[0], c[4], c[6], c[2], color); // -X
    this.quad(c[2], c[6], c[7], c[3], roof); // +Y
    this.quad(c[0], c[1], c[5], c[4], color); // -Y
    this.quad(c[4], c[5], c[7], c[6], color); // +Z
    this.quad(c[0], c[2], c[3], c[1], color); // -Z
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

  get empty(): boolean {
    return this.positions.length === 0;
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
  b.box(0, 0, 0.5, 0.5, 0, 1.4, wall);
  b.box(0, 0, 0.46, 0.46, 1.4, 1.45, roof);
  return b.build();
}

/** Wall / roof palette for the merged horizon massing, in sRGB. */
const MASSING_WALLS = [0x8b8985, 0x94908a, 0x7f8184, 0x969087, 0x84837f, 0x8d8781];
const MASSING_ROOFS = [0x4b4e54, 0x424446, 0x565148];

/**
 * Scenery for one network: one InstancedMesh per tree and per building model,
 * plus a single merged mesh for the distant massing.
 */
export class EnvironmentLayer {
  readonly group = new THREE.Group();

  private readonly owned: THREE.Material[] = [];
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];

  constructor(meta: TrajMeta, assets: SceneAssets | null) {
    this.group.name = "environment";
    const plan = cityPlan(meta);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const rand = mulberry32(hashSeed(`${meta.network_name ?? "network"}:models`));

    // --- trees --------------------------------------------------------------
    const trees: TreeSpot[] = plan.trees;
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
    const fallback: ModelGeometry[] = [
      { name: "pad", geometry: this.own(buildPadGeometry()), size: new THREE.Vector3(1, 1, 1.45) },
    ];
    const tiers: Record<Exclude<BuildingTier, "massing">, ModelGeometry[]> = {
      tower: assets?.towers?.length ? assets.towers : assets?.buildings?.length ? assets.buildings : fallback,
      midrise: assets?.buildings?.length ? assets.buildings : fallback,
      lowdetail: assets?.lowDetailBuildings?.length
        ? assets.lowDetailBuildings
        : assets?.buildings?.length
          ? assets.buildings
          : fallback,
    };
    const buildingMaterial =
      assets?.buildingMaterial ??
      this.ownMaterial(
        new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.05, vertexColors: true }),
      );

    // Bucket every plot by the model that draws it. A footprint-normalized shell
    // scaled by the plot's frontage comes out `frontage * size.y` tall, so the
    // model whose natural proportion lands closest to the plot's target height
    // wins — that, not a scale fudge, is what keeps the rows varied without
    // turning a 20 m plot into a 50 m tower.
    const buckets = new Map<string, { model: ModelGeometry; spots: BuildingSpot[] }>();
    const massing: BuildingSpot[] = [];
    for (const spot of plan.buildings) {
      if (spot.tier === "massing") {
        massing.push(spot);
        continue;
      }
      const models = tiers[spot.tier];
      const model = chooseModel(models, spot);
      const key = `${spot.tier}:${model.name}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { model, spots: [] };
        buckets.set(key, bucket);
      }
      bucket.spots.push(spot);
    }
    for (const [key, bucket] of buckets) {
      const mesh = new THREE.InstancedMesh(bucket.model.geometry, buildingMaterial, bucket.spots.length);
      mesh.name = `buildings:${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (let k = 0; k < bucket.spots.length; k++) {
        const spot = bucket.spots[k];
        dummy.position.set(spot.x, 0, -spot.y);
        dummy.rotation.set(0, spot.rot, 0);
        dummy.scale.setScalar(spot.width);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
        mesh.setColorAt(k, color.setRGB(spot.tint, spot.tint, spot.tint * 1.03));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }

    // --- distant massing ------------------------------------------------------
    // Past the model budget the city becomes merged boxes: twelve triangles and
    // no instance matrix each, one draw call for the whole horizon. At the range
    // they live at, a box with a darker roof is a building.
    if (massing.length > 0) {
      const builder = new PropBuilder();
      for (const spot of massing) {
        const wall = new THREE.Color(MASSING_WALLS[Math.floor(rand() * MASSING_WALLS.length)]);
        const roof = new THREE.Color(MASSING_ROOFS[Math.floor(rand() * MASSING_ROOFS.length)]);
        const tint = spot.tint;
        const half = spot.width / 2;
        // Sim (x, y) -> scene (x, -z). Footprints are axis-aligned out here.
        builder.box(
          spot.x,
          -spot.y,
          half,
          half * (0.72 + rand() * 0.5),
          0,
          spot.height,
          [wall.r * tint, wall.g * tint, wall.b * tint],
          [roof.r * tint, roof.g * tint, roof.b * tint],
        );
      }
      const material = this.ownMaterial(
        new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, vertexColors: true }),
      );
      const mesh = new THREE.Mesh(this.own(builder.build()), material);
      mesh.name = "massing";
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  setTheme(spec: ThemeSpec): void {
    // Scenery reads entirely off the shared lighting/IBL; nothing per-theme yet.
  }

  setShadows(cast: boolean): void {
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.name !== "massing") mesh.castShadow = cast;
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

/**
 * The model whose natural height at this plot's frontage comes closest to the
 * plot's target height. Ties are broken with the plot's own seeded `pick`, so
 * neighbouring plots of the same size still get different shells.
 */
export function chooseModel(models: readonly ModelGeometry[], spot: BuildingSpot): ModelGeometry {
  if (models.length === 1) return models[0];
  const ranked = models
    .map((model) => ({ model, error: Math.abs(spot.width * model.size.y - spot.height) }))
    .sort((a, b) => a.error - b.error || (a.model.name < b.model.name ? -1 : 1));
  const shortlist = Math.min(3, ranked.length);
  return ranked[Math.floor(spot.pick * shortlist) % shortlist].model;
}

/** Build the scenery group for one network. */
export function buildEnvironment(
  meta: TrajMeta,
  assets: SceneAssets | null = null,
): EnvironmentLayer {
  return new EnvironmentLayer(meta, assets);
}
