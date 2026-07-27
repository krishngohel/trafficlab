/* Diagnostic: instrument MediaRecorder + anchor clicks to see why the
 * single-view export never fires a download. */
import { chromium } from "playwright";
import { join, isAbsolute } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const fileA = arg("a", "stress.traj");
const fileB = arg("b", null);
const seek = parseFloat(arg("seek", "0.5"));
const speed = arg("speed", "8");
const secs = parseFloat(arg("secs", "12"));
const base = arg("base", "http://localhost:3199");
const vizDir = "C:/Users/awsom/Documents/projects/trafficlab/viz";
const fix = (f) => (isAbsolute(f) ? f : join(vizDir, "public", "fixtures", f));

const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu",
         "--autoplay-policy=no-user-gesture-required", "--window-size=1680,980"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
page.on("console", (m) => console.log(`console[${m.type()}]:`, m.text().slice(0, 300)));
page.on("download", (d) => console.log("DOWNLOAD EVENT:", d.suggestedFilename()));

await page.addInitScript(() => {
  const OrigMR = window.MediaRecorder;
  window.__mrLog = [];
  const log = (...a) => { window.__mrLog.push(a.join(" ")); console.log("[MR]", ...a); };
  window.MediaRecorder = class extends OrigMR {
    constructor(stream, opts) {
      super(stream, opts);
      const tracks = stream.getTracks();
      log("ctor mime=", opts?.mimeType, "tracks=", tracks.length,
          "kind=", tracks.map((t) => `${t.kind}:${t.readyState}:${t.enabled}`).join(","));
      this.addEventListener("start", () => log("event start, state=", this.state));
      this.addEventListener("dataavailable", (e) => log("event dataavailable size=", e.data.size));
      this.addEventListener("stop", () => log("event stop"));
      this.addEventListener("error", (e) => log("event error", String(e?.error ?? e)));
    }
    start(...a) { log("start() called", JSON.stringify(a)); return super.start(...a); }
    stop(...a) { log("stop() called, state=", this.state); return super.stop(...a); }
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...a) {
    log("anchor.click download=", this.download, "href=", String(this.href).slice(0, 60),
        "connected=", this.isConnected);
    return origClick.apply(this, a);
  };
  const origCS = HTMLCanvasElement.prototype.captureStream;
  HTMLCanvasElement.prototype.captureStream = function (...a) {
    const s = origCS.apply(this, a);
    log("captureStream fps=", a[0], "canvas=", this.width + "x" + this.height,
        "tracks=", s.getTracks().length);
    return s;
  };
});

await page.goto(base, { waitUntil: "networkidle" });
await page.locator('input[type="file"]').first().setInputFiles(fix(fileA));
await page.waitForTimeout(2500);
if (fileB) {
  await page.locator('input[type="file"]').nth(1).setInputFiles(fix(fileB));
  await page.waitForTimeout(1500);
}
await page.evaluate((frac) => {
  const slider = document.querySelector('input[type="range"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(slider, String(Number(slider.max) * frac));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
}, seek);
await page.waitForTimeout(600);
console.log("counter before export:", await page.locator('[class*="counter"]').first().textContent());

await page.getByRole("button", { name: /export/i }).click();
await page.getByText("Export video (.webm)").waitFor({ timeout: 5000 });
await page.getByText("Current position").click();
await page.locator('[class*="dialog"] select').selectOption(String(speed));
await page.getByRole("button", { name: /start recording/i }).click();
console.log("recording...");
for (let i = 0; i < secs; i += 3) {
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => ({
    counter: document.querySelector('[class*="counter"]')?.textContent,
    rec: !!document.querySelector('[class*="recIndicator"]'),
  }));
  console.log(`t+${i + 3}s`, JSON.stringify(st));
}
const stopped = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /stop/i.test(b.textContent || ""));
  if (btn) { btn.click(); return (btn.textContent || "").trim(); }
  return null;
});
console.log("stop button:", stopped);
await page.waitForTimeout(4000);
console.log("MR LOG:\n" + (await page.evaluate(() => window.__mrLog.join("\n"))));
await browser.close();
