"use client";

import { useEffect, useRef } from "react";

import type { PhaseSegment } from "@/lib/series";
import type { VizEngine } from "@/lib/viz/engine";
import styles from "./Viewer.module.css";

/** Distinct green shades per phase index, so consecutive green phases read apart. */
const GREENS = ["#38b26e", "#27835a", "#5fd393", "#1e6f4a", "#83dcae", "#2a9d70"];
const YELLOW = "#e0b93f";
const RED = "#c9463d";

interface Props {
  engine: VizEngine;
  segments: PhaseSegment[];
  numFrames: number;
  dt: number;
  disabled: boolean;
}

/**
 * Thin signal-phase timeline for one selected intersection: green/yellow/red
 * segments over the whole file (precomputed from the metrics scan), with a
 * playhead line synced to playback. Click / drag seeks.
 */
export default function PhaseStrip({ engine, segments, numFrames, dt, disabled }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const stripDuration = Math.max((numFrames - 1) * dt, 1e-6);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const maxFrame = Math.max(numFrames - 1, 1);

    const blit = () => {
      const ctx = canvas.getContext("2d");
      const st = staticRef.current;
      if (!ctx || !st || canvas.width === 0) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(st, 0, 0);
      const t = Math.min(engine.clock.time, stripDuration);
      const x = Math.round((t / stripDuration) * canvas.width);
      ctx.fillStyle = "rgba(240, 245, 250, 0.92)";
      ctx.fillRect(x - 1, 0, 2, canvas.height);
    };

    const drawStatic = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (!staticRef.current) staticRef.current = document.createElement("canvas");
      const st = staticRef.current;
      st.width = canvas.width;
      st.height = canvas.height;
      const ctx = st.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#141a24";
      ctx.fillRect(0, 0, w, h);
      for (const seg of segments) {
        const x0 = (seg.start / maxFrame) * w;
        const x1 = (Math.min(seg.end, maxFrame) / maxFrame) * w;
        ctx.fillStyle =
          seg.state === 1 ? YELLOW : seg.state === 2 ? RED : GREENS[seg.phase % GREENS.length];
        ctx.fillRect(x0, 0, Math.max(x1 - x0, 0.5), h);
      }
      blit();
    };

    drawStatic();
    const ro = new ResizeObserver(drawStatic);
    ro.observe(canvas);
    engine.afterFrame.add(blit);
    return () => {
      ro.disconnect();
      engine.afterFrame.delete(blit);
    };
  }, [engine, segments, numFrames, dt, stripDuration]);

  const seekFrom = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(Math.max((e.clientX - rect.left) / Math.max(rect.width, 1), 0), 1);
    engine.seek(frac * stripDuration);
  };

  return (
    <canvas
      ref={canvasRef}
      className={styles.stripCanvas}
      title="Signal phases over time — click to seek"
      onPointerDown={(e) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        engine.setScrubbing(true);
        seekFrom(e);
      }}
      onPointerMove={(e) => {
        if (!disabled && engine.scrubbing && (e.buttons & 1) !== 0) seekFrom(e);
      }}
      onPointerUp={() => engine.setScrubbing(false)}
      onPointerCancel={() => engine.setScrubbing(false)}
    />
  );
}
