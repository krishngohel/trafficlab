# trafficlab viz

WebGL visualizer for trafficlab `.traj` replay files (Next.js + TypeScript + three.js).

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # vitest: parser, metrics scan, series/ramps, playback, camera math
npm run build    # production build
```

Open the page, then drag-and-drop a `.traj` file anywhere on the window or load one of the
bundled demos (`public/fixtures/synthetic.traj`, `public/fixtures/grid2x2_demo.traj`).

## Features

- **Playback** — play/pause (space), 0.25x-8x speed (1x = real time), scrub slider,
  single-frame steps (`◀`/`▶` buttons, `,` / `.` keys), `mm:ss` + frame readout, and a
  signal-phase strip under the slider showing green/yellow/red segments over the whole
  file for a selectable intersection (precomputed by the metrics scan; click to seek).
- **Cameras** — Orbit (`1`), Top-down (`2`, orthographic fitted to the network, rotation
  locked, pan + zoom only), and Follow: click a vehicle to chase it (smoothed target,
  orbit offset preserved while following, highlight ring). `Esc` or despawn exits.
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
  intersection + legend) over sim time, min-max downsampled past 2 000 points, crisp at
  devicePixelRatio 2, playhead line synced to playback; click/drag any chart to seek.
- **Compare** — load a second `.traj` (Compare… button or drop on the right 40% of the
  window). Left/right split with a draggable divider, one shared clock and camera pose,
  per-side policy chips with live delay/throughput, charts overlay both sides (A solid,
  B dashed), and non-blocking warnings when seeds or networks differ.
- **Video export** — records the canvas (single or split view) via
  `canvas.captureStream(60)` + MediaRecorder (VP9, falling back to VP8) honoring the
  current camera/overlays; choose range (full file or current position → end) and
  recording speed, then it auto-plays that range and downloads
  `<policy>_<network>.webm`, restoring the prior playback state afterwards.

## Architecture

The app is split into a pure parsing/series layer, a three.js layer, and a thin React
shell — three.js objects never enter React state.

- `src/lib/traj.ts` — the `.traj` binary contract (see `docs/TRAJECTORY_FORMAT.md` at the
  repo root). Header/meta/trailer/index parse eagerly; frames decode lazily behind an LRU
  cache (120 frames) so scrubbing large files stays O(1) per seek. `scanMeta()` makes one
  extra pass decoding **only** tick + signals + queues + rewards + metrics of every frame
  (vehicle blocks are skipped by seeking), returning frame-major typed-array series —
  thousands of frames scan in a few milliseconds; the result is cached on the file.
- `src/lib/series.ts` / `src/lib/ramps.ts` — pure helpers: column extraction, min-max
  downsampling for the charts, phase-strip segmentation, time formatting, and the color
  ramps used by overlays. Fully unit tested.
- `src/lib/scene/` — three.js layers that know nothing about React: `buildRoads` (static
  geometry), `VehicleLayer` (one InstancedMesh for all cars, id- or speed-based instance
  colors, pose queries for picking/following with persistent id→index maps),
  `SignalLayer`, and `overlays/` (queue heatmap, phase timers, pressure discs, trajectory
  ribbons, shared canvas-texture text sprites). Overlays skip all work while hidden and
  reuse scratch objects — no per-frame allocations in hot loops.
- `src/lib/viz/` — the runtime: `PlaybackClock` (time-based shared clock; comparison
  files with different lengths/dt stay in sync), `CameraRig` (orbit/top-down/follow, one
  pose applied to every viewport), `SceneView` (one loaded replay: scene + layers +
  overlays), `CanvasRecorder` (webm capture), and `VizEngine` — the orchestrator that
  owns the renderer, render loop, split-screen scissored rendering, raycast picking, and
  recording. React talks to the engine through methods and an `afterFrame` hook.
- `src/components/` — `Viewer.tsx` (orchestrator: engine lifecycle, UI state, keyboard,
  drag-and-drop), `ControlBar` + `PhaseStrip`, `SidePanel`, `ChartsPanel`,
  `CompareOverlay` (chips + divider), `ExportDialog`, `Toasts`. HUD-frequency values
  (readouts, chip stats, playheads) are written straight to the DOM/canvas from
  `afterFrame` — React re-renders only on real UI interactions.

Sim coordinates (X east, Y north) map to the scene as (x, -z); headings rotate about +Y.
three.js stays client-only via a `dynamic(..., { ssr: false })` import in a client
component.
