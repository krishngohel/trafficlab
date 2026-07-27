/* Probe: count frames actually delivered by canvas.captureStream() in single
 * vs compare mode, independent of MediaRecorder. */
import { chromium } from "playwright";
import { join } from "node:path";

const base = "http://localhost:3199";
const fix = (f) => join(process.cwd(), "public", "fixtures", f);
const a = process.argv[2] ?? "synthetic.traj";
const b = process.argv[3] ?? "grid2x2_demo.traj";

const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu",
         "--autoplay-policy=no-user-gesture-required", "--window-size=1680,980"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));

const countFrames = async (label) => {
  const r = await page.evaluate(async () => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { err: "no canvas" };
    const stream = canvas.captureStream(60);
    const track = stream.getVideoTracks()[0];
    let n = 0;
    let first = null;
    const t0 = performance.now();
    if (typeof MediaStreamTrackProcessor === "undefined") return { err: "no MSTP" };
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const done = new Promise((res) => setTimeout(res, 3000));
    const pump = async () => {
      while (performance.now() - t0 < 3000) {
        const { value, done: d } = await reader.read();
        if (d) break;
        if (first === null) first = performance.now() - t0;
        n++;
        value.close();
      }
    };
    pump();
    await done;
    try { reader.cancel(); } catch {}
    track.stop();
    return { frames: n, firstMs: first, state: track.readyState };
  });
  console.log(label, JSON.stringify(r));
};

await page.goto(base, { waitUntil: "networkidle" });
await page.locator('input[type="file"]').first().setInputFiles(fix(a));
await page.waitForTimeout(2500);
await countFrames("SINGLE  ");
await countFrames("SINGLE2 ");
await page.locator('input[type="file"]').nth(1).setInputFiles(fix(b));
await page.waitForTimeout(2000);
await countFrames("COMPARE ");
await countFrames("COMPARE2");
// back to single
await page.getByRole("button", { name: /Compare/ }).click();
await page.waitForTimeout(1200);
await countFrames("SINGLE3 ");
await browser.close();
