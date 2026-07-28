/* Final stills for review: a follow-cam closeup of the car model in the
 * environment, and the mean-wait HUD in single + compare mode.
 *
 *   node scripts/closeups.mjs [outDir=../results/gifs] [base=http://localhost:3199]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const outDir = positional[0] ?? join("..", "results", "gifs");
const base = positional[1] ?? "http://localhost:3199";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu", "--window-size=1680,980"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, name + ".png") });
  console.log("shot:", join(outDir, name + ".png"));
};

const loadFixture = async (nth, file) =>
  page.locator('input[type="file"]').nth(nth).setInputFiles(join(process.cwd(), "public", "fixtures", file));

const seekFraction = (f) =>
  page.evaluate((frac) => {
    const slider = document.querySelector('input[type="range"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(slider, String(Number(slider.max) * frac));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  }, f);

await page.goto(base, { waitUntil: "domcontentloaded" });
await loadFixture(0, "city.traj");
await page.waitForTimeout(2500);
await seekFraction(0.5);
await page.waitForTimeout(1200);

// --- follow closeup --------------------------------------------------------
let followed = null;
outer: for (let gx = 0.3; gx <= 0.72; gx += 0.04) {
  for (let gy = 0.32; gy <= 0.8; gy += 0.04) {
    await page.mouse.click(Math.round(1600 * gx), Math.round(900 * gy), { delay: 25 });
    await page.waitForTimeout(60);
    const id = await page.evaluate(() => window.trafficlabViz?.followedId ?? null);
    if (id !== null) {
      followed = id;
      break outer;
    }
  }
}
console.log("following vehicle:", followed);
if (followed !== null) {
  // Dolly in a little and let the chase settle so the model fills the frame.
  for (let i = 0; i < 7; i++) {
    await page.mouse.move(800, 450);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(120);
  }
  // Wait for the car to be rolling mid-block: stopped at a stop line the frame
  // is all signal heads, which says nothing about the car model.
  for (let i = 0; i < 40; i++) {
    const speed = await page.evaluate(() => {
      const e = window.trafficlabViz;
      const id = e?.followedId ?? null;
      const pose = { x: 0, y: 0, heading: 0, speed: 0 };
      if (id === null || !e.getView(0)?.getVehiclePose(id, pose)) return -1;
      return pose.speed;
    });
    if (speed > 7) break;
    if (speed < 0) break; // despawned
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);
  await shot("follow_closeup");
}

// --- HUD, single view ------------------------------------------------------
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
await shot("hud_single");

// --- HUD, compare ----------------------------------------------------------
await page.goto(base, { waitUntil: "domcontentloaded" });
await loadFixture(0, "single_fixed.traj");
await page.waitForTimeout(2500);
await loadFixture(1, "single_actuated.traj");
await page.waitForTimeout(2000);
await seekFraction(0.62);
await page.waitForTimeout(1600);
await shot("hud_compare");

console.log("console errors:", errors.length ? errors.slice(0, 8) : "none");
await browser.close();
