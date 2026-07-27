"use client";

import { useEffect, useRef } from "react";

import { formatTime, type PhaseSegment } from "@/lib/series";
import type { SideInfo, VizEngine } from "@/lib/viz/engine";
import PhaseStrip from "./PhaseStrip";
import styles from "./Viewer.module.css";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

interface Props {
  engine: VizEngine;
  playing: boolean;
  speed: number;
  disabled: boolean;
  duration: number;
  infoA: SideInfo;
  label: string;
  segments: PhaseSegment[];
  selectedK: number;
  onSelectK: (k: number) => void;
  onPlayPause: () => void;
  onSpeed: (speed: number) => void;
  onStep: (delta: number) => void;
}

/**
 * Playback controls: play/pause, single-frame steps, speed, scrub slider,
 * time + frame readout, and the per-intersection signal-phase strip.
 * High-frequency readouts are written to the DOM from the engine's
 * afterFrame hook — no React re-renders during playback.
 */
export default function ControlBar({
  engine,
  playing,
  speed,
  disabled,
  duration,
  infoA,
  label,
  segments,
  selectedK,
  onSelectK,
  onPlayPause,
  onSpeed,
  onStep,
}: Props) {
  const sliderRef = useRef<HTMLInputElement>(null);
  const counterRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const sync = () => {
      const t = engine.clock.time;
      if (!engine.scrubbing && sliderRef.current) {
        sliderRef.current.value = String(t);
      }
      if (counterRef.current) {
        const fa = Math.floor(engine.clock.frameAt(infoA.dt, infoA.numFrames));
        const text = `${formatTime(t)} / ${formatTime(duration)} · f ${fa} / ${infoA.numFrames - 1}`;
        if (counterRef.current.textContent !== text) counterRef.current.textContent = text;
      }
    };
    engine.afterFrame.add(sync);
    return () => {
      engine.afterFrame.delete(sync);
    };
  }, [engine, duration, infoA]);

  return (
    <div className={styles.bar}>
      <div className={styles.barRow}>
        <button
          className={styles.stepBtn}
          disabled={disabled}
          title="Step back one frame (,)"
          onClick={(e) => {
            e.currentTarget.blur();
            onStep(-1);
          }}
        >
          ◀
        </button>
        <button
          className={styles.playBtn}
          disabled={disabled}
          title={playing ? "Pause (space)" : "Play (space)"}
          onClick={(e) => {
            e.currentTarget.blur();
            onPlayPause();
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button
          className={styles.stepBtn}
          disabled={disabled}
          title="Step forward one frame (.)"
          onClick={(e) => {
            e.currentTarget.blur();
            onStep(1);
          }}
        >
          ▶
        </button>
        <select
          className={styles.speed}
          value={speed}
          disabled={disabled}
          onChange={(e) => {
            e.currentTarget.blur();
            onSpeed(Number(e.target.value));
          }}
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
          max={duration}
          step={0.01}
          defaultValue={0}
          disabled={disabled}
          onPointerDown={() => engine.setScrubbing(true)}
          onPointerUp={(e) => {
            engine.setScrubbing(false);
            e.currentTarget.blur();
          }}
          onChange={(e) => engine.seek(Number(e.target.value))}
        />
        <span ref={counterRef} className={styles.counter}>
          0:00 / {formatTime(duration)} · f 0 / {infoA.numFrames - 1}
        </span>
        <span className={styles.label} title={label}>
          {label}
        </span>
      </div>
      <div className={styles.stripRow}>
        <span className={styles.stripLabel}>Phases</span>
        <PhaseStrip
          engine={engine}
          segments={segments}
          numFrames={infoA.numFrames}
          dt={infoA.dt}
          disabled={disabled}
        />
        <select
          className={styles.stripSelect}
          value={selectedK}
          disabled={disabled}
          aria-label="Intersection shown in the phase strip"
          onChange={(e) => {
            e.currentTarget.blur();
            onSelectK(Number(e.target.value));
          }}
          title="Intersection shown in the phase strip"
        >
          {infoA.intersectionIds.map((id, k) => (
            <option key={id} value={k}>
              Strip: I{id}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
