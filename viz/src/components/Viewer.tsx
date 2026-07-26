"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { parseTraj, type TrajFile } from "@/lib/traj";
import { buildRoads, disposeGroup, networkBounds, SignalLayer, VehicleLayer } from "@/lib/scene";
import styles from "./Viewer.module.css";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

/** Everything three.js lives here, never in React state. */
interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  roads: THREE.Group | null;
  vehicles: VehicleLayer | null;
  signals: SignalLayer | null;
  traj: TrajFile | null;
  /** Fractional playhead in frames: floor = frame f, frac = interpolation t. */
  playhead: number;
  playing: boolean;
  speed: number;
  scrubbing: boolean;
  lastSignalFrame: number;
}

export default function Viewer() {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const counterRef = useRef<HTMLSpanElement>(null);

  const [numFrames, setNumFrames] = useState(0);
  const [label, setLabel] = useState("");
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // Keep the render loop's copies in sync with UI state.
  useEffect(() => {
    if (worldRef.current) worldRef.current.playing = playing;
  }, [playing]);
  useEffect(() => {
    if (worldRef.current) worldRef.current.speed = speed;
  }, [speed]);

  // --- three.js lifecycle -------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c10);
    scene.fog = new THREE.Fog(0x0a0c10, 600, 2200);

    const camera = new THREE.PerspectiveCamera(
      50,
      host.clientWidth / host.clientHeight,
      0.1,
      5000,
    );
    camera.position.set(90, 110, 140);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;

    scene.add(new THREE.HemisphereLight(0x8a9bb8, 0x1a1d22, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2df, 1.6);
    sun.position.set(120, 220, 80);
    scene.add(sun);

    const world: World = {
      renderer,
      scene,
      camera,
      controls,
      roads: null,
      vehicles: null,
      signals: null,
      traj: null,
      playhead: 0,
      playing: true,
      speed: 1,
      scrubbing: false,
      lastSignalFrame: -1,
    };
    worldRef.current = world;

    const onResize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(host);

    let raf = 0;
    let lastTime = performance.now();
    const tickLoop = (now: number) => {
      raf = requestAnimationFrame(tickLoop);
      const dtReal = Math.min((now - lastTime) / 1000, 0.25);
      lastTime = now;

      controls.update();

      const traj = world.traj;
      if (traj && traj.numFrames > 0) {
        const maxF = traj.numFrames - 1;
        if (world.playing && !world.scrubbing && maxF > 0) {
          // 1x playback = real time: frames advance at 1/dt per second.
          world.playhead += (dtReal * world.speed) / traj.meta.dt;
          if (world.playhead >= maxF) world.playhead %= maxF; // loop
        }
        const f = Math.min(Math.max(world.playhead, 0), maxF);
        const fa = Math.floor(f);
        const fb = Math.min(fa + 1, maxF);
        const t = f - fa;

        const frameA = traj.frame(fa);
        const frameB = fb !== fa ? traj.frame(fb) : null;
        world.vehicles?.update(frameA, frameB, t);
        if (world.signals && world.lastSignalFrame !== fa) {
          world.signals.update(frameA);
          world.lastSignalFrame = fa;
        }

        // HUD updates go straight to the DOM, bypassing React.
        if (!world.scrubbing && sliderRef.current) {
          sliderRef.current.value = String(f);
        }
        if (counterRef.current) {
          counterRef.current.textContent = `frame ${fa} / ${maxF}`;
        }
      }

      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tickLoop);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      controls.dispose();
      if (world.roads) disposeGroup(world.roads);
      world.vehicles?.dispose();
      world.signals?.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      worldRef.current = null;
    };
  }, []);

  // --- loading ------------------------------------------------------------
  const loadBuffer = useCallback((buffer: ArrayBuffer, name: string) => {
    const world = worldRef.current;
    if (!world) return;
    let traj: TrajFile;
    try {
      traj = parseTraj(buffer);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setError(null);

    // Tear down the previous replay.
    if (world.roads) {
      world.scene.remove(world.roads);
      disposeGroup(world.roads);
    }
    if (world.vehicles) {
      world.scene.remove(world.vehicles.mesh);
      world.vehicles.dispose();
    }
    if (world.signals) {
      world.scene.remove(world.signals.group);
      world.signals.dispose();
    }

    world.traj = traj;
    world.roads = buildRoads(traj.meta);
    world.vehicles = new VehicleLayer();
    world.signals = new SignalLayer(traj.meta);
    world.scene.add(world.roads, world.vehicles.mesh, world.signals.group);
    world.playhead = 0;
    world.lastSignalFrame = -1;

    // Frame the network.
    const b = networkBounds(traj.meta);
    const d = Math.max(b.extent * 0.9, 60);
    world.controls.target.set(b.centerX, 0, -b.centerY);
    world.camera.position.set(b.centerX + d * 0.55, d * 0.85, -b.centerY + d * 0.75);
    world.controls.update();

    setNumFrames(traj.numFrames);
    setLabel(`${traj.meta.network_name} · ${traj.meta.policy} · ${name}`);
  }, []);

  const loadDemo = useCallback(() => {
    fetch("/fixtures/synthetic.traj")
      .then((res) => {
        if (!res.ok) throw new Error(`demo fetch failed: HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => loadBuffer(buf, "synthetic.traj"))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [loadBuffer]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      file
        .arrayBuffer()
        .then((buf) => loadBuffer(buf, file.name))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [loadBuffer],
  );

  // --- UI handlers ---------------------------------------------------------
  const onScrub = (value: number) => {
    const world = worldRef.current;
    if (!world || !world.traj) return;
    world.playhead = Math.min(Math.max(value, 0), world.traj.numFrames - 1);
  };

  const loaded = numFrames > 0;

  return (
    <div
      className={`${styles.root} ${dragActive ? styles.dragActive : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={onDrop}
    >
      <div ref={hostRef} className={styles.canvasHost} />

      {error && <div className={styles.error}>{error}</div>}

      {!loaded && (
        <div className={styles.dropOverlay}>
          <div className={styles.dropTitle}>Drop a .traj file anywhere</div>
          <button className={styles.button} onClick={loadDemo}>
            Load demo
          </button>
        </div>
      )}

      {loaded && (
        <div className={styles.bar}>
          <button
            className={styles.playBtn}
            onClick={() => setPlaying((p) => !p)}
            title={playing ? "Pause" : "Play"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <select
            className={styles.speed}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            title="Playback speed"
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
          <input
            ref={sliderRef}
            className={styles.slider}
            type="range"
            min={0}
            max={numFrames - 1}
            step={0.01}
            defaultValue={0}
            onPointerDown={() => {
              if (worldRef.current) worldRef.current.scrubbing = true;
            }}
            onPointerUp={() => {
              if (worldRef.current) worldRef.current.scrubbing = false;
            }}
            onChange={(e) => onScrub(Number(e.target.value))}
          />
          <span ref={counterRef} className={styles.counter}>
            frame 0 / {numFrames - 1}
          </span>
          <span className={styles.label}>{label}</span>
        </div>
      )}
    </div>
  );
}
