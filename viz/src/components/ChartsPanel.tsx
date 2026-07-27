"use client";

import { useEffect, useMemo, useRef } from "react";

import { downsampleMinMax, extractColumn, formatCompact, formatTime } from "@/lib/series";
import type { VizEngine } from "@/lib/viz/engine";
import type { SceneView } from "@/lib/viz/view";
import styles from "./Viewer.module.css";

/** Precomputed chart inputs for one side, derived from its metrics scan. */
export interface SideSeries {
  dt: number;
  delay: Float32Array | null;
  throughput: Float32Array | null;
  rewards: Float32Array[];
  intersectionIds: number[];
}

export function buildSideSeries(view: SceneView | null): SideSeries | null {
  if (!view) return null;
  const scan = view.scan;
  return {
    dt: scan.dt,
    delay: view.delayCol >= 0 ? extractColumn(scan.metrics, scan.m, view.delayCol) : null,
    throughput:
      view.throughputCol >= 0 ? extractColumn(scan.metrics, scan.m, view.throughputCol) : null,
    rewards:
      scan.k > 0
        ? Array.from({ length: scan.k }, (_, k) => extractColumn(scan.rewards, scan.k, k))
        : [],
    intersectionIds: [...view.traj.meta.intersections_order],
  };
}

interface SeriesDef {
  y: ArrayLike<number>;
  dt: number;
  color: string;
  dashed: boolean;
}

interface LegendItem {
  label: string;
  color: string;
  dashed?: boolean;
}

const A_COLOR = "#6ea8fe";
const B_COLOR = "#f2a35f";
const K_HUES = [
  "#6ea8fe",
  "#f2a35f",
  "#59d98a",
  "#e57de5",
  "#b8a1ff",
  "#e8c14a",
  "#7fd8e8",
  "#f28b82",
];

const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 6;
const PAD_B = 6;

function sizeToDpr(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(Math.round(canvas.clientWidth * dpr), 1);
  canvas.height = Math.max(Math.round(canvas.clientHeight * dpr), 1);
}

function drawStatic(canvas: HTMLCanvasElement, series: SeriesDef[], duration: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = canvas.width / Math.max(canvas.clientWidth, 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0d1118";
  ctx.fillRect(0, 0, w, h);
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";

  if (series.length === 0 || duration <= 0) {
    ctx.fillStyle = "#5a6470";
    ctx.fillText("metric not present", 10, h / 2);
    return;
  }

  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const s of series) {
    for (let i = 0; i < s.y.length; i++) {
      const v = s.y[i];
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
    }
  }
  if (!Number.isFinite(dataMin)) {
    dataMin = 0;
    dataMax = 1;
  }
  if (dataMax - dataMin < 1e-9) dataMax = dataMin + 1;
  const pad = (dataMax - dataMin) * 0.07;
  const yMin = dataMin - pad;
  const yMax = dataMax + pad;

  const plotW = Math.max(w - PAD_L - PAD_R, 1);
  const plotH = Math.max(h - PAD_T - PAD_B, 1);
  const xAt = (t: number) => PAD_L + (t / duration) * plotW;
  const yAt = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  // Grid + zero line.
  ctx.strokeStyle = "rgba(120, 135, 155, 0.13)";
  ctx.lineWidth = 1;
  for (const frac of [0, 0.5, 1]) {
    const y = Math.round(PAD_T + frac * plotH) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(w - PAD_R, y);
    ctx.stroke();
  }
  if (yMin < 0 && yMax > 0) {
    ctx.strokeStyle = "rgba(150, 165, 185, 0.35)";
    const y = Math.round(yAt(0)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(w - PAD_R, y);
    ctx.stroke();
  }

  // Polylines (min-max downsampled to ~2 points per css pixel).
  const maxPoints = Math.max(Math.floor(plotW) * 2, 16);
  for (const s of series) {
    const ds = downsampleMinMax(s.y, maxPoints);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.25;
    ctx.setLineDash(s.dashed ? [4, 3] : []);
    ctx.beginPath();
    for (let i = 0; i < ds.idx.length; i++) {
      const x = xAt(ds.idx[i] * s.dt);
      const y = yAt(ds.val[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Axis labels: data min/max on the left, end time bottom-right.
  ctx.fillStyle = "#5f6b78";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(formatCompact(dataMax), 3, yAt(dataMax));
  ctx.fillText(formatCompact(dataMin), 3, yAt(dataMin));
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(formatTime(duration), w - PAD_R - 1, h - 1);
}

function drawPlayhead(canvas: HTMLCanvasElement, engine: VizEngine, duration: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx || duration <= 0) return;
  const dpr = canvas.width / Math.max(canvas.clientWidth, 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const t = Math.min(engine.clock.time, duration);
  const x = Math.round(PAD_L + (t / duration) * Math.max(w - PAD_L - PAD_R, 1)) + 0.5;
  ctx.strokeStyle = "rgba(226, 236, 248, 0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 2);
  ctx.lineTo(x, h - 2);
  ctx.stroke();
}

function Chart({
  engine,
  title,
  series,
  duration,
  legend,
}: {
  engine: VizEngine;
  title: string;
  series: SeriesDef[];
  duration: number;
  legend?: LegendItem[];
}) {
  const staticRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const st = staticRef.current;
    const ov = overlayRef.current;
    const body = bodyRef.current;
    if (!st || !ov || !body) return;
    const redraw = () => {
      sizeToDpr(st);
      sizeToDpr(ov);
      drawStatic(st, series, duration);
      drawPlayhead(ov, engine, duration);
    };
    redraw();
    const ro = new ResizeObserver(redraw);
    ro.observe(body);
    const onFrame = () => drawPlayhead(ov, engine, duration);
    engine.afterFrame.add(onFrame);
    return () => {
      ro.disconnect();
      engine.afterFrame.delete(onFrame);
    };
  }, [engine, series, duration]);

  const seekFrom = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac =
      (e.clientX - rect.left - PAD_L) / Math.max(rect.width - PAD_L - PAD_R, 1);
    engine.seek(Math.min(Math.max(frac, 0), 1) * duration);
  };

  return (
    <div className={styles.chart}>
      <div className={styles.chartHead}>
        <span className={styles.chartTitle}>{title}</span>
        {legend && (
          <span className={styles.legend}>
            {legend.map((item) => (
              <span key={`${item.label}${item.dashed ? "-b" : ""}`} className={styles.legendItem}>
                <span
                  className={styles.swatch}
                  style={{
                    background: item.dashed
                      ? `repeating-linear-gradient(90deg, ${item.color} 0 3px, transparent 3px 5px)`
                      : item.color,
                  }}
                />
                {item.label}
              </span>
            ))}
          </span>
        )}
      </div>
      <div ref={bodyRef} className={styles.chartBody}>
        <canvas ref={staticRef} className={styles.chartCanvas} />
        <canvas
          ref={overlayRef}
          className={`${styles.chartCanvas} ${styles.chartOverlay}`}
          title="Click / drag to seek"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            engine.setScrubbing(true);
            seekFrom(e);
          }}
          onPointerMove={(e) => {
            if (engine.scrubbing && (e.buttons & 1) !== 0) seekFrom(e);
          }}
          onPointerUp={() => engine.setScrubbing(false)}
          onPointerCancel={() => engine.setScrubbing(false)}
        />
      </div>
    </div>
  );
}

