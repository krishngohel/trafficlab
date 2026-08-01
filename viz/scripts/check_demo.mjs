/* Verify the public demo works as a STATIC build served from a subpath —
 * i.e. exactly how GitHub Pages will serve it.
 *
 *   node scripts/check_demo.mjs <url> <outDir>
 *
 * Fails loudly if any request 404s, if the scoreboard never populates, or if
 * the fixed timer is ahead at the end (which would mean the clip contradicts
 * the claim the page makes).
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const url = process.argv[2] ?? "http://localhost:3210/trafficlab/demo.html";
const outDir = process.argv[3] ?? ".visual/demo";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu"],
});

const problems = [];
for (const [label, width, height] of [["desktop", 1600, 1000], ["phone", 390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (e) => problems.push(`${label} pageerror: ${String(e).slice(0, 160)}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`${label} console: ${m.text().slice(0, 160)}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`${label} HTTP ${r.status()}: ${r.url().slice(-70)}`);
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Wait for the intro's own button to become the topmost element at its
  // centre — i.e. for any loading overlay to have cleared — rather than
  // guessing a delay.
  await page
    .waitForFunction(
      () => {
        const btn = document.querySelector('[role="dialog"] button');
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return true; // off-screen: scroll case
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top === btn || btn.contains(top);
      },
      { timeout: 20000 },
    )
    .catch(() => problems.push(`${label}: intro never became interactive`));
  await page.screenshot({ path: join(outDir, `${label}_intro.png`) });

  // Dismiss the intro. Checked the way a real cursor would land on it: is the
  // topmost element at the button's centre actually the button?
  const hit = await page.evaluate(() => {
    // Scoped to the dialog on purpose: the page behind it has a "Start over"
    // button, and a looser match would click that instead and leave the
    // overlay up for the rest of the run.
    const btn = document.querySelector('[role="dialog"] button');
    if (!btn) return { found: false };
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const clickable = top === btn || btn.contains(top);
    btn.click();
    return { found: true, clickable, topTag: top?.tagName, inView: r.top >= 0 && r.bottom <= innerHeight };
  });
  if (!hit.found) problems.push(`${label}: no dismiss button in the DOM`);
  else if (!hit.clickable) problems.push(`${label}: dismiss button is covered by <${hit.topTag}>`);
  await page.waitForTimeout(12000);
  await page.screenshot({ path: join(outDir, `${label}_playing.png`) });

  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  if (!/\d+\s*m\s*\d+\s*s|\d+s/.test(text)) problems.push(`${label}: no wait time rendered`);

  // The one thing a visitor must be able to answer in two seconds: which light
  // is faster. It has to be spelled out in words, not left as two numbers to
  // subtract, and the badge has to be on the side the numbers actually favour.
  const verdict = await page.evaluate(() => {
    const head = [...document.querySelectorAll("strong")].find((el) =>
      /winning|neck and neck|waiting for the first cars/i.test(el.textContent || ""),
    );
    const pills = [...document.querySelectorAll("span,b")].filter(
      (el) => (el.textContent || "").trim() === "Faster" && el.offsetParent !== null,
    );
    const lead = document.querySelector("[data-lead]")?.getAttribute("data-lead") ?? null;
    return { headline: head?.textContent ?? null, visibleBadges: pills.length, lead };
  });
  if (!verdict.headline) problems.push(`${label}: no verdict headline on the page`);
  if (verdict.lead !== "responsive") {
    problems.push(`${label}: banner says the leader is "${verdict.lead}", expected responsive`);
  }
  if (verdict.visibleBadges !== 2) {
    problems.push(`${label}: ${verdict.visibleBadges} "Faster" badges visible, expected 2`);
  }
  console.log(`${label}: ${verdict.headline} [lead=${verdict.lead}, badges=${verdict.visibleBadges}]`);
  console.log(`${label}: ${text.slice(0, 220)}`);

  // Part two must not cost anything until it is asked for, and must work when
  // it is. The 33 MB pair is fetched only on that click.
  const earlyCity = await page.evaluate(() =>
    performance.getEntriesByType("resource").some((r) => r.name.includes("metro_")),
  );
  if (earlyCity) problems.push(`${label}: the city files were fetched before anyone asked`);

  await page.evaluate(() => document.querySelector("#city")?.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(400);
  const asked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /load the city/i.test(b.textContent || ""),
    );
    btn?.click();
    return Boolean(btn);
  });
  if (!asked) problems.push(`${label}: no "Load the city" button`);
  else {
    await page
      .waitForFunction(() => /cars on the two maps right now/i.test(document.body.innerText), {
        timeout: 300000,
      })
      .catch(() => problems.push(`${label}: the city never finished loading`));
    await page.waitForTimeout(8000);
    await page.evaluate(() => document.querySelector("#city")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, `${label}_city.png`) });

    // The city comparison has to answer the same question the junction one
    // does, with the same words and the same badge.
    const cityVerdict = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll("[data-lead]")];
      const pills = [...document.querySelectorAll("span,b")].filter(
        (el) => (el.textContent || "").trim() === "Faster" && el.offsetParent !== null,
      );
      return { boxes: boxes.map((b) => b.getAttribute("data-lead")), badges: pills.length };
    });
    if (cityVerdict.boxes.length !== 2) {
      problems.push(`${label}: ${cityVerdict.boxes.length} verdict banners, expected 2`);
    }
    if (cityVerdict.boxes.some((b) => b !== "responsive")) {
      problems.push(`${label}: city banner leaders ${cityVerdict.boxes.join("/")}`);
    }
    if (cityVerdict.badges !== 4) {
      problems.push(`${label}: ${cityVerdict.badges} "Faster" badges once both are up, expected 4`);
    }
    const fps = await page.evaluate(() => window.trafficlabViz?.fpsMeter?.fps ?? -1);
    console.log(
      `${label}: city leaders ${cityVerdict.boxes.join("/")}, badges ${cityVerdict.badges}, ` +
        `fps ${typeof fps === "number" ? fps.toFixed(0) : fps}`,
    );

    // Street level is the view that shows a visitor what a queue actually is,
    // so it has to move the camera, not just light up a button.
    const before = await page.evaluate(() => window.trafficlabViz?.cameraPose());
    const zoomed = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => (b.textContent || "").trim() === "Street level",
      );
      btn?.click();
      return Boolean(btn);
    });
    if (!zoomed) problems.push(`${label}: no "Street level" button`);
    await page.waitForTimeout(4000);
    const after = await page.evaluate(() => window.trafficlabViz?.cameraPose());
    if (before && after && Math.abs(before.y - after.y) < 50) {
      problems.push(`${label}: street level did not move the camera`);
    }
    await page.screenshot({ path: join(outDir, `${label}_city_street.png`) });
  }

  await page.close();
}

console.log(problems.length ? `\nPROBLEMS:\n- ${problems.join("\n- ")}` : "\nno problems");
await browser.close();
if (problems.length) process.exitCode = 1;
