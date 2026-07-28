/* Confirms the FPS chip reports a live, plausible rate and toggles with "f". */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? ".visual/fps";
const fixture = process.argv[3] ?? "stress.traj";
const base = process.argv[4] ?? "http://localhost:3199";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu", "--window-size=1680,980"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(base, { waitUntil: "networkidle" });
await page.locator('input[type="file"]').first()
  .setInputFiles(join(process.cwd(), "public", "fixtures", fixture));
await page.waitForTimeout(3500);

const chip = page.locator('div[title*="frame rate"]');
const read = async () => (await chip.innerText()).replace(/\s+/g, " ").trim();

console.log("chip:", await read());
await page.waitForTimeout(1500);
const second = await read();
console.log("chip 1.5s later:", second);
await page.screenshot({ path: join(outDir, "fps_hud.png") });

const fps = Number(second.match(/(\d+) fps/)?.[1] ?? 0);
const draws = Number(second.match(/(\d+) draws/)?.[1] ?? 0);
console.log(`parsed: fps=${fps} draws=${draws}`);
if (!(fps > 10 && fps < 400)) throw new Error(`implausible fps: ${fps}`);
if (!(draws > 0)) throw new Error("draw calls never populated");

// "f" hides it, "f" again brings it back.
await page.keyboard.press("f");
await page.waitForTimeout(400);
const hidden = await chip.count();
await page.keyboard.press("f");
await page.waitForTimeout(400);
const back = await chip.count();
console.log(`toggle: visible=1 -> hidden=${hidden} -> visible=${back}`);
if (hidden !== 0 || back !== 1) throw new Error("f toggle did not work");

console.log("console errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
