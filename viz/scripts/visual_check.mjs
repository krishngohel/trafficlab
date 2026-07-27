/* Headless visual verification: boots the viewer, loads a fixture by simulated
 * drag-drop, exercises overlays/cameras/scrub, measures render FPS, and saves
 * screenshots for human inspection.
 *
 *   node scripts/visual_check.mjs <outDir> [fixture=stress.traj] [base=http://localhost:3199]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const outDir = positional[0] ?? "visual-check";
const fixture = positional[1] ?? "stress.traj";
const base = positional[2] ?? "http://localhost:3199";
mkdirSync(outDir, { recursive: true });

const headed = process.argv.includes("--headed");
const browser = await chromium.launch({
  headless: !headed,
  args: [...(headed ? [] : ["--headless=new"]), "--use-angle=d3d11", "--enable-gpu",
         "--enable-unsafe-swiftshader", "--window-size=1680,980"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 940 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(outDir, name + ".png") });
  console.log("shot:", name);
};

// `networkidle` never settles reliably against the dev server (the HMR socket
// stays open), so wait for the app's own landing UI instead.
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Load grid2x2 demo" }).waitFor({ timeout: 30000 });
await shot("00_landing");

// Load fixture through the hidden primary file input.
await page.locator('input[type="file"]').first()
  .setInputFiles(join(process.cwd(), "public", "fixtures", fixture));
await page.waitForTimeout(2500);
await shot("01_loaded");

// GPU / renderer info.
const glInfo = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("renderer:", glInfo);

const fpsProbe = () => page.evaluate(() => new Promise((res) => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => {
    n++;
    if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
    else res(n / 3);
  };
  requestAnimationFrame(tick);
}));

// Seek to 55% — mid-episode has queues, platoons, and phase variety.
// (Playback auto-starts on load; drive the React range input natively.)
await page.evaluate(() => {
  const slider = document.querySelector('input[type="range"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(slider, String(Number(slider.max) * 0.55));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(2000); // let it play a couple seconds
const fpsBare = await fpsProbe();
console.log("fps (playing, no overlays):", fpsBare.toFixed(1));
await shot("02_playing");

// Overlays one at a time, then all.
const overlays = ["Queue heatmap", "Signal phase timers", "Velocity coloring",
                  "Trajectory ribbon (selected)", "Ribbons: all vehicles (≤200)",
                  "Pressure field (rewards)"];
let idx = 3;
for (const label of overlays) {
  const el = page.getByText(label, { exact: false }).first();
  try { await el.click({ timeout: 2500 }); } catch { console.log("MISSING overlay control:", label); continue; }
  await page.waitForTimeout(700);
  await shot(String(idx).padStart(2, "0") + "_" + label.replace(/[^a-z]+/gi, "_").toLowerCase());
  idx++;
}
const fpsAll = await fpsProbe();
console.log("fps (playing, ALL overlays):", fpsAll.toFixed(1));
await shot("09_all_overlays");

// Cameras.
try {
  await page.getByRole("button", { name: "Top-down" }).click({ timeout: 2500 });
  await page.waitForTimeout(700);
  await shot("10_topdown");
  await page.getByRole("button", { name: "Orbit" }).click({ timeout: 2500 });
} catch { console.log("MISSING camera buttons"); }

// Scrub to 30% via the range input.
try {
  const box = await page.locator('input[type="range"]').first().boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.waitForTimeout(700);
    await shot("11_scrubbed");
  }
} catch { console.log("no range input found"); }

// Split-screen compare: feed the secondary file input.
try {
  await page.locator('input[type="file"]').nth(1)
    .setInputFiles(join(process.cwd(), "public", "fixtures", "grid2x2_demo.traj"));
  await page.waitForTimeout(1500);
  await shot("12_compare");
} catch (e) { console.log("compare load failed:", String(e).slice(0, 200)); }

console.log("console errors:", errors.length ? errors.slice(0, 12) : "none");
await browser.close();
