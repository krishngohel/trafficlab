/* Click-to-follow regression probe.
 *
 * Loads the grid2x2 demo, pauses mid-file, clicks a grid of points over the
 * vehicle-dense roads and checks that
 *   1. a click on a car enters follow mode (engine state AND the side-panel hint),
 *   2. Esc leaves follow mode,
 *   3. while following a moving car during playback the camera actually tracks
 *      it — the camera position changes frame to frame and stays near the car.
 *
 *   node scripts/follow_probe.mjs [base=http://localhost:3199]
 */
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3199";
const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu", "--window-size=1680,980"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("console.error:", m.text().slice(0, 200));
});

const fail = (msg) => {
  console.log("FAIL:", msg);
  failures++;
};
let failures = 0;

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Load city demo" }).click();
await page.waitForTimeout(2500);
// Seek mid-file so plenty of vehicles are on screen, then pause via Space.
await page.evaluate(() => {
  const slider = document.querySelector('input[type="range"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(slider, String(Math.round(Number(slider.max) * 0.5)));
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(400);
await page.keyboard.press("Space");
await page.waitForTimeout(400);

/** Engine-side follow state plus the visible side-panel hint. */
const state = () =>
  page.evaluate(() => ({
    id: window.trafficlabViz?.followedId ?? null,
    hint: document.querySelector("[data-follow-hint]")?.textContent ?? "hint missing",
    mode: window.trafficlabViz?.cameraMode ?? "?",
  }));

console.log("before:", JSON.stringify(await state()));

/** Click a grid over the road area until something enters follow mode. */
async function scanForCar() {
  for (let gx = 0.25; gx <= 0.75; gx += 0.05) {
    for (let gy = 0.3; gy <= 0.85; gy += 0.05) {
      const x = Math.round(1600 * gx);
      const y = Math.round(900 * gy);
      await page.mouse.click(x, y, { delay: 30 });
      await page.waitForTimeout(70);
      const s = await state();
      if (s.id !== null) return { x, y, ...s };
    }
  }
  return null;
}

// --- 1. clicking a car enters follow --------------------------------------
const hit = await scanForCar();

if (!hit) {
  console.log("PICK NEVER FIRED across the whole scan");
  await browser.close();
  process.exit(1);
}
console.log(`HIT at (${hit.x},${hit.y}): id=${hit.id} mode=${hit.mode} hint="${hit.hint}"`);
if (!hit.hint.includes(`Following vehicle #${hit.id}`)) {
  fail(`side panel hint did not report the followed vehicle: "${hit.hint}"`);
}
if (hit.mode !== "follow") fail(`camera mode is "${hit.mode}", expected "follow"`);

// --- 2. Esc exits follow ---------------------------------------------------
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
const afterEsc = await state();
console.log("after Esc:", JSON.stringify(afterEsc));
if (afterEsc.id !== null) fail(`Esc did not release the follow (id=${afterEsc.id})`);
if (afterEsc.mode !== "orbit") fail(`Esc left the camera in "${afterEsc.mode}", expected "orbit"`);
if (!afterEsc.hint.includes("Follow: click")) fail(`hint not reset: "${afterEsc.hint}"`);

// --- 3. the camera tracks a moving vehicle during playback -----------------
// Esc leaves the camera where the chase ended, so rescan from scratch.
const refollow = (await scanForCar()) ?? { id: null };
if (refollow.id === null) {
  fail("could not re-enter follow for the tracking check");
} else {
  await page.keyboard.press("Space"); // resume playback
  const samples = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(140);
    samples.push(
      await page.evaluate(() => {
        const e = window.trafficlabViz;
        const id = e?.followedId ?? null;
        const pose = { x: 0, y: 0, heading: 0, speed: 0 };
        const has = id !== null && (e.getView(0)?.getVehiclePose(id, pose) ?? false);
        return { id, cam: e.cameraPose(), veh: has ? { ...pose } : null };
      }),
    );
  }
  const tracked = samples.filter((s) => s.veh !== null);
  const camMoves = [];
  const gaps = [];
  for (let i = 1; i < tracked.length; i++) {
    const a = tracked[i - 1].cam;
    const b = tracked[i].cam;
    camMoves.push(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  for (const s of tracked) {
    gaps.push(Math.hypot(s.cam.x - s.veh.x, s.cam.y - 1, s.cam.z + s.veh.y));
  }
  const movedVehicle = tracked.some((s) => s.veh.speed > 0.5);
  const totalCam = camMoves.reduce((a, b) => a + b, 0);
  const maxGap = gaps.length ? Math.max(...gaps) : Infinity;
  console.log(
    `tracking: ${tracked.length}/${samples.length} samples with a live pose, ` +
      `camera moved ${totalCam.toFixed(1)} m total (max step ${Math.max(0, ...camMoves).toFixed(2)} m), ` +
      `max camera-to-vehicle gap ${maxGap.toFixed(1)} m, vehicle moving: ${movedVehicle}`,
  );
  if (tracked.length < 4) fail("lost the followed vehicle almost immediately");
  if (!movedVehicle) fail("the followed vehicle never moved — tracking is untested");
  else if (totalCam < 1) fail(`camera did not track: it moved only ${totalCam.toFixed(2)} m`);
  if (maxGap > 80) fail(`camera drifted ${maxGap.toFixed(1)} m from the followed vehicle`);
}

console.log(failures === 0 ? "pick works" : `${failures} check(s) failed`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
