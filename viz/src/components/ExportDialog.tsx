"use client";

import { useState } from "react";
import styles from "./Viewer.module.css";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

interface Props {
  onStart: (fullFile: boolean, speed: number) => void;
  onClose: () => void;
}

/** Options for a webm video export: range + recording playback speed. */
export default function ExportDialog({ onStart, onClose }: Props) {
  const [fullFile, setFullFile] = useState(true);
  const [speed, setSpeed] = useState(1);

  return (
    <div className={styles.dialogBackdrop} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogTitle}>Export video (.webm)</div>
        <div className={styles.dialogRow}>
          <span>Range</span>
          <label className={styles.radioRow}>
            <input
              type="radio"
              name="range"
              checked={fullFile}
              onChange={() => setFullFile(true)}
            />
            Full file
          </label>
          <label className={styles.radioRow}>
            <input
              type="radio"
              name="range"
              checked={!fullFile}
              onChange={() => setFullFile(false)}
            />
            Current position → end
          </label>
        </div>
        <div className={styles.dialogRow}>
          <span>Playback speed while recording</span>
          <select
            className={styles.speed}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </div>
        <div className={styles.dialogActions}>
          <button className={styles.toolBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            className={`${styles.toolBtn} ${styles.toolBtnActive}`}
            onClick={() => onStart(fullFile, speed)}
          >
            ⏺ Start recording
          </button>
        </div>
      </div>
    </div>
  );
}
