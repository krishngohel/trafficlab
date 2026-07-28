import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Loads the CC0 art the scene draws with (Kenney kits + Poly Haven PBR maps and
 * HDRIs, staged into `public/assets/` by `scripts/prepare_assets.mjs`) and turns
 * it into instancing-ready pieces: ONE merged BufferGeometry per model and ONE
 * shared material per kit, so a whole vehicle fleet costs one draw call per
 * model type.
 *
 * Everything is loaded once per page and shared by every SceneView (both sides
 * of a comparison), hence the module-level promise. Nothing here touches the
 * renderer — the PMREM environment maps are built separately by
 * `buildEnvironmentMap`, which needs one.
 */

export const ASSET_BASE = "/assets";

// ---------------------------------------------------------------------------
// Selection + tuning
// ---------------------------------------------------------------------------

/**
 * Sim vehicles are ~4.5 m long. Kenney's cars are chunky by design (a sedan is
 * 0.59 as wide as it is long against ~0.41 for a real one), so length drives the
 * scale and width/height are squashed back toward real proportions — otherwise
 * a "4.5 m" sedan is 2.6 m wide and fills three quarters of a 3.5 m lane.
 */
const CAR_TARGET_LENGTH = 4.5;
const CAR_WIDTH_SQUASH = 0.76;
const CAR_HEIGHT_SQUASH = 0.84;
/** Longer vehicles keep their relative bulk, within limits. */
const CAR_MIN_LENGTH = 4.2;
const CAR_MAX_LENGTH = 5.8;

/**
 * Fleet mix. Weights are relative; ids hash into this distribution so a given
 * vehicle is always the same model (and matches across a comparison).
 * Index 0 is the overflow type, so it must stay the commonest.
 */
export const VEHICLE_MODELS: readonly { name: string; weight: number }[] = [
  { name: "sedan", weight: 22 },
  { name: "hatchback-sports", weight: 14 },
  { name: "suv", weight: 14 },
  { name: "sedan-sports", weight: 10 },
  { name: "suv-luxury", weight: 9 },
  { name: "van", weight: 8 },
  { name: "taxi", weight: 7 },
  { name: "delivery", weight: 6 },
  { name: "truck-flat", weight: 5 },
  { name: "police", weight: 3 },
];

export const BUILDING_MODELS: readonly string[] = [
  "building-a",
  "building-b",
  "building-c",
  "building-e",
  "building-f",
  "building-g",
  "building-h",
  "building-k",
];

export const TREE_MODELS: readonly string[] = [
  "tree_default",
  "tree_oak",
  "tree_tall",
  "tree_fat",
  "tree_pineDefaultA",
  "plant_bushDetailed",
];

/**
 * The nature kit ships mint-green foliage and orange bark (fine for a toy
 * diorama, wrong next to photographic asphalt and grass). Material name ->
 * replacement base colour, in the renderer's LINEAR working space, since these
 * end up in a vertex-colour attribute which three does not convert.
 */
const NATURE_PALETTE: Record<string, [number, number, number]> = {
  leafsGreen: [0.085, 0.2, 0.05],
  leafsDark: [0.045, 0.115, 0.042],
  leafsFall: [0.24, 0.1, 0.02],
  woodBark: [0.115, 0.075, 0.048],
  woodBarkDark: [0.085, 0.056, 0.04],
  grass: [0.13, 0.25, 0.075],
  dirt: [0.13, 0.1, 0.07],
  stone: [0.16, 0.16, 0.17],
  _defaultMat: [0.22, 0.22, 0.22],
};

/** Texture repeat distances, in metres. */
export const ASPHALT_REPEAT = 12;
export const GRASS_REPEAT = 26;

/** Cross-section scale for the roads-kit poles (see `makeMast`). */
const POLE_SLIM = 0.5;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface ModelGeometry {
  name: string;
  geometry: THREE.BufferGeometry;
  /** World-space size of the normalized geometry (m, or units for props). */
  size: THREE.Vector3;
}

