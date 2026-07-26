# trafficlab viz

WebGL visualizer for trafficlab `.traj` replay files (Next.js + TypeScript + three.js).

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # vitest: .traj parser tests
npm run build    # production build
```

Open the page, then either drag-and-drop a `.traj` file anywhere on the window or click
**Load demo** (loads `public/fixtures/synthetic.traj`). Controls: play/pause, speed
(0.25x-8x, 1x = real time), scrub slider, frame counter. Camera is standard orbit
(drag to rotate, wheel to zoom, right-drag to pan).

## Architecture

The app is split into a pure parsing layer and a rendering layer, with React only at the
edges. `src/lib/traj.ts` implements the `.traj` binary contract defined in
`docs/TRAJECTORY_FORMAT.md` (repo root): it eagerly parses the header, meta JSON, trailer,
and frame index, then decodes frames lazily on demand behind an LRU cache (120 frames), so
scrubbing large files stays O(1) per seek. Vehicle blocks sit at unaligned file offsets, so
each decoded frame copies its block into fresh aligned typed arrays. `src/lib/scene/`
holds the three.js pieces, none of which know about React: `buildRoads` turns the meta
network into static geometry (ground plane, lane ribbons, intersection discs),
`VehicleLayer` draws every car as one `InstancedMesh` with per-instance colors, and
`SignalLayer` places emissive signal heads at approach-lane ends, colored from the phase
and state of the connections leaving each lane. `src/components/Viewer.tsx` owns the
render loop: all mutable playback state (playhead, speed, scrubbing) lives in refs, a
`requestAnimationFrame` loop interpolates vehicle positions and headings (shortest-arc)
between consecutive frames at the fractional playhead, and HUD elements are updated by
writing to the DOM directly, so React re-renders only on UI interactions. three.js code is
kept client-only via a `dynamic(..., { ssr: false })` import inside a client component.
Sim coordinates (X east, Y north) map to the scene as (x, -z), headings rotate about +Y.
