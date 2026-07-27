"use client";

import styles from "./Viewer.module.css";

export interface Toast {
  id: number;
  text: string;
}

/** Non-blocking toast stack (auto-dismissed by the owner). */
export default function Toasts({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className={styles.toasts}>
      {toasts.map((t) => (
        <div key={t.id} className={styles.toast}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
