/* Stage the CC0 assets the scene actually ships.
 *
 * `assets_src/` holds four full Kenney kits (400+ GLBs) plus 2k Poly Haven maps
 * and two 2k HDRIs — ~90 MB we must not put on the wire. This script copies the
 * handful of selected models into `public/assets/`, downsamples the PBR maps to
 * 1k JPEG (sharp) and the HDRIs to 1k Radiance (ffmpeg), and copies the kits'
 * shared `colormap.png` atlases next to their models so the GLBs' relative
 * texture URIs still resolve.
 *
 *   node scripts/prepare_assets.mjs [--force]
 *
 * Idempotent: skips outputs that are newer than their source unless --force.
 * `public/assets/` is committed — this only has to run when the selection
 * changes.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "assets_src");
const out = join(root, "public", "assets");
const force = process.argv.includes("--force");

const KITS = {
  cars: join(src, "kenney_car-kit", "Models", "GLB format"),
  buildings: join(src, "kenney_city-kit-commercial", "Models", "GLB format"),
  // Same kit as `buildings`, but the kit's own decimated variants — the city
  // fabric places hundreds of these past the detail radius.
  lowdetail: join(src, "kenney_city-kit-commercial", "Models", "GLB format"),
  props: join(src, "kenney_city-kit-roads", "Models", "GLB format"),
  trees: join(src, "kenney_nature-kit", "Models", "GLTF format"),
};

/** Selected models per destination folder. Keep in sync with lib/scene/assets.ts. */
const MODELS = {
  cars: [
    "sedan",
    "sedan-sports",
    "hatchback-sports",
    "suv",
    "suv-luxury",
    "van",
    "taxi",
    "police",
    "delivery",
    "truck-flat",
    // Heavier/rarer traffic: silhouette variety is what sells a crowd.
    "truck",
    "delivery-flat",
    "ambulance",
    "firetruck",
    "garbage-truck",
  ],
  // Full commercial set — 14 mid-rise shells plus 5 towers for the core.
  buildings: [
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
    "building-skyscraper-a",
    "building-skyscraper-b",
    "building-skyscraper-c",
    "building-skyscraper-d",
    "building-skyscraper-e",
  ],
  // 6-26 KB each: the whole set costs less than one detailed shell.
  lowdetail: [
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
  ],
  // Roads kit: the signal mast and the street lamp.
  props: ["light-curved", "light-square"],
  trees: [
    "tree_default",
    "tree_oak",
    "tree_tall",
    "tree_fat",
    "tree_pineDefaultA",
    "plant_bushDetailed",
  ],
};

/**
 * Kits whose GLBs reference a shared `Textures/colormap.png`, with an optional
 * recolour. Kenney's car palette is saturated toy primaries; real traffic is
 * mostly white/silver/grey, so the fleet gets pulled a long way down before it
 * sits next to photographic asphalt.
 */
const ATLAS_KITS = {
  cars: { saturation: 0.62, brightness: 1.02 },
  buildings: null,
  lowdetail: null,
  props: null,
};

/**
 * [source, output, size, jpeg quality, sRGB colour data, optional recolour]
 *
 * Poly Haven's `aerial_grass_rock` is a dry savanna scan — mean RGB (114, 97,
 * 37), which reads as dead field rather than verge. One hue rotation at bake
 * time turns it into grass (78, 106, 61); doing it here instead of with a
 * material tint keeps the rock speckles neutral.
 */
const TEXTURES = [
  ["asphalt_diff_2k.jpg", "asphalt_diff.jpg", 1024, 84, true],
  ["asphalt_nor_2k.jpg", "asphalt_nor.jpg", 1024, 88, false],
  ["asphalt_rough_2k.jpg", "asphalt_rough.jpg", 1024, 80, false],
  ["grass_diff_2k.jpg", "grass_diff.jpg", 1024, 84, true, { hue: 42, saturation: 0.8, brightness: 0.98 }],
  ["grass_nor_2k.jpg", "grass_nor.jpg", 1024, 88, false],
  ["grass_rough_2k.jpg", "grass_rough.jpg", 1024, 80, false],
];

const HDRIS = [
  ["sky_day_2k.hdr", "sky_day.hdr"],
  ["sky_night_2k.hdr", "sky_night.hdr"],
];

const stale = (from, to) =>
  force || !existsSync(to) || statSync(to).mtimeMs < statSync(from).mtimeMs;

function ensure(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

let copied = 0;
for (const [kit, names] of Object.entries(MODELS)) {
  const dir = ensure(join(out, "models", kit));
  for (const name of names) {
    const from = join(KITS[kit], `${name}.glb`);
    if (!existsSync(from)) throw new Error(`missing model: ${from}`);
    const to = join(dir, `${name}.glb`);
    if (stale(from, to)) {
      copyFileSync(from, to);
      copied++;
    }
  }
  if (kit in ATLAS_KITS) {
    const from = join(KITS[kit], "Textures", "colormap.png");
    const to = join(ensure(join(dir, "Textures")), "colormap.png");
    if (stale(from, to)) {
      const recolor = ATLAS_KITS[kit];
      if (recolor) await sharp(from).modulate(recolor).png().toFile(to);
      else copyFileSync(from, to);
      copied++;
    }
  }
}

const texDir = ensure(join(out, "textures"));
for (const [from, name, size, quality, srgb, recolor] of TEXTURES) {
  const source = join(src, from);
  const to = join(texDir, name);
  if (!stale(source, to)) continue;
  let pipe = sharp(source).resize(size, size, { fit: "fill" });
  if (recolor) pipe = pipe.modulate(recolor);
  // Colour maps are sRGB; normal/roughness are data — keep them untouched
  // beyond the resize (sharp works in the source space by default).
  await pipe.jpeg({ quality, chromaSubsampling: srgb ? "4:2:0" : "4:4:4" }).toFile(to);
  copied++;
}

const hdrDir = ensure(join(out, "hdri"));
for (const [from, name] of HDRIS) {
  const source = join(src, from);
  const to = join(hdrDir, name);
  if (!stale(source, to)) continue;
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", source, "-vf", "scale=1024:512", to],
    { stdio: "inherit" },
  );
  copied++;
}

copyFileSync(join(src, "LICENSES.md"), join(out, "LICENSES.md"));

// --- report ------------------------------------------------------------------
let total = 0;
const walk = (dir, depth = 0) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, depth + 1);
    else total += statSync(p).size;
  }
};
walk(out);

const perGroup = {};
for (const group of ["models/cars", "models/buildings", "models/lowdetail", "models/props", "models/trees", "textures", "hdri"]) {
  let bytes = 0;
  const dir = join(out, ...group.split("/"));
  const sum = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) sum(p);
      else bytes += statSync(p).size;
    }
  };
  sum(dir);
  perGroup[group] = bytes;
}

const lines = Object.entries(perGroup).map(
  ([g, b]) => `  ${g.padEnd(18)} ${(b / 1024).toFixed(0).padStart(6)} KB`,
);
console.log(`prepare_assets: ${copied} file(s) written\n${lines.join("\n")}`);
console.log(`  ${"TOTAL".padEnd(18)} ${(total / 1024).toFixed(0).padStart(6)} KB`);

writeFileSync(
  join(out, "MANIFEST.json"),
  JSON.stringify({ models: MODELS, bytes: perGroup, total }, null, 2) + "\n",
);
