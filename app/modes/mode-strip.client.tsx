"use client";

import { APP_MODES } from "./app-mode";
import type { AppMode, ModeIndicator } from "./app-mode";
import styles from "./mode-strip.module.css";

interface ModeStripProps {
  value: AppMode;
  onChange(mode: AppMode): void;
  /**
   * Per-mode state the user cannot see from where they are. A batch runs to
   * completion whichever mode is on screen and its results stay in Runs after
   * it finishes, so the strip is where both facts stay visible — and unlike a
   * toast, neither expires.
   */
  indicators?: Partial<Record<AppMode, ModeIndicator>>;
}

export function ModeStrip({ value, onChange, indicators }: ModeStripProps) {
  return (
    <nav aria-label="Application mode" className={styles.strip}>
      {APP_MODES.map(({ id, label }) => {
        const indicator = indicators?.[id];
        return (
          <button
            aria-current={value === id ? "page" : undefined}
            className={styles.mode}
            key={id}
            type="button"
            onClick={() => onChange(id)}
          >
            {label}
            {indicator && (
              <>
                <span
                  aria-hidden="true"
                  className={`${styles.dot} ${styles[indicator.tone]}`}
                  data-mode-indicator={indicator.tone}
                />
                <span className="visually-hidden">{indicator.label}</span>
              </>
            )}
          </button>
        );
      })}
    </nav>
  );
}
