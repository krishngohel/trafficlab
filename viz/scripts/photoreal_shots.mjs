/* Look review + perf gate for the photoreal scene.
 *
 * Loads a fixture against the running dev server, then for BOTH themes shoots
 * three reproducible framings (overview / mid / follow closeup), measures FPS
 * with every overlay on, and reports draw calls, triangles and asset load time.
 *
 *   node scripts/photoreal_shots.mjs [outDir] [fixture=stress.traj] [base]
 *   node scripts/photoreal_shots.mjs --final     # writes ../results/gifs/photoreal_*.png
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const final = args.includes("--final");
const positional = args.filter((a) => !a.startsWith("--"));
const outDir = positional[0] ?? (final ? "../results/gifs" : ".visual/shots");
const fixture = positional[1] ?? "stress.traj";
const base = positional[2] ?? "http://localhost:3199";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    "--headless=new",
    "--use-angle=d3d11",
    "--enable-gpu",
    // Uncapped, so the FPS number is real headroom rather than the 60 Hz vsync
    // ceiling that visual_check.mjs (the gate) measures.
    "--disable-gpu-vsync",
    "--disable-frame-rate-limit",
    "--window-size=1680,980",
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
const logs = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
  const t = m.text();
  if (t.startsWith("[trafficlab]")) logs.push(t);
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Load grid2x2 demo" }).waitFor({ timeout: 30000 });
await page
  .locator('input[type="file"]')
  .first()
  .setInputFiles(join(process.cwd(), "public", "fixtures", fixture));
await page.waitForTimeout(2600);

// Park mid-episode so queues and platoons are on screen.
await page.evaluate(() => {
  const slider = document.querySelector('input[type="range"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(slider, String(Number(slider.max) * 0.55));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(1200);

const bounds = await page.evaluate(() => {
  const v = window.trafficlabViz.getView(0);
  return { ...v.bounds };
});

const fpsProbe = () =>
  page.evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
          else res(n / 3);
        };
        requestAnimationFrame(tick);
      }),
  );

const stats = () => page.evaluate(() => window.trafficlabViz.renderStats());
const setTheme = (theme) =>
  page.evaluate((t) => window.trafficlabViz.setTheme(t), theme).then(() => page.waitForTimeout(900));

/** Orbit pose from a target, a distance and an elevation angle (deg). */
async function frame(target, dist, elevation, azimuth = 40) {
  const el = (elevation * Math.PI) / 180;
  const az = (azimuth * Math.PI) / 180;
  await page.evaluate(
    ([t, p]) => window.trafficlabViz.setCameraPose(t, p),
    [
      target,
      {
        x: target.x + Math.cos(el) * Math.cos(az) * dist,
        y: Math.sin(el) * dist,
        z: target.z + Math.cos(el) * Math.sin(az) * dist,
      },
    ],
  );
  await page.waitForTimeout(650);
}

const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, name + ".png") });
  console.log("shot:", name);
};

const center = { x: bounds.centerX, z: -bounds.centerY };
const results = {};

for (const theme of ["day", "night"]) {
  await setTheme(theme);

  // 1. Overview — the whole network from a low-ish sun angle.
  await frame(center, bounds.extent * 0.95, 20);
  await shot(final ? `photoreal_${theme}` : `${theme}_1_overview`);

  // 2. Mid — one district, buildings and trees at readable scale.
  await frame({ x: bounds.minX + bounds.extent * 0.3, z: -(bounds.minY + bounds.extent * 0.3) }, 190, 22);
  await shot(final ? `photoreal_${theme}_mid` : `${theme}_2_mid`);

  // 3. Closeup — follow a car; this is where scale mistakes show.
  const followed = await page.evaluate(() => {
    const viz = window.trafficlabViz;
    const view = viz.getView(0);
    // Pick a moving vehicle near the middle of the network.
    const pose = { x: 0, y: 0, heading: 0, speed: 0 };
    for (let id = 1; id < 4000; id++) {
      if (view.getVehiclePose(id, pose) && pose.speed > 3) {
        viz.beginFollow(0, id);
        return id;
      }
    }
    return null;
  });
  await page.waitForTimeout(900);
  if (followed === null) console.log("closeup: no moving vehicle found, using a static pose");
  await shot(
    final
      ? theme === "day"
        ? "photoreal_closeup"
        : "photoreal_closeup_night"
      : `${theme}_3_closeup`,
  );

  // Perf gate: every overlay on, playing, at the default framing.
  await page.evaluate(() => window.trafficlabViz.exitFollow());
  await frame(center, bounds.extent * 0.95, 30);
  await page.evaluate(() =>
    window.trafficlabViz.setToggles({
      queues: true,
      timers: true,
      speedColor: true,
      ribbons: true,
      ribbonsAll: true,
      pressure: true,
    }),
  );
  await page.evaluate(() => window.trafficlabViz.setPlaying(true));
  await page.waitForTimeout(1400);
  const fps = await fpsProbe();
  const s = await stats();
  results[theme] = { fps, ...s };
  await shot(final ? `photoreal_${theme}_overlays` : `${theme}_4_overlays`);
  await page.evaluate(() =>
    window.trafficlabViz.setToggles({
      queues: false,
      timers: false,
      speedColor: false,
      ribbons: false,
      ribbonsAll: false,
      pressure: false,
    }),
  );
}

const load = await page.evaluate(() => ({
  ms: window.trafficlabViz.assetLoadMs,
  bytes: window.trafficlabViz.assetBytes,
}));

console.log("--- results ---");
console.log(`fixture: ${fixture}`);
console.log(`assets: ${load.ms.toFixed(0)} ms, ${(load.bytes / 1024).toFixed(0)} KB transferred`);
for (const [theme, r] of Object.entries(results)) {
  console.log(
    `${theme.padEnd(6)} fps ${r.fps.toFixed(1).padStart(5)} (all overlays)   ` +
      `draw calls ${String(r.calls).padStart(4)}   triangles ${r.triangles.toLocaleString()}`,
  );
}
for (const line of logs) console.log(line);
console.log("console errors:", errors.length ? errors.slice(0, 8) : "none");
await browser.close();
const failed =
  Object.values(results).some((r) => r.fps < 55 || r.calls > 120) || load.ms > 3000;
process.exit(failed ? 1 : 0);