interface Props {
  engine: VizEngine;
  a: SideSeries;
  b: SideSeries | null;
  duration: number;
}

/**
 * Collapsible bottom panel with three synced line charts over sim time:
 * cumulative delay, throughput, and per-intersection reward. In compare
 * mode side A is solid and side B dashed. Canvas-only, no chart library.
 */
export default function ChartsPanel({ engine, a, b, duration }: Props) {
  const delaySeries = useMemo(() => {
    const out: SeriesDef[] = [];
    if (a.delay) out.push({ y: a.delay, dt: a.dt, color: A_COLOR, dashed: false });
    if (b?.delay) out.push({ y: b.delay, dt: b.dt, color: B_COLOR, dashed: true });
    return out;
  }, [a, b]);

  const thruSeries = useMemo(() => {
    const out: SeriesDef[] = [];
    if (a.throughput) out.push({ y: a.throughput, dt: a.dt, color: A_COLOR, dashed: false });
    if (b?.throughput) out.push({ y: b.throughput, dt: b.dt, color: B_COLOR, dashed: true });
    return out;
  }, [a, b]);

  const rewardSeries = useMemo(() => {
    const out: SeriesDef[] = [];
    a.rewards.forEach((y, k) =>
      out.push({ y, dt: a.dt, color: K_HUES[k % K_HUES.length], dashed: false }),
    );
    b?.rewards.forEach((y, k) =>
      out.push({ y, dt: b.dt, color: K_HUES[k % K_HUES.length], dashed: true }),
    );
    return out;
  }, [a, b]);

  const abLegend: LegendItem[] | undefined = b
    ? [
        { label: "A", color: A_COLOR },
        { label: "B", color: B_COLOR, dashed: true },
      ]
    : undefined;

  const rewardLegend: LegendItem[] = a.intersectionIds.map((id, k) => ({
    label: `I${id}`,
    color: K_HUES[k % K_HUES.length],
  }));
  if (b) rewardLegend.push({ label: "B dashed", color: "#8d97a5", dashed: true });

  return (
    <div className={styles.chartsPanel}>
      <Chart
        engine={engine}
        title="cumulative delay"
        series={delaySeries}
        duration={duration}
        legend={abLegend}
      />
      <Chart
        engine={engine}
        title="throughput"
        series={thruSeries}
        duration={duration}
        legend={abLegend}
      />
      <Chart
        engine={engine}
        title="reward / intersection"
        series={rewardSeries}
        duration={duration}
        legend={rewardLegend}
      />
    </div>
  );
}
