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
 * Kenney's cars are chunky by design: a sedan is 0.59 as wide and 0.57 as tall
 * as it is long, against ~0.40 and ~0.32 for a real one. Left alone at sim
 * scale that reads as a toy — a "4.5 m" sedan comes out 2.6 m wide and 2.6 m
 * tall, filling three quarters of a 3.5 m lane and standing taller than a van.
 *
 * So length drives the scale (per class, below), width is squashed back toward
 * real track widths, and the greenhouse is folded down separately by
 * `lowerRoof` — squashing the whole model in Y instead would turn the (already
 * oversized) wheels into ovals, which is far more obvious at closeup than a
 * slightly tall roof.
 */
const CAR_HEIGHT_SQUASH = 0.9;

/**
 * Per-class scaling. `target` is the length a model of the reference size
 * (2.55 model units, a sedan) is drawn at; longer models scale up from there
 * and are clamped so a firetruck stays a firetruck and a hatchback stays a
 * hatchback. `roof` is how far the bodywork above the wheel arches is folded
 * down (1 = untouched), which is what actually separates a saloon roofline
 * from a box van.
 */
interface VehicleClass {
  target: number;
  min: number;
  max: number;
  /** Width scale relative to the length-driven scale. */
  width: number;
  /** Vertical compression applied above the wheel arches. */
  roof: number;
}

const VEHICLE_CLASSES: Record<string, VehicleClass> = {
  car: { target: 4.6, min: 4.3, max: 5.0, width: 0.7, roof: 0.64 },
  suv: { target: 4.9, min: 4.6, max: 5.3, width: 0.68, roof: 0.74 },
  van: { target: 5.5, min: 5.1, max: 6.0, width: 0.62, roof: 0.82 },
  // Capped short of a real fire engine: the sim spaces every vehicle as a ~4.5 m
  // car, so an honest 9 m truck would sit inside the car in front of it.
  truck: { target: 6.1, min: 5.6, max: 6.7, width: 0.66, roof: 0.94 },
};

/**
 * The kit's wheels are half again as big as a real car's, which is exactly the
 * proportion that reads as a toy — and it only gets louder once the roofline
 * comes down. Shrink each wheel about its own hub, keeping the contact patch on
 * the ground so ride height is unchanged; the arch gap that opens up is what a
 * real wheel well looks like anyway.
 */
const WHEEL_SHRINK = 0.82;

/** Models whose paint is a livery: they keep the atlas colours as authored. */
const LIVERY_MODELS = new Set(["taxi", "police", "ambulance", "firetruck", "garbage-truck"]);

/**
 * Fleet mix. Weights are relative; ids hash into this distribution so a given
 * vehicle is always the same model (and matches across a comparison).
 * Index 0 is the overflow type, so it must stay the commonest.
 */
export const VEHICLE_MODELS: readonly { name: string; weight: number; kind: string }[] = [
  { name: "sedan", weight: 22, kind: "car" },
  { name: "hatchback-sports", weight: 13, kind: "car" },
  { name: "suv", weight: 13, kind: "suv" },
  { name: "sedan-sports", weight: 9, kind: "car" },
  { name: "suv-luxury", weight: 8, kind: "suv" },
  { name: "van", weight: 7, kind: "van" },
  { name: "taxi", weight: 6, kind: "car" },
  { name: "delivery", weight: 5, kind: "van" },
  { name: "truck-flat", weight: 4, kind: "truck" },
  { name: "truck", weight: 4, kind: "truck" },
  { name: "delivery-flat", weight: 3, kind: "van" },
  { name: "police", weight: 2, kind: "car" },
  // Rare, but a crowd with no exceptions in it reads as a texture.
  { name: "ambulance", weight: 1, kind: "van" },
  { name: "firetruck", weight: 1, kind: "truck" },
  { name: "garbage-truck", weight: 1, kind: "truck" },
];

/**
 * Real traffic is overwhelmingly white / black / grey / silver with the odd
 * saturated car in it, and getting that distribution right does more for the
 * "this is a street" read than any amount of shader work. Linear rgb, since
 * these go straight into an instance-colour attribute (three does not convert
 * `Color.setRGB`). Weights are percentage-ish shares of the civilian fleet.
 */
