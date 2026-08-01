/* Build the statically-exported public site.
 *
 *   node scripts/build_web.mjs
 *
 * `public/fixtures/` holds ~267 MB of recordings used by the research tool and
 * the headless checks. Only the two the public demo actually plays belong on a
 * web host, so the export is pruned afterwards. Everything else about the build
 * is stock Next.js.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fixtures the public build ships: the four the guided demo plays (one
 * junction under both lights, then a hundred junctions under both lights),
 * plus the three the research tool's own demo buttons offer. Anything
 * referenced by a shipped button has to be here or that button 404s in
 * production. `metro.traj` is the research tool's button, not the demo's.
 */
const KEEP = new Set([
  "demo_fixed.traj",
  "demo_actuated.traj",
  "metro_fixed.traj",
  "metro_actuated.traj",
  "city.traj",
  "metro.traj",
  "single_actuated.traj",
]);

// `shell: true` is required on Windows, where npx resolves to a .cmd shim that
// execFileSync cannot spawn directly.
execFileSync("npx", ["next", "build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, TRAFFICLAB_STATIC: "1" },
});

const fixtures = join("out", "fixtures");
let dropped = 0;
let droppedBytes = 0;
for (const name of readdirSync(fixtures)) {
  if (KEEP.has(name)) continue;
  const p = join(fixtures, name);
  droppedBytes += statSync(p).size;
  rmSync(p, { force: true });
  dropped++;
}

// GitHub Pages runs Jekyll over an uploaded tree unless told not to, and Jekyll
// drops every path beginning with an underscore — which is all of `_next/`.
writeFileSync(join("out", ".nojekyll"), "");

// Long-lived caching for the immutable payload: fixtures and 3D assets are
// content-fixed, the HTML is not.
writeFileSync(
  join("out", "_headers"),
  [
    "/fixtures/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n"),
);

const size = (dir) => {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
};

console.log(
  `\npruned ${dropped} fixture(s), ${(droppedBytes / 1e6).toFixed(0)} MB\n` +
    `out/ is ${(size("out") / 1e6).toFixed(1)} MB`,
);
