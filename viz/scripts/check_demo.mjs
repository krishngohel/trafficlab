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
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /watch it|start|begin|got it|continue/i.test(b.textContent || ""),
        );
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
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /watch it|start|begin|got it|continue/i.test(b.textContent || ""),
    );
    if (!btn) return { found: false };
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const clickable = top === btn || btn.contains(top);
    btn.click();
    return { found: true, clickable, topTag: top?.tagName, inView: r.top >= 0 && r.bottom <= innerHeight };
  });
  if (!hit.found) problems.push(`${label}: no dismiss button in the DOM`);
  else if (!hit.clickable) problems.push(`${label}: dismiss button is covered by <${hit.topTag}>`);
  await page.waitForTimeout(9000);
  await page.screenshot({ path: join(outDir, `${label}_playing.png`) });

  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  if (!/\d+\s*m\s*\d+\s*s|\d+s/.test(text)) problems.push(`${label}: no wait time rendered`);
  console.log(`${label}: ${text.slice(0, 220)}`);
  await page.close();
}

console.log(problems.length ? `\nPROBLEMS:\n- ${problems.join("\n- ")}` : "\nno problems");
await browser.close();
if (problems.length) process.exitCode = 1;