export const VEHICLE_PAINTS: readonly { rgb: [number, number, number]; weight: number }[] = [
  { rgb: [0.78, 0.78, 0.77], weight: 21 }, // white
  { rgb: [0.022, 0.022, 0.025], weight: 16 }, // black
  { rgb: [0.44, 0.46, 0.5], weight: 13 }, // silver
  { rgb: [0.14, 0.15, 0.17], weight: 11 }, // graphite
  { rgb: [0.33, 0.34, 0.36], weight: 6 }, // gunmetal
  { rgb: [0.035, 0.06, 0.15], weight: 6 }, // navy
  { rgb: [0.05, 0.13, 0.34], weight: 4 }, // blue
  { rgb: [0.3, 0.02, 0.02], weight: 5 }, // red
  { rgb: [0.11, 0.014, 0.02], weight: 3 }, // burgundy
  { rgb: [0.38, 0.32, 0.24], weight: 4 }, // beige
  { rgb: [0.02, 0.075, 0.045], weight: 4 }, // dark green
  { rgb: [0.05, 0.16, 0.2], weight: 3 }, // teal
  { rgb: [0.5, 0.33, 0.02], weight: 2 }, // amber
  { rgb: [0.46, 0.12, 0.015], weight: 2 }, // orange
];

/** Mid-rise shells (a-n) then the towers, kept last so the core can slice them. */
export const BUILDING_MODELS: readonly string[] = [
  "building-a",
  "building-b",
  "building-c",
  "building-d",
  "building-e",
  "building-f",
  "building-g",
  "building-h",
  "building-i",
  "building-j",
  "building-k",
  "building-l",
  "building-m",
  "building-n",
];

/** The five towers, placed only in the downtown core. */
export const TOWER_MODELS: readonly string[] = [
  "building-skyscraper-a",
  "building-skyscraper-b",
  "building-skyscraper-c",
  "building-skyscraper-d",
  "building-skyscraper-e",
];

/**
 * Decimated shells for the outer city, where a block is four pixels tall and
 * nobody can tell. Whole set costs ~216 KB, which is what makes a horizon of
 * hundreds of buildings affordable.
 */
