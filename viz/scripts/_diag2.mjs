/* Diagnostic 2: watch engine internals + rAF rate + capture-stream frames
 * during a single-view recording. */
import { chromium } from "playwright";
import { join } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const fileA = arg("a", "synthetic.traj");
const seek = parseFloat(arg("seek", "0.3"));
const speed = arg("speed", "4");
const secs = parseFloat(arg("secs", "8"));
const base = "http://localhost:3199";
const fix = (f) => join(process.cwd(), "public", "fixtures", f);

const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu",
         "--autoplay-policy=no-user-gesture-required", "--window-size=1680,980"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
page.on("console", (m) => console.log(`console[${m.type()}]:`, m.text().slice(0, 200)));
page.on("download", (d) => console.log("DOWNLOAD EVENT:", d.suggestedFilename()));

await page.addInitScript(() => {
  const OrigMR = window.MediaRecorder;
  window.MediaRecorder = class extends OrigMR {
    constructor(stream, opts) {
      super(stream, opts);
      window.__mrStream = stream;
      this.addEventListener("start", () => console.log("[MR] start evt"));
      this.addEventListener("dataavailable", (e) => console.log("[MR] data", e.data.size));
      this.addEventListener("stop", () => console.log("[MR] stop evt"));
    }
  };
});

await page.goto(base, { waitUntil: "networkidle" });
await page.locator('input[type="file"]').first().setInputFiles(fix(fileA));
await page.waitForTimeout(2500);
await page.evaluate((frac) => {
  const slider = document.querySelector('input[type="range"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(slider, String(Number(slider.max) * frac));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
}, seek);
await page.waitForTimeout(400);

// Install a frame counter on the engine.
await page.evaluate(() => {
  window.__frames = 0;
  window.__engine.afterFrame.add(() => { window.__frames++; });
});

const state = () => page.evaluate(() => {
  const e = window.__engine;
  const tr = window.__mrStream?.getVideoTracks?.()[0];
  return {
    t: +e.clock.time.toFixed(2), playing: e.clock.playing, spd: e.clock.speed,
    scrub: e.scrubbing, rec: e.isRecording, frames: window.__frames,
    track: tr ? `${tr.readyState}/${tr.enabled}/${tr.muted}` : "none",
    rf: window.__rf || 0,
    fps: tr ? tr.getSettings().frameRate : null,
  };
});
console.log("pre-export:", JSON.stringify(await state()));

await page.getByRole("button", { name: /export/i }).click();
await page.getByText("Export video (.webm)").waitFor({ timeout: 5000 });
await page.getByText("Current position").click();
await page.locator('[class*="dialog"] select').selectOption(String(speed));
await page.getByRole("button", { name: /start recording/i }).click();
for (let i = 0; i < secs; i += 2) {
  await page.waitForTimeout(2000);
  console.log(`t+${i + 2}s`, JSON.stringify(await state()));
}
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /stop/i.test(b.textContent || ""));
  btn?.click();
});
await page.waitForTimeout(3000);
console.log("post-stop:", JSON.stringify(await state()));
await browser.close();
