# trafficlab viz

WebGL visualizer for trafficlab `.traj` replay files (Next.js + TypeScript + three.js).

## Run

```bash
npm install
npm run dev -- -p 3199   # http://localhost:3199 (project convention; the headless
                         # scripts below default to this port)
npm test                 # vitest: 95 specs — parser, metrics scan, series/ramps,
                         # playback, camera math, mean-wait stats, car geometry +
                         # instance picking, scenery scatter
npm run lint             # eslint
npm run build            # production build
```

Open the page, then drag-and-drop a `.traj` file anywhere on the window or click one of the
two demo buttons (`public/fixtures/synthetic.traj`, `public/fixtures/grid2x2_demo.traj`).
Other checked-in fixtures — `grid2x2_fixed.traj`, `pair_fixed.traj`, `pair_dqn.traj` (a
same-seed compare pair), and `stress.traj` (perf/regression case) — load by drag-and-drop
or through the **Load…** / **Compare…** buttons.

Once a file is loaded the top toolbar exposes **Load…**, **Compare…** (or **✕ Compare**),
**⏺ Export**, **Charts**, and **Panel**.

## Features

- **Playback** — play/pause (space), 0.25x-8x speed (1x = real time), scrub slider,
  single-frame steps (`◀`/`▶` buttons, `,` / `.` keys), `mm:ss` + frame readout, and a
  signal-phase strip under the slider showing green/yellow/red segments over the whole
  file for a selectable intersection (precomputed by the metrics scan; click to seek).
- **Cameras** — Orbit (`1`), Top-down (`2`, orthographic fitted to the network, rotation
  locked, pan + zoom only), and Follow: click a vehicle to chase it (smoothed target,
  orbit offset preserved while following, highlight ring). `Esc` or despawn exits.
- **Scene** — vehicles are a ~176-triangle low-poly car (tapered body, raked glasshouse,
  darkened rocker, four wheels) drawn as one InstancedMesh; window glass, tyres and the
  roof highlight are baked into a vertex-colour *multiplier* so they survive per-instance
  body colouring without a second material. Instanced low-poly street trees and building
  masses fill the blocks between roads, placed by a seeded scatter (see `scatter.ts`) that
  rejects anything within 14 m of a lane or intersection — two extra static draw calls.
- **Mean wait** — a stat chip reads `cumulative_delay / (throughput + active_vehicles)` at
  the playhead, with its change over the trailing 60 s of sim time (green falling, red
  rising). In compare mode each side gets a chip plus a `B vs A` percentage chip on the
  divider. Updates at 4 Hz and follows the scrubber.
- **Overlays** (side panel, each independently toggleable, all reading the current
  interpolated frame): queue heatmap quads that grow upstream from each stop line with
  count labels, per-intersection phase-timer billboards (canvas text, ≤4 Hz redraw),
  vehicle velocity coloring (red = stopped, white = half limit, blue = at speed limit,
  normalized per-lane), fading 15 s trajectory ribbons (selected vehicle or all, capped
  at 200, fed from frames already decoded during playback), and a pressure field —
  translucent per-intersection discs on a symmetric reward scale (blue positive reward /
  red negative, radius pulsing with magnitude).
- **Charts** — collapsible bottom panel with three synced canvas charts (no chart
  library): cumulative delay, throughput, and per-intersection reward (distinct hue per
  intersection + legend) over sim time, min-max downsampled to ~2 points per CSS pixel,
  crisp at devicePixelRatio up to 2, playhead line synced to playback; click/drag any
  chart to seek.
- **Compare** — load a second `.traj` (Compare… button or drop on the right 40% of the
  window). Left/right split with a draggable divider, one shared clock and camera pose,
  per-side policy chips with live delay/throughput, charts overlay both sides (A solid,
  B dashed), and non-blocking warnings when seeds or networks differ.
- **Video export** — records the canvas (single or split view) via
  `canvas.captureStream(60)` + MediaRecorder (VP9, falling back to VP8, then plain webm)
  honoring the current camera/overlays; choose range (full file or current position → end)
  and recording speed, then it auto-plays that range and downloads
  `<policy>_<network>.webm`, restoring the prior playback state afterwards. While
  recording, a REC badge offers **Stop & save** / **Discard** and the rest of the UI is
  disabled so the capture stays clean.

## Headless scripts