export const LOWDETAIL_MODELS: readonly string[] = [
  "low-detail-building-a",
  "low-detail-building-b",
  "low-detail-building-c",
  "low-detail-building-d",
  "low-detail-building-e",
  "low-detail-building-f",
  "low-detail-building-g",
  "low-detail-building-h",
  "low-detail-building-i",
  "low-detail-building-j",
  "low-detail-building-k",
  "low-detail-building-l",
  "low-detail-building-m",
  "low-detail-building-n",
  "low-detail-building-wide-a",
  "low-detail-building-wide-b",
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
  /** Downtown-only towers, footprint-normalized like `buildings`. */
  towers: ModelGeometry[];
  /** Decimated shells for the outer city; same material as `buildings`. */
  lowDetailBuildings: ModelGeometry[];
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

// ---------------------------------------------------------------------------
// Vehicle surfaces
// ---------------------------------------------------------------------------

/**
 * Every car in the kit is one mesh set sharing one `colormap` material, so
 * there are no named sub-materials to split on — but the atlas is a 16 x 4 grid
 * of palette cells and Kenney maps each face onto the horizontal centre of one
 * cell, which means a vertex's uv names its surface exactly. That is what makes
 * paint / glass / rubber separable at all, and it is per-vertex data rather
 * than per-mesh, so the whole fleet still draws as one InstancedMesh per model.
 */
const ATLAS_COLS = 16;
const ATLAS_ROWS = 4;

interface SurfaceClass {
  /** 1 = repaintable bodywork, 0 = keep the authored atlas colour. */
  paint: number;
  /** Multiplier on the atlas colour (darkens glass, tyres, bumpers). */
  shade: number;
  roughness: number;
  metalness: number;
  /** 0 none, 1 steady lamp, 2 red lamp that brightens under braking. */
  glow: number;
}

/**
 * Car paint is a dielectric under clearcoat, not a metal: high metalness here
 * is what turns a fleet into a row of dark mirrors.
 */
const BODYWORK: SurfaceClass = { paint: 1, shade: 1, roughness: 0.25, metalness: 0.06, glow: 0 };
/**
 * The kit's second bodywork cell — sills, bumpers and wings on a saloon, the
 * roof and shoulders on an SUV, the box on a van, and the dark half of a
 * police livery. Painted like the rest of the shell (a real car is one colour
 * from sill to roof) but a shade down, which reads as the panel-gap shading the
 * low-poly geometry cannot provide, and keeps a two-tone livery two-tone.
 */
const SECOND_PANEL: SurfaceClass = { paint: 1, shade: 0.8, roughness: 0.36, metalness: 0.1, glow: 0 };
/**
 * Automotive glass is mostly a reflection of the sky, so it wants to be dark
 * *and* shiny — taken too far it turns into a black hole punched in the roof.
 */
const GLASS: SurfaceClass = { paint: 0, shade: 0.32, roughness: 0.07, metalness: 0.6, glow: 0 };
const RUBBER: SurfaceClass = { paint: 0, shade: 0.42, roughness: 0.94, metalness: 0, glow: 0 };
const RIM: SurfaceClass = { paint: 0, shade: 0.85, roughness: 0.24, metalness: 0.95, glow: 0 };
const LAMP: SurfaceClass = { paint: 0, shade: 1, roughness: 0.16, metalness: 0, glow: 1 };
const BRAKE_LAMP: SurfaceClass = { paint: 0, shade: 1, roughness: 0.16, metalness: 0, glow: 2 };

/** Atlas cell (`col,row`) -> surface. Anything unlisted is bodywork. */
const CAR_ATLAS_SURFACES: Record<string, SurfaceClass> = {
  "5,2": RUBBER, // tyres, wheel-arch interiors, underbody
  "7,2": SECOND_PANEL, // sills and bumpers, or a roof, or a van's box body
  "11,2": RIM, // wheel rims
  "1,3": GLASS, // windscreen, side and rear glass
  "3,3": LAMP, // headlights
  "5,3": BRAKE_LAMP, // tail lights, and the red half of a police beacon
  "7,3": LAMP, // blue beacons
};

function surfaceAt(u: number, v: number): SurfaceClass {
  const col = Math.min(ATLAS_COLS - 1, Math.max(0, Math.floor(u * ATLAS_COLS)));
  const row = Math.min(ATLAS_ROWS - 1, Math.max(0, Math.floor(v * ATLAS_ROWS)));
  return CAR_ATLAS_SURFACES[`${col},${row}`] ?? BODYWORK;
}

interface VehicleFlattened {
  geometry: THREE.BufferGeometry;
  /** Height of the top of the wheels above the model's underside, model units. */
  wheelTop: number;
}

/**
 * Flatten a car the way `flattenModel` flattens everything else, plus the
 * per-vertex surface attributes the vehicle shader reads and the wheel height
 * `lowerRoof` hinges on.
 */
function flattenVehicle(root: THREE.Object3D, livery: boolean): VehicleFlattened {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  let minY = Infinity;
  let wheelTop = -Infinity;
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
    const uv = source.getAttribute("uv");
    geometry.setAttribute(
      "uv",
      uv ? plainAttribute(uv, 2) : new THREE.Float32BufferAttribute(position.count * 2, 2),
    );
    // All-white vertex colours: `vertexColors` is what routes the per-instance
    // colour into vColor, which the shader uses for paint and the velocity ramp.
    const colors = new Float32Array(position.count * 3).fill(1);
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const surf = new Float32Array(position.count * 4);
    const glow = new Float32Array(position.count);
    for (let i = 0; i < position.count; i++) {
      const s = uv ? surfaceAt(uv.getX(i), uv.getY(i)) : BODYWORK;
      surf[i * 4] = livery ? 0 : s.paint;
      surf[i * 4 + 1] = s.shade;
      surf[i * 4 + 2] = s.roughness;
      surf[i * 4 + 3] = s.metalness;
      glow[i] = s.glow;
    }
    geometry.setAttribute("aSurf", new THREE.Float32BufferAttribute(surf, 4));
    geometry.setAttribute("aGlow", new THREE.Float32BufferAttribute(glow, 1));
    const index = source.getIndex();
    if (index) {
      geometry.setIndex(Array.from({ length: index.count }, (_, i) => index.getX(i)));
    } else {
      geometry.setIndex(Array.from({ length: position.count }, (_, i) => i));
    }
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingBox();
    let box = geometry.boundingBox!;
    if (mesh.name.startsWith("wheel")) {
      // Shrink in the wheel's own plane (the axle runs along x), then drop it
      // back onto its contact patch.
      const cy = (box.min.y + box.max.y) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const drop = ((box.max.y - box.min.y) / 2) * (1 - WHEEL_SHRINK);
      geometry.translate(0, -cy, -cz);
      geometry.scale(1, WHEEL_SHRINK, WHEEL_SHRINK);
      geometry.translate(0, cy - drop, cz);
      geometry.computeBoundingBox();
      box = geometry.boundingBox!;
      wheelTop = Math.max(wheelTop, box.max.y);
    }
    minY = Math.min(minY, box.min.y);
    parts.push(geometry);
  });
  if (parts.length === 0) {
    return { geometry: new THREE.BufferGeometry(), wheelTop: 0 };
  }
  const merged = parts.length === 1 ? parts[0] : (mergeGeometries(parts, false) ?? parts[0]);
  if (parts.length > 1 && merged !== parts[0]) parts.forEach((p) => p.dispose());
  return { geometry: merged, wheelTop: wheelTop > -Infinity ? wheelTop - minY : 0 };
}

