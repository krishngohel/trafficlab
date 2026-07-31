"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { phaseSegments } from "@/lib/series";
import {
  VizEngine,
  type CameraMode,
  type OverlayToggles,
  type SideInfo,
  type Theme,
} from "@/lib/viz/engine";
import { DEFAULT_TOGGLES } from "@/lib/viz/view";
import ChartsPanel, { buildSideSeries } from "./ChartsPanel";
import CompareOverlay from "./CompareOverlay";
import ControlBar from "./ControlBar";
import ExportDialog from "./ExportDialog";
import SidePanel from "./SidePanel";
import Toasts, { type Toast } from "./Toasts";
import WaitHud from "./WaitHud";
import FpsHud from "./FpsHud";
import styles from "./Viewer.module.css";

type DragHint = "primary" | "compare" | null;

/**
 * Top-level orchestrator. All three.js objects live inside VizEngine; React
 * holds only the opaque engine handle plus low-frequency UI state. Per-frame
 * values (playhead, readouts, chip stats) are written to the DOM through the
 * engine's afterFrame hook, never through React state.
 */
export default function Viewer() {
  const hostRef = useRef<HTMLDivElement>(null);
  const fileARef = useRef<HTMLInputElement>(null);
  const fileBRef = useRef<HTMLInputElement>(null);
  const downPos = useRef<{ x: number; y: number; t: number } | null>(null);
  const toastId = useRef(0);

  const [engine, setEngine] = useState<VizEngine | null>(null);
  const [infoA, setInfoA] = useState<SideInfo | null>(null);
  const [infoB, setInfoB] = useState<SideInfo | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [cameraMode, setCameraMode] = useState<CameraMode>("orbit");
  const [theme, setTheme] = useState<Theme>("day");
  const [followId, setFollowId] = useState<number | null>(null);
  const [toggles, setToggles] = useState<OverlayToggles>({ ...DEFAULT_TOGGLES });
  const [selectedK, setSelectedK] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  /** Frame-rate chip; "f" toggles it so exported stills can stay clean. */
  const [fpsOpen, setFpsOpen] = useState(true);
  const [chartsOpen, setChartsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragHint, setDragHint] = useState<DragHint>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  // --- engine lifecycle -----------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const created = new VizEngine(host);
    created.onFollowChange = (id) => {
      setFollowId(id);
      setCameraMode(created.cameraMode);
    };
    created.onAutoPause = () => setPlaying(false);
    created.onRecordingChange = (rec) => {
      setRecording(rec);
      setPlaying(created.clock.playing);
      setSpeed(created.clock.speed);
    };
    created.onToast = addToast;
    // Start pulling the model/texture/HDRI bundle the moment the canvas exists,
    // so it is usually resident before the first file lands.
    void created.ensureAssets();
    setEngine(created);
    return () => {
      created.dispose();
      setEngine(null);
    };
  }, [addToast]);

  // --- loading ----------------------------------------------------------------
  const loadPrimary = useCallback(
    async (buffer: ArrayBuffer, name: string) => {
      if (!engine || engine.isRecording) return;
      await engine.ensureAssets();
      try {
        const info = engine.loadPrimary(buffer, name);
        setInfoA(info);
        setInfoB(null);
        setError(null);
        setPlaying(true);
        setSelectedK(0);
        setCameraMode(engine.cameraMode);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [engine],
  );

  const loadCompare = useCallback(
    async (buffer: ArrayBuffer, name: string) => {
      if (!engine || engine.isRecording) return;
      await engine.ensureAssets();
      try {
        const { info, warnings } = engine.loadCompare(buffer, name);
        setInfoB(info);
        setError(null);
        warnings.forEach(addToast);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [engine, addToast],
  );

  const loadDemo = useCallback(
    (fixture: string) => {
      // Runtime fetches are not rewritten by Next's basePath, so a build served
      // from a subpath (GitHub Pages project site) has to add it here.
      fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/fixtures/${fixture}`)
        .then((res) => {
          if (!res.ok) throw new Error(`demo fetch failed: HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((buf) => loadPrimary(buf, fixture))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [loadPrimary],
  );

  const readPicked = (
    e: React.ChangeEvent<HTMLInputElement>,
    handler: (buf: ArrayBuffer, name: string) => void,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    file
      .arrayBuffer()
      .then((buf) => handler(buf, file.name))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  // --- playback / camera handlers ---------------------------------------------
  const togglePlay = useCallback(() => {
    if (!engine || engine.isRecording || !engine.getView(0)) return;
    const next = !engine.clock.playing;
    engine.setPlaying(next);
    setPlaying(next);
  }, [engine]);

  const stepBy = useCallback(
    (delta: number) => {
      if (!engine || engine.isRecording || !engine.getView(0)) return;
      engine.stepFrames(delta);
      setPlaying(false);
    },
    [engine],
  );

  const changeSpeed = useCallback(
    (value: number) => {
      if (!engine || engine.isRecording) return;
      engine.setSpeed(value);
      setSpeed(value);
    },
    [engine],
  );

  const changeCamera = useCallback(
    (mode: "orbit" | "top") => {
      if (!engine) return;
      engine.setCameraMode(mode);
      setCameraMode(mode);
    },
    [engine],
  );

  const changeToggles = useCallback(
    (next: OverlayToggles) => {
      setToggles(next);
      engine?.setToggles(next);
    },
    [engine],
  );

  const changeTheme = useCallback(
    (next: Theme) => {
      setTheme(next);
      engine?.setTheme(next);
    },
    [engine],
  );

  const closeCompare = useCallback(() => {
    engine?.closeCompare();
    setInfoB(null);
  }, [engine]);

  const startExport = useCallback(
    (fullFile: boolean, recSpeed: number) => {
      setExportOpen(false);
      const err = engine?.startRecording({ fullFile, speed: recSpeed });
      if (err) addToast(err);
    },
    [engine, addToast],
  );

  // --- keyboard shortcuts -------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case ",":
          stepBy(-1);
          break;
        case ".":
          stepBy(1);
          break;
        case "Escape":
          if (exportOpen) setExportOpen(false);
          else engine?.exitFollow();
          break;
        case "1":
          changeCamera("orbit");
          break;
        case "2":
          changeCamera("top");
          break;
        case "f":
        case "F":
          setFpsOpen((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, togglePlay, stepBy, changeCamera, exportOpen]);

  // --- derived chart / strip data (stable typed arrays, cheap to memo) -----------
  const seriesA = useMemo(
    () => (engine && infoA ? buildSideSeries(engine.getView(0)) : null),
    [engine, infoA],
  );
  const seriesB = useMemo(
    () => (engine && infoB ? buildSideSeries(engine.getView(1)) : null),
    [engine, infoB],
  );
  const segments = useMemo(() => {
    const view = engine && infoA ? engine.getView(0) : null;
    return view ? phaseSegments(view.scan, selectedK) : [];
  }, [engine, infoA, selectedK]);

  const duration = infoA ? Math.max(infoA.duration, infoB?.duration ?? 0) : 0;

  // --- drag & drop ------------------------------------------------------------------
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragHint(null);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const toCompare = infoA !== null && e.clientX > window.innerWidth * 0.6;
    file
      .arrayBuffer()
      .then((buf) => (toCompare ? loadCompare(buf, file.name) : loadPrimary(buf, file.name)))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div
      className={`${styles.root} ${dragHint !== null ? styles.dragActive : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragHint(infoA !== null && e.clientX > window.innerWidth * 0.6 ? "compare" : "primary");
      }}
      onDragLeave={() => setDragHint(null)}
      onDrop={onDrop}
    >
      <div
        ref={hostRef}
        className={styles.canvasHost}
        onPointerDown={(e) => {
          if (e.button === 0) downPos.current = { x: e.clientX, y: e.clientY, t: performance.now() };
        }}
        onPointerUp={(e) => {
          const d = downPos.current;
          downPos.current = null;
          if (!d || e.button !== 0 || recording) return;
          if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 400)
            return;
          engine?.pick(e.clientX, e.clientY);
        }}
      />

      {error && <div className={styles.error}>{error}</div>}

      {infoA === null && (
        <div className={styles.dropOverlay}>
          <div className={styles.dropTitle}>Drop a .traj file anywhere</div>
          <div className={styles.demoRow}>
            <button
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={() => loadDemo("city.traj")}
              title="25 signalised intersections, mixed 1/2/3-lane streets, all actively controlled"
            >
              Load city demo
            </button>
            <button
              className={styles.button}
              onClick={() => loadDemo("grid4x4_demo.traj")}
              title="4×4 grid under heavy demand — ~1500 vehicles, the performance reference"
            >
              4×4 grid
            </button>
            <button
              className={styles.button}
              onClick={() => loadDemo("single_actuated.traj")}
              title="One intersection under actuated control — close enough to watch individual cars"
            >
              Single intersection
            </button>
          </div>
        </div>
      )}

      {dragHint === "compare" && (
        <div className={styles.dropHalfHint} style={{ left: "60%", right: 0 }}>
          Drop to compare (right side)
        </div>
      )}

      {engine && infoA && (
        <div className={styles.toolbar}>
          <button className={styles.toolBtn} disabled={recording} onClick={() => fileARef.current?.click()}>
            Load…
          </button>
          {infoB === null ? (
            <button className={styles.toolBtn} disabled={recording} onClick={() => fileBRef.current?.click()}>
              Compare…
            </button>
          ) : (
            <button className={styles.toolBtn} disabled={recording} onClick={closeCompare}>
              ✕ Compare
            </button>
          )}
          <button className={styles.toolBtn} disabled={recording} onClick={() => setExportOpen(true)}>
            ⏺ Export
          </button>
          <button
            className={`${styles.toolBtn} ${chartsOpen ? styles.toolBtnActive : ""}`}
            onClick={(e) => {
              e.currentTarget.blur();
              setChartsOpen((v) => !v);
            }}
          >
            Charts
          </button>
          <button
            className={`${styles.toolBtn} ${panelOpen ? styles.toolBtnActive : ""}`}
            onClick={(e) => {
              e.currentTarget.blur();
              setPanelOpen((v) => !v);
            }}
          >
            Panel
          </button>
        </div>
      )}

      {infoA && panelOpen && (
        <SidePanel
          cameraMode={cameraMode}
          onCameraMode={changeCamera}
          toggles={toggles}
          onToggles={changeToggles}
          followId={followId}
          theme={theme}
          onTheme={changeTheme}
        />
      )}

      {engine && infoA && infoB && <CompareOverlay engine={engine} infoA={infoA} infoB={infoB} />}

      {engine && infoA && (
        <WaitHud key={infoB ? "compare" : "single"} engine={engine} compare={infoB !== null} />
      )}

      {engine && infoA && fpsOpen && <FpsHud engine={engine} compare={infoB !== null} />}

      {recording && (
        <div className={styles.recIndicator}>
          <span className={styles.recDot} />
          REC
          <button className={styles.recBtn} onClick={() => engine?.stopRecording(false)}>
            Stop &amp; save
          </button>
          <button className={styles.recBtn} onClick={() => engine?.stopRecording(true)}>
            Discard
          </button>
        </div>
      )}

      {engine && infoA && chartsOpen && seriesA !== null && (
        <ChartsPanel engine={engine} a={seriesA} b={seriesB} duration={duration} />
      )}

      {engine && infoA && (
        <ControlBar
          engine={engine}
          playing={playing}
          speed={speed}
          disabled={recording}
          duration={duration}
          infoA={infoA}
          label={
            infoB === null
              ? `${infoA.networkName} · ${infoA.policy} · ${infoA.name}`
              : `${infoA.name} vs ${infoB.name}`
          }
          segments={segments}
          selectedK={selectedK}
          onSelectK={setSelectedK}
          onPlayPause={togglePlay}
          onSpeed={changeSpeed}
          onStep={stepBy}
        />
      )}

      {exportOpen && <ExportDialog onStart={startExport} onClose={() => setExportOpen(false)} />}

      <Toasts toasts={toasts} />

      <input
        ref={fileARef}
        type="file"
        accept=".traj"
        hidden
        onChange={(e) => readPicked(e, loadPrimary)}
      />
      <input
        ref={fileBRef}
        type="file"
        accept=".traj"
        hidden
        onChange={(e) => readPicked(e, loadCompare)}
      />
    </div>
  );
}