export interface VehicleModelAsset extends ModelGeometry {
  weight: number;
}

export interface MastAsset {
  /** Kenney mast, normalized to height 1 with its base at y = 0. */
  geometry: THREE.BufferGeometry;
  /** How far the arm reaches from the pole, in normalized (height=1) units. */
  armReach: number;
  /** Height of the arm tip, in normalized units. */
  armHeight: number;
}

export interface PbrSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

export interface SceneAssets {
  vehicles: VehicleModelAsset[];
  vehicleMaterial: THREE.MeshStandardMaterial;
  /** Uniform driving the velocity-overlay blend on `vehicleMaterial`. */
  vehicleTintMix: { value: number };
  buildings: ModelGeometry[];
  buildingMaterial: THREE.MeshStandardMaterial;
  trees: ModelGeometry[];
  treeMaterial: THREE.MeshStandardMaterial;
  mast: MastAsset;
  lamp: MastAsset;
  propMaterial: THREE.MeshStandardMaterial;
  asphalt: PbrSet;
  grass: PbrSet;
  hdri: { day: THREE.DataTexture; night: THREE.DataTexture };
  /** Wall-clock ms the whole bundle took to fetch + decode. */
  loadMs: number;
  /** Bytes transferred for /assets/, from the Resource Timing API (0 if n/a). */
  bytes: number;
}

// ---------------------------------------------------------------------------
// Geometry plumbing
// ---------------------------------------------------------------------------

/**
 * Copy one attribute into a plain Float32 attribute. Goes through get*() so
 * interleaved sources (which mergeGeometries rejects) flatten out too.
 */
function plainAttribute(
  source: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  itemSize: number,
): THREE.Float32BufferAttribute {
  const out = new Float32Array(source.count * itemSize);
  for (let i = 0; i < source.count; i++) {
    out[i * itemSize] = source.getX(i);
    if (itemSize > 1) out[i * itemSize + 1] = source.getY(i);
    if (itemSize > 2) out[i * itemSize + 2] = source.getZ(i);
  }
  return new THREE.Float32BufferAttribute(out, itemSize);
}

interface FlattenOptions {
  /** Keep UVs (kits that share a colormap atlas). */
  uv: boolean;
  /**
   * Bake each mesh's material colour into a vertex-colour attribute (kits that
   * colour by material instead of by texture). Returns LINEAR rgb.
   */
  bakeColor?: (materialName: string, color: THREE.Color) => [number, number, number];
  /** Add an all-white vertex-colour attribute (so instanceColor can tint). */
  whiteColor?: boolean;
}

/**
 * Flatten a loaded glTF scene into ONE indexed BufferGeometry in the model's
 * own space, dropping everything the shared material does not read (tangents,
 * second UV sets). Node transforms are baked in.
 */
function flattenModel(root: THREE.Object3D, options: FlattenOptions): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const source = mesh.geometry;
    const position = source.getAttribute("position");
    if (!position) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", plainAttribute(position, 3));
    const normal = source.getAttribute("normal");
    geometry.setAttribute(
      "normal",
      normal ? plainAttribute(normal, 3) : new THREE.Float32BufferAttribute(position.count * 3, 3),
    );
    if (options.uv) {
      const uv = source.getAttribute("uv");
      geometry.setAttribute(
        "uv",
        uv ? plainAttribute(uv, 2) : new THREE.Float32BufferAttribute(position.count * 2, 2),
      );
    }
    if (options.bakeColor || options.whiteColor) {
      const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
        | THREE.MeshStandardMaterial
        | undefined;
      const rgb: [number, number, number] = options.bakeColor
        ? options.bakeColor(material?.name ?? "", material?.color ?? new THREE.Color(1, 1, 1))
        : [1, 1, 1];
      const colors = new Float32Array(position.count * 3);
      for (let i = 0; i < position.count; i++) {
        colors[i * 3] = rgb[0];
        colors[i * 3 + 1] = rgb[1];
        colors[i * 3 + 2] = rgb[2];
      }
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    }
    const index = source.getIndex();
    if (index) {
      geometry.setIndex(Array.from({ length: index.count }, (_, i) => index.getX(i)));
    } else {
      geometry.setIndex(Array.from({ length: position.count }, (_, i) => i));
    }
    geometry.applyMatrix4(mesh.matrixWorld);
    parts.push(geometry);
  });
  if (parts.length === 0) return new THREE.BufferGeometry();
  if (parts.length === 1) return parts[0];
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged ?? parts[0];
}