/**
 * Fold the bodywork above `hinge` (the top of the wheels) down by `k`, in place.
 * A saloon in this kit is 2.2 m tall at sim scale, almost all of it an
 * over-tall glasshouse; compressing only that leaves the wheels and the arches
 * exactly where they were. Normals above the hinge take the inverse scale.
 */
function lowerRoof(geometry: THREE.BufferGeometry, hinge: number, k: number): void {
  if (k >= 0.999) return;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y <= hinge) continue;
    position.setY(i, hinge + (y - hinge) * k);
    const nx = normal.getX(i);
    const ny = normal.getY(i) / k;
    const nz = normal.getZ(i);
    const len = Math.hypot(nx, ny, nz) || 1;
    normal.setXYZ(i, nx / len, ny / len, nz / len);
  }
  position.needsUpdate = true;
  normal.needsUpdate = true;
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
 * One material for the whole fleet, driven entirely by per-vertex data so the
 * fleet still costs one draw call per model type:
 *
 *  - `aSurf` = (paint mask, diffuse scale, roughness, metalness) per vertex,
 *    baked from the atlas cell each vertex maps to. This is what gives a car
 *    glossy paint, a near-mirror windscreen and dead-matte black tyres out of
 *    one MeshStandardMaterial with no roughness/metalness textures at all.
 *  - the per-instance colour repaints the masked bodywork, so each vehicle gets
 *    its own colour without a material (or even a geometry) of its own.
 *  - `aGlow` marks the lamps; the red ones brighten with the per-instance
 *    `aBrake` flag, so a queue lights up as it stops.
 *
 * Velocity colouring has to survive all of that, so it is a *blend* toward the
 * ramp rather than three's default multiply (which would just darken a red
 * car): `mix` is 0 in the default look and 1 while the overlay is on, and it
 * also mutes the lamps so the ramp reads cleanly.
 */
