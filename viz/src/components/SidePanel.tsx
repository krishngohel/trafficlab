"use client";

import type { CameraMode, OverlayToggles, Theme } from "@/lib/viz/engine";
import styles from "./Viewer.module.css";

interface Props {
  cameraMode: CameraMode;
  onCameraMode: (mode: "orbit" | "top") => void;
  toggles: OverlayToggles;
  onToggles: (toggles: OverlayToggles) => void;
  followId: number | null;
  theme: Theme;
  onTheme: (theme: Theme) => void;
}

const OVERLAY_ITEMS: { key: keyof OverlayToggles; label: string; sub?: boolean }[] = [
  { key: "queues", label: "Queue heatmap" },
  { key: "timers", label: "Signal phase timers" },
  { key: "speedColor", label: "Velocity coloring" },
  { key: "ribbons", label: "Trajectory ribbon (selected)" },
  { key: "ribbonsAll", label: "Ribbons: all vehicles (≤200)", sub: true },
  { key: "pressure", label: "Pressure field (rewards)" },
];

/** Collapsible right-hand panel: camera modes + overlay layer toggles. */
export default function SidePanel({
  cameraMode,
  onCameraMode,
  toggles,
  onToggles,
  followId,
  theme,
  onTheme,
}: Props) {
  const camBtn = (mode: "orbit" | "top", label: string, active: boolean) => (
    <button
      className={`${styles.camBtn} ${active ? styles.camBtnActive : ""}`}
      onClick={(e) => {
        e.currentTarget.blur();
        onCameraMode(mode);
      }}
    >
      {label}
    </button>
  );

  const themeBtn = (value: Theme, label: string) => (
    <button
      className={`${styles.camBtn} ${theme === value ? styles.camBtnActive : ""}`}
      onClick={(e) => {
        e.currentTarget.blur();
        onTheme(value);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className={styles.sidePanel}>
      <div className={styles.panelSection}>
        <div className={styles.panelTitle}>Lighting</div>
        <div className={styles.camRow}>
          {themeBtn("day", "Day")}
          {themeBtn("night", "Night")}
        </div>
      </div>

      <div className={styles.panelSection}>
        <div className={styles.panelTitle}>Camera</div>
        <div className={styles.camRow}>
          {camBtn("orbit", "Orbit", cameraMode === "orbit")}
          {camBtn("top", "Top-down", cameraMode === "top")}
          <button
            className={`${styles.camBtn} ${cameraMode === "follow" ? styles.camBtnActive : ""}`}
            title="Click a vehicle in the scene to follow it"
            onClick={(e) => e.currentTarget.blur()}
          >
            Follow
          </button>
        </div>
        <div
          data-follow-hint
          className={`${styles.followHint} ${followId !== null ? styles.followActive : ""}`}
        >
          {followId !== null
            ? `Following vehicle #${followId} — Esc to release`
            : "Follow: click a vehicle (Esc exits)"}
        </div>
      </div>

      <div className={styles.panelSection}>
        <div className={styles.panelTitle}>Overlays</div>
        {OVERLAY_ITEMS.map((item) => (
          <label
            key={item.key}
            className={`${styles.checkRow} ${item.sub ? styles.checkSub : ""}`}
          >
            <input
              type="checkbox"
              checked={toggles[item.key]}
              onChange={(e) => onToggles({ ...toggles, [item.key]: e.target.checked })}
            />
            {item.label}
          </label>
        ))}
      </div>
    </div>
  );
}