/**
 * Scale (per axis, in model space), sit the result on y = 0 centred on x/z,
 * then rotate about Y. Returns the final world-space size.
 */
function fitGeometry(
  geometry: THREE.BufferGeometry,
  scale: THREE.Vector3,
  rotateY = 0,
): THREE.Vector3 {
  geometry.scale(scale.x, scale.y, scale.z);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  if (rotateY !== 0) geometry.rotateY(rotateY);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const size = new THREE.Vector3();
  geometry.boundingBox!.getSize(size);
  return size;
}

function modelSize(geometry: THREE.BufferGeometry): THREE.Vector3 {
  geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  geometry.boundingBox!.getSize(size);
  return size;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function loadGltf(loader: GLTFLoader, url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => resolve(gltf.scene), undefined, (err) => reject(err));
  });
}

function loadTexture(loader: THREE.TextureLoader, url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, (err) => reject(err));
  });
}

function loadHdr(loader: HDRLoader, url: string): Promise<THREE.DataTexture> {
  return new Promise((resolve, reject) => {
    loader.load(url, (texture) => resolve(texture), undefined, (err) => reject(err));
  });
}

/** Pull the colormap atlas out of a loaded kit model (all its models share it). */
function atlasOf(root: THREE.Object3D): THREE.Texture | null {
  let found: THREE.Texture | null = null;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (found || !mesh.isMesh) return;
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      | THREE.MeshStandardMaterial
      | undefined;
    if (material?.map) found = material.map;
  });
  return found;
}

/** Free every texture/material a loaded glTF scene brought along. */
function disposeGltf(root: THREE.Object3D, keep: THREE.Texture | null): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = material as THREE.MeshStandardMaterial;
      if (m.map && m.map !== keep) m.map.dispose();
      m.dispose();
    }
  });
}

function pbrSet(
  map: THREE.Texture,
  normalMap: THREE.Texture,
  roughnessMap: THREE.Texture,
): PbrSet {
  map.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [map, normalMap, roughnessMap]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
  }
  return { map, normalMap, roughnessMap };
}

/**
 * Velocity coloring has to survive models that carry their own baked colours,
 * so the per-instance colour is *blended* toward the ramp instead of three's
 * default multiply (which would just darken a red car). `mix` is 0 in the
 * default look and 1 while the velocity overlay is on.
 */
function withTintMix(
  material: THREE.MeshStandardMaterial,
  mix: { value: number },
): THREE.MeshStandardMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTintMix = mix;
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform float uTintMix;\nvoid main() {")
      .replace(
        "#include <color_fragment>",
        "diffuseColor.rgb = mix( diffuseColor.rgb, vColor.rgb, uTintMix );",
      );
  };
  material.customProgramCacheKey = () => "trafficlab-tintmix";
  return material;
}

let pending: Promise<SceneAssets> | null = null;
let loaded: SceneAssets | null = null;

/** The bundle, if it has already finished loading. */
export function loadedAssets(): SceneAssets | null {
  return loaded;
}

/** Load (once per page) everything the scene draws with. */
export function loadSceneAssets(base = ASSET_BASE): Promise<SceneAssets> {
  if (pending) return pending;
  pending = loadAll(base).then((assets) => {
    loaded = assets;
    return assets;
  });
  return pending;
}