Both drive a real browser against a **running dev server** (default
`http://localhost:3199`, override with the last arg / `--base`) — start `npm run dev`
first; they never boot their own server.

```bash
node scripts/visual_check.mjs <outDir> [fixture=stress.traj] [base]
# loads a fixture, exercises overlays/cameras/scrub, measures render FPS,
# writes numbered screenshots to <outDir> and reports console/page errors

node scripts/export_gif.mjs --a <traj> [--b <traj>] [--seek 0.45] [--speed 4] \
                           [--secs 12] [--out name.gif] [--base <url>]
# drives the app's own Export dialog, then ffmpeg two-pass palettes the webm
# into ../results/gifs/<name>.gif (needs ffmpeg on PATH)

node scripts/follow_probe.mjs [base]
# click-to-follow regression: clicks a grid over the road area until a car is
# picked, checks the side-panel hint, that Esc releases, and that the camera
# actually tracks a moving vehicle during playback. Exits non-zero on failure.

node scripts/closeups.mjs [outDir=../results/gifs] [base]
# review stills: follow-cam closeup of the car model in the scenery, and the
# mean-wait HUD in single + compare mode
```

`follow_probe.mjs` and `closeups.mjs` read live state through `window.trafficlabViz`
(`followedId`, `cameraMode`, `cameraPose()`, `getView()`), a handle the engine publishes
purely for these drivers — nothing in the app reads it.

## Architecture

The app is split into a pure parsing/series layer, a three.js layer, and a thin React
shell — three.js objects never enter React state.

- `src/lib/traj.ts` — the `.traj` binary contract (see `docs/TRAJECTORY_FORMAT.md` at the
  repo root). Header/meta/trailer/index parse eagerly; frames decode lazily behind an LRU
  cache (120 frames) so scrubbing large files stays O(1) per seek. `scanMeta()` makes one
  extra pass decoding **only** tick + signals + queues + rewards + metrics of every frame
  (vehicle blocks are skipped by seeking), returning frame-major typed-array series —
  thousands of frames scan in a few milliseconds; the result is cached on the file.
- `src/lib/series.ts` / `src/lib/ramps.ts` / `src/lib/wait.ts` — pure helpers: column
  extraction, min-max downsampling for the charts, phase-strip segmentation, time
  formatting, the color ramps used by overlays, and the mean-wait / trailing-trend math
  behind the HUD chips. Fully unit tested.
- `src/lib/scene/` — three.js layers that know nothing about React: `buildRoads` (static
  geometry), `carModel` (the shared low-poly car BufferGeometry), `VehicleLayer` (one
  InstancedMesh for all cars, id- or speed-based instance colors, pose queries for
  picking/following with persistent id→index maps, and an instance bounding sphere kept
  in step with the instances so raycast picking keeps working), `scatter` + `environment`
  (seeded scenery placement and its two instanced meshes), `SignalLayer`, and `overlays/`
  (queue heatmap, phase timers, pressure discs, trajectory ribbons, shared canvas-texture
  text sprites). Overlays skip all work while hidden and reuse scratch objects — no
  per-frame allocations in hot loops.
- `src/lib/viz/` — the runtime: `PlaybackClock` (time-based shared clock; comparison
  files with different lengths/dt stay in sync), `CameraRig` (orbit/top-down/follow, one
  pose applied to every viewport), `SceneView` (one loaded replay: scene + layers +
  overlays), `CanvasRecorder` (webm capture), and `VizEngine` — the orchestrator that
  owns the renderer, render loop, split-screen scissored rendering, raycast picking, and
  recording. React talks to the engine through methods and an `afterFrame` hook.
- `src/components/` — `Viewer.tsx` (orchestrator: engine lifecycle, UI state, keyboard,
  drag-and-drop), `ControlBar` + `PhaseStrip`, `SidePanel`, `ChartsPanel`,
  `CompareOverlay` (chips + divider), `WaitHud` (mean-wait chips), `ExportDialog`,
  `Toasts`. HUD-frequency values
  (readouts, chip stats, playheads) are written straight to the DOM/canvas from
  `afterFrame` — React re-renders only on real UI interactions.

Sim coordinates (X east, Y north) map to the scene as (x, -z); headings rotate about +Y.
three.js stays client-only via a `dynamic(..., { ssr: false })` import in a client
component.
