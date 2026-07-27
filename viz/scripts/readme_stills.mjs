/* Capture README stills from the live viewer (headless, same rig as
 * visual_check.mjs). Writes PNGs into ../results/gifs.
 *
 *   node scripts/readme_stills.mjs [--only charts|follow] [--base http://localhost:3199]
 *
 * charts_panel.png  grid2x2_demo.traj, charts panel open, playhead mid-file.
 * follow_cam.png    stress.traj, chase camera locked to a vehicle, ribbon on.
 *                   Follow needs a vehicle under the cursor, so the script
 *                   sweeps click points until the panel reports a lock, then
 *                   plays on and writes candidate frames for a human to pick.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg("base", "http://localhost:3199");
const only = arg("only", "all");
const outDir = resolve("..", "results", "gifs");
const candDir = join(outDir, "_cand");
mkdirSync(candDir, { recursive: true });

const fix = (f) => join(process.cwd(), "public", "fixtures", f);

const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu",
         "--enable-unsafe-swiftshader", "--window-size=1680,980"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 940 } });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") console.log("console error:", m.text().slice(0, 200)); });

const load = async (fixture) => {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.locator('input[type="file"]').first().setInputFiles(fix(fixture));
  await page.waitForTimeout(2500);
};

/** Drive the React-controlled range input to `frac` of the file. */
const seek = async (frac) => {
  await page.evaluate((f) => {
    const slider = document.querySelector('input[type="range"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(slider, String(Math.round(Number(slider.max) * f)));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  }, frac);
  await page.waitForTimeout(700);
};

const overlay = async (label) => {
  await page.getByText(label, { exact: false }).first().click();
  await page.waitForTimeout(400);
};

/** The play/pause button swaps its glyph, so drive it by title instead. */
const setPlaying = async (want) => {
  await page.evaluate((w) => {
    const btn = document.querySelector('button[title^="Pause"], button[title^="Play"]');
    if (!btn) return;
    const isPlaying = btn.title.startsWith("Pause");
    if (isPlaying !== w) btn.click();
  }, want);
  await page.waitForTimeout(250);
};

// --- charts_panel.png ---------------------------------------------------------
if (only === "all" || only === "charts") {
  const cam = arg("cam", "orbit");
  const zoom = parseFloat(arg("zoom", "0"));
  const dragY = parseFloat(arg("dragy", "0"));
  const name = arg("name", "charts_panel.png");
  await load("grid2x2_demo.traj");
  await overlay("Queue heatmap");
  await overlay("Signal phase timers");
  await page.getByRole("button", { name: "Charts", exact: true }).click();
  await page.waitForTimeout(500);
  if (cam === "top") {
    await page.getByRole("button", { name: "Top-down" }).click();
    await page.waitForTimeout(500);
  }
  if (dragY !== 0) {
    await page.mouse.move(840, 380);
    await page.mouse.down();
    await page.mouse.move(840, 380 + dragY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  if (zoom !== 0) {
    for (let i = 0; i < Math.abs(zoom); i++) {
      await page.mouse.move(840, 400);
      await page.mouse.wheel(0, zoom > 0 ? -120 : 120);
      await page.waitForTimeout(120);
    }
  }
  const panY = parseFloat(arg("pany", "0"));
  if (panY !== 0) {
    // Right button pans in orbit mode; nudges the network clear of the panels.
    await page.mouse.move(840, 420);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(840, 420 + panY, { steps: 12 });
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(400);
  }
  await seek(0.52);
  await setPlaying(false);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(name.startsWith("_") ? candDir : outDir, name) });
  console.log("wrote", name);
}

// --- follow_cam.png -----------------------------------------------------------
if (only === "all" || only === "follow") {
  await load("stress.traj");
  await overlay("Trajectory ribbon (selected)");
  await seek(parseFloat(arg("seek", "0.45")));
  await setPlaying(false);
  await page.waitForTimeout(500);

  const followedId = () => page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => d.children.length === 0 && /Following vehicle #/.test(d.textContent || ""));
    return el ? el.textContent.trim() : null;
  });

  // Sweep the middle of the canvas for a pickable vehicle.
  let locked = null;
  outer: for (let gy = 0.22; gy <= 0.74 && !locked; gy += 0.035) {
    for (let gx = 0.14; gx <= 0.82; gx += 0.02) {
      await page.mouse.click(1680 * gx, 940 * gy);
      await page.waitForTimeout(45);
      locked = await followedId();
      if (locked) break outer;
    }
  }
  console.log("follow lock:", locked ?? "NONE");
  if (!locked) throw new Error("could not lock the follow camera onto a vehicle");

  // Let it drive so the chase cam settles and the ribbon grows a tail, saving
  // candidates to choose from (a good still has the car inside a junction).
  const camLift = parseFloat(arg("lift", "0"));
  if (camLift !== 0) {
    await page.mouse.move(700, 470);
    await page.mouse.down();
    await page.mouse.move(700, 470 + camLift, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  await setPlaying(true);
  const n = parseInt(arg("frames", "10"), 10);
  const gap = parseFloat(arg("gap", "1400"));
  for (let i = 0; i < n; i++) {
    await page.waitForTimeout(gap);
    const still = await followedId();
    if (!still) { console.log("lost follow at candidate", i); break; }
    await page.screenshot({ path: join(candDir, `follow_${String(i).padStart(2, "0")}.png`) });
  }
  console.log("wrote", n, "follow candidates to", candDir);
}

await browser.close();