async function loadAll(base: string): Promise<SceneAssets> {
  const t0 = performance.now();
  const gltf = new GLTFLoader();
  const textures = new THREE.TextureLoader();
  const hdrLoader = new HDRLoader();

  const [carScenes, buildingScenes, treeScenes, propScenes, maps, hdr] = await Promise.all([
    Promise.all(VEHICLE_MODELS.map((m) => loadGltf(gltf, `${base}/models/cars/${m.name}.glb`))),
    Promise.all(BUILDING_MODELS.map((n) => loadGltf(gltf, `${base}/models/buildings/${n}.glb`))),
    Promise.all(TREE_MODELS.map((n) => loadGltf(gltf, `${base}/models/trees/${n}.glb`))),
    Promise.all(
      ["light-curved", "light-square"].map((n) => loadGltf(gltf, `${base}/models/props/${n}.glb`)),
    ),
    Promise.all(
      [
        "asphalt_diff",
        "asphalt_nor",
        "asphalt_rough",
        "grass_diff",
        "grass_nor",
        "grass_rough",
      ].map((n) => loadTexture(textures, `${base}/textures/${n}.jpg`)),
    ),
    Promise.all([
      loadHdr(hdrLoader, `${base}/hdri/sky_day.hdr`),
      loadHdr(hdrLoader, `${base}/hdri/sky_night.hdr`),
    ]),
  ]);

  // --- vehicles -------------------------------------------------------------
  const carAtlas = atlasOf(carScenes[0]);
  const vehicles: VehicleModelAsset[] = VEHICLE_MODELS.map((entry, i) => {
    const geometry = flattenModel(carScenes[i], { uv: true, whiteColor: true });
    const raw = modelSize(geometry);
    // Kenney cars are modelled +Z forward (front wheels sit at +z); the scene
    // wants +X forward, which is a quarter turn about Y.
    const length = THREE.MathUtils.clamp(
      (raw.z * CAR_TARGET_LENGTH) / 2.55,
      CAR_MIN_LENGTH,
      CAR_MAX_LENGTH,
    );
    const s = length / raw.z;
    const size = fitGeometry(
      geometry,
      new THREE.Vector3(s * CAR_WIDTH_SQUASH, s * CAR_HEIGHT_SQUASH, s),
      Math.PI / 2,
    );
    return { name: entry.name, weight: entry.weight, geometry, size };
  });

  const vehicleTintMix = { value: 0 };
  const vehicleMaterial = withTintMix(
    new THREE.MeshStandardMaterial({
      map: carAtlas ?? null,
      roughness: 0.45,
      metalness: 0.1,
      vertexColors: true,
    }),
    vehicleTintMix,
  );
  vehicleMaterial.name = "vehicles";

  // --- buildings ------------------------------------------------------------
  const buildingAtlas = atlasOf(buildingScenes[0]);
  const buildings: ModelGeometry[] = BUILDING_MODELS.map((name, i) => {
    const geometry = flattenModel(buildingScenes[i], { uv: true, whiteColor: true });
    const raw = modelSize(geometry);
    // Normalize the footprint to 1 so the scatter's plot size drives the scale
    // and each model keeps its own height proportion.
    const s = 1 / Math.max(raw.x, raw.z);
    const size = fitGeometry(geometry, new THREE.Vector3(s, s, s));
    return { name, geometry, size };
  });
  const buildingMaterial = new THREE.MeshStandardMaterial({
    map: buildingAtlas ?? null,
    roughness: 0.78,
    metalness: 0.02,
    vertexColors: true,
  });
  buildingMaterial.name = "buildings";

  // --- trees ----------------------------------------------------------------
  const trees: ModelGeometry[] = TREE_MODELS.map((name, i) => {
    const geometry = flattenModel(treeScenes[i], {
      uv: false,
      bakeColor: (materialName, color) => {
        const swap = NATURE_PALETTE[materialName];
        if (swap) return swap;
        // Unknown material: keep the hue but drop the kit's neon saturation.
        const hsl = { h: 0, s: 0, l: 0 };
        color.getHSL(hsl);
        const out = new THREE.Color().setHSL(hsl.h, hsl.s * 0.35, hsl.l * 0.5);
        return [out.r, out.g, out.b];
      },
    });
    const raw = modelSize(geometry);
    const s = 1 / raw.y; // unit height; the scatter's height drives the scale
    const size = fitGeometry(geometry, new THREE.Vector3(s, s, s));
    return { name, geometry, size };
  });
  const treeMaterial = new THREE.MeshStandardMaterial({
    roughness: 0.92,
    metalness: 0,
    vertexColors: true,
  });
  treeMaterial.name = "trees";

  // --- props (signal mast + street lamp) -------------------------------------
  const makeMast = (root: THREE.Object3D): MastAsset => {
    const geometry = flattenModel(root, { uv: false });
    const raw = modelSize(geometry);
    const s = 1 / raw.y;
    // The kit models the arm reaching along -Z with the lamp head at its tip.
    geometry.computeBoundingBox();
    const armReach = -geometry.boundingBox!.min.z * s * POLE_SLIM;
    // Kenney poles are chunky: normalized to height 1 a "6 m" mast would be a
    // half-metre-thick column. Slim the cross section, keep the height.
    fitGeometry(geometry, new THREE.Vector3(s * POLE_SLIM, s, s * POLE_SLIM));
    return { geometry, armReach, armHeight: 1 };
  };
  const mast = makeMast(propScenes[0]);
  const lamp = makeMast(propScenes[1]);
  // Street furniture reads as galvanised steel, not Kenney's cream palette,
  // and dropping the atlas lets the masts merge with the procedural arms and
  // housings into a single mesh.
  const propMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a2f36,
    roughness: 0.55,
    metalness: 0.45,
  });
  propMaterial.name = "props";

  for (const [i, root] of carScenes.entries()) disposeGltf(root, i === 0 ? carAtlas : null);
  for (const [i, root] of buildingScenes.entries()) {
    disposeGltf(root, i === 0 ? buildingAtlas : null);
  }
  for (const root of treeScenes) disposeGltf(root, null);
  for (const root of propScenes) disposeGltf(root, null);
  for (const atlas of [carAtlas, buildingAtlas]) {
    if (atlas) {
      atlas.colorSpace = THREE.SRGBColorSpace;
      // The kits' colormap is a palette atlas: filtering across cells bleeds
      // one swatch into the next, which is exactly the muddy look to avoid.
      atlas.minFilter = THREE.LinearMipmapLinearFilter;
      atlas.magFilter = THREE.LinearFilter;
      atlas.anisotropy = 4;
      atlas.needsUpdate = true;
    }
  }

  const asphalt = pbrSet(maps[0], maps[1], maps[2]);
  const grass = pbrSet(maps[3], maps[4], maps[5]);
  for (const texture of [hdr[0], hdr[1]]) {
    texture.mapping = THREE.EquirectangularReflectionMapping;
  }

  const loadMs = performance.now() - t0;
  let bytes = 0;
  try {
    for (const entry of performance.getEntriesByType("resource")) {
      if (entry.name.includes(`${base}/`)) {
        bytes += (entry as PerformanceResourceTiming).transferSize || 0;
      }
    }
  } catch {
    /* Resource Timing is optional */
  }

  return {
    vehicles,
    vehicleMaterial,
    vehicleTintMix,
    buildings,
    buildingMaterial,
    trees,
    treeMaterial,
    mast,
    lamp,
    propMaterial,
    asphalt,
    grass,
    hdri: { day: hdr[0], night: hdr[1] },
    loadMs,
    bytes,
  };
}

// ---------------------------------------------------------------------------
// Environment maps (need a renderer, so they are built by the engine)
// ---------------------------------------------------------------------------

const envCache = new WeakMap<THREE.Texture, THREE.Texture>();

/** Prefiltered radiance map for an equirectangular HDRI, built once per HDRI. */
export function buildEnvironmentMap(
  renderer: THREE.WebGLRenderer,
  hdr: THREE.Texture,
): THREE.Texture {
  const cached = envCache.get(hdr);
  if (cached) return cached;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromEquirectangular(hdr);
  pmrem.dispose();
  envCache.set(hdr, target.texture);
  return target.texture;
}