function withVehicleShading(
  material: THREE.MeshStandardMaterial,
  mix: { value: number },
): THREE.MeshStandardMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTintMix = mix;
    shader.vertexShader = shader.vertexShader.replace(
      "void main() {",
      [
        "attribute vec4 aSurf;",
        "attribute float aGlow;",
        "attribute float aBrake;",
        "varying vec4 vSurf;",
        "varying float vGlow;",
        "varying float vBrake;",
        "void main() {",
        "\tvSurf = aSurf;",
        "\tvGlow = aGlow;",
        "\tvBrake = aBrake;",
      ].join("\n"),
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        [
          "uniform float uTintMix;",
          "varying vec4 vSurf;",
          "varying float vGlow;",
          "varying float vBrake;",
          "void main() {",
        ].join("\n"),
      )
      .replace(
        "#include <color_fragment>",
        [
          "\tvec3 lampColor = diffuseColor.rgb * vSurf.y;",
          "\tdiffuseColor.rgb = mix( diffuseColor.rgb, vColor.rgb, vSurf.x ) * vSurf.y;",
          "\tdiffuseColor.rgb = mix( diffuseColor.rgb, vColor.rgb, uTintMix );",
        ].join("\n"),
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = vSurf.z;")
      .replace("#include <metalnessmap_fragment>", "float metalnessFactor = vSurf.w;")
      .replace(
        "#include <emissivemap_fragment>",
        [
          "#include <emissivemap_fragment>",
          "\tfloat lampGain = vGlow > 1.5 ? mix( 0.30, 3.2, vBrake ) : step( 0.5, vGlow );",
          "\ttotalEmissiveRadiance += lampColor * lampGain * ( 1.0 - uTintMix );",
        ].join("\n"),
      );
  };
  material.customProgramCacheKey = () => "trafficlab-vehicle";
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

  const [carScenes, buildingScenes, towerScenes, lowDetailScenes, treeScenes, propScenes, maps, hdr] =
    await Promise.all([
    Promise.all(VEHICLE_MODELS.map((m) => loadGltf(gltf, `${base}/models/cars/${m.name}.glb`))),
    Promise.all(BUILDING_MODELS.map((n) => loadGltf(gltf, `${base}/models/buildings/${n}.glb`))),
    Promise.all(TOWER_MODELS.map((n) => loadGltf(gltf, `${base}/models/buildings/${n}.glb`))),
    Promise.all(LOWDETAIL_MODELS.map((n) => loadGltf(gltf, `${base}/models/lowdetail/${n}.glb`))),
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
    const spec = VEHICLE_CLASSES[entry.kind] ?? VEHICLE_CLASSES.car;
    const { geometry, wheelTop } = flattenVehicle(carScenes[i], LIVERY_MODELS.has(entry.name));
    const raw = modelSize(geometry);
    // Kenney cars are modelled +Z forward (front wheels sit at +z); the scene
    // wants +X forward, which is a quarter turn about Y.
    const length = THREE.MathUtils.clamp((raw.z * spec.target) / 2.55, spec.min, spec.max);
    const s = length / raw.z;
    fitGeometry(
      geometry,
      new THREE.Vector3(s * spec.width, s * CAR_HEIGHT_SQUASH, s),
      Math.PI / 2,
    );
    lowerRoof(geometry, wheelTop * s * CAR_HEIGHT_SQUASH, spec.roof);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const size = new THREE.Vector3();
    geometry.boundingBox!.getSize(size);
    return { name: entry.name, weight: entry.weight, geometry, size };
  });

  const vehicleTintMix = { value: 0 };
  const vehicleMaterial = withVehicleShading(
    new THREE.MeshStandardMaterial({
      map: carAtlas ?? null,
      // Roughness/metalness come from `aSurf` per vertex; these are only the
      // values the depth/shadow pass and any un-attributed geometry fall back to.
      roughness: 0.4,
      metalness: 0.2,
      envMapIntensity: 1.35,
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
  // Towers and decimated shells share the kit atlas, so they share the material
  // and the city can draw every tier without extra programs.
  const footprintNormalized = (scenes: THREE.Group[], names: readonly string[]) =>
    names.map((name, i) => {
      const geometry = flattenModel(scenes[i], { uv: true, whiteColor: true });
      const raw = modelSize(geometry);
      const s = 1 / Math.max(raw.x, raw.z);
      const size = fitGeometry(geometry, new THREE.Vector3(s, s, s));
      return { name, geometry, size };
    });
  const towers = footprintNormalized(towerScenes, TOWER_MODELS);
  const lowDetailBuildings = footprintNormalized(lowDetailScenes, LOWDETAIL_MODELS);

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
  for (const root of towerScenes) disposeGltf(root, null);
  for (const root of lowDetailScenes) disposeGltf(root, null);
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
    towers,
    lowDetailBuildings,
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
