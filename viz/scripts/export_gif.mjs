/* Drive the app's own video export and convert to GIF for the README.
 *
 *   node scripts/export_gif.mjs --a <traj> [--b <traj>] [--seek 0.45]
 *        [--speed 4] [--secs 12] [--out name.gif] [--base http://localhost:3199]
 *
 * Files are paths relative to viz/public/fixtures or absolute. Uses the app's
 * Export dialog (current position -> end at the chosen speed), records `secs`
 * seconds of wall-clock video, then ffmpeg palettes it into a crisp GIF.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const fileA = arg("a", "grid2x2_demo.traj");
const fileB = arg("b", null);
const seek = parseFloat(arg("seek", "0.45"));
const speed = arg("speed", "4");
const secs = parseFloat(arg("secs", "12"));
const outGif = arg("out", "export.gif");
const base = arg("base", "http://localhost:3199");
const outDir = resolve("..", "results", "gifs");
mkdirSync(outDir, { recursive: true });

const fix = (f) => (isAbsolute(f) ? f : join(process.cwd(), "public", "fixtures", f));

const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu",
         "--autoplay-policy=no-user-gesture-required", "--window-size=1680,980"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));

await page.goto(base, { waitUntil: "networkidle" });
await page.locator('input[type="file"]').first().setInputFiles(fix(fileA));
await page.waitForTimeout(2000);
if (fileB) {
  await page.locator('input[type="file"]').nth(1).setInputFiles(fix(fileB));
  await page.waitForTimeout(1500);
}
// Seek.
await page.evaluate((frac) => {
  const slider = document.querySelector('input[type="range"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(slider, String(Math.round(Number(slider.max) * frac)));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
}, seek);
await page.waitForTimeout(600);

// Export dialog: "Current position -> end" radio, speed select, start.
await page.getByRole("button", { name: /export/i }).click();
await page.getByText("Export video (.webm)").waitFor({ timeout: 5000 });
await page.getByText("Current position").click();
await page.locator('[class*="dialog"] select').selectOption(String(speed));
const downloadP = page.waitForEvent("download", { timeout: (secs + 60) * 1000 });
await page.getByRole("button", { name: /start recording/i }).click();
console.log(`recording ~${secs}s of wall-clock...`);
await page.waitForTimeout(secs * 1000);
// Stop early via the recording indicator if present; else it runs to range end.
await page.getByRole("button", { name: /stop/i }).first().click().catch(() => {});
const download = await downloadP;
const webm = join(outDir, outGif.replace(/\.gif$/, ".webm"));
await download.saveAs(webm);
console.log("webm:", webm);
await browser.close();

// Two-pass palette GIF: 720px wide, 18 fps.
const gif = join(outDir, outGif);
const palette = join(outDir, "palette.png");
execFileSync("ffmpeg", ["-y", "-i", webm, "-vf", "fps=18,scale=720:-1:flags=lanczos,palettegen=stats_mode=diff", palette]);
execFileSync("ffmpeg", ["-y", "-i", webm, "-i", palette, "-lavfi",
  "fps=18,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4", gif]);
console.log("gif:", gif, existsSync(gif) ? "OK" : "MISSING");
