"use client";

import { APP_MODES } from "./app-mode";
import type { AppMode } from "./app-mode";
import styles from "./mode-strip.module.css";

interface ModeStripProps {
  value: AppMode;
  onChange(mode: AppMode): void;
  /**
   * Modes with work in progress that the user cannot see from where they are.
   * A batch runs to completion whichever mode is on screen, so the strip is
   * where that fact stays visible.
   */
  busyModes?: readonly AppMode[];
}

export function ModeStrip({ value, onChange, busyModes = [] }: ModeStripProps) {
  return (
    <nav aria-label="Application mode" className={styles.strip}>
      {APP_MODES.map(({ id, label }) => {
        const busy = busyModes.includes(id);
        return (
          <button
            aria-current={value === id ? "page" : undefined}
            className={styles.mode}
            key={id}
            type="button"
            onClick={() => onChange(id)}
          >
            {label}
            {busy && (
              <>
                <span aria-hidden="true" className={styles.busy} />
                <span className="visually-hidden">running</span>
              </>
            )}
          </button>
        );
      })}
    </nav>
  );
}
