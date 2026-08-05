"use client";

import { useEffect, useState } from "react";
import type { FocusEvent } from "react";
import type { VisibleToast } from "./toast-queue.client";
import styles from "./toast-region.module.css";

interface ToastRegionProps {
  toasts: readonly VisibleToast[];
  onDismiss(id: string): void;
  /** Called with the combined hover-or-focus state of the whole region. */
  onPausedChange(paused: boolean): void;
}

/**
 * The transient tier: confirmations that need no decision.
 *
 * Three properties are load-bearing here rather than decorative.
 *
 * **The live region is always mounted.** A screen reader announces additions to
 * a live region that already existed; one that appears with its first message
 * inside it announces nothing. So the list stays in the document when empty and
 * the container is inert rather than conditional.
 *
 * **Hover and focus both pause, and they are combined.** Either alone would let
 * the other retire a toast the user is reading: tabbing to a toast's action
 * moves the pointer nowhere, and reading under the pointer takes no focus. The
 * region reports `hovered || focused` so a toast cannot expire while the user
 * is engaged with it by either route.
 *
 * **Motion is opt-in.** Entry animation is behind `prefers-reduced-motion:
 * no-preference` in the stylesheet, so a reduced-motion reader gets the same
 * messages with no movement — the timing is unchanged, only the travel.
 */
export function ToastRegion({ toasts, onDismiss, onPausedChange }: ToastRegionProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    onPausedChange(hovered || focused);
  }, [focused, hovered, onPausedChange]);

  function releaseFocus(event: FocusEvent<HTMLDivElement>): void {
    // `blur` bubbles from a toast's own button to the next one when the user
    // tabs between them. Only focus actually leaving the region resumes.
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  }

  return (
    <div
      className={styles.region}
      onBlurCapture={releaseFocus}
      onFocusCapture={() => setFocused(true)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <ol
        aria-atomic="false"
        aria-label="Notifications"
        aria-live="polite"
        className={styles.list}
      >
        {toasts.map((toast) => (
          <li className={`${styles.toast} ${styles[toast.tone]}`} key={toast.id}>
            <div className={styles.copy}>
              <strong className={styles.title}>{toast.title}</strong>
              {toast.detail && <span className={styles.detail}>{toast.detail}</span>}
            </div>
            <div className={styles.actions}>
              {toast.action && (
                <button
                  className="button primary"
                  type="button"
                  onClick={() => {
                    toast.action?.onSelect();
                    onDismiss(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              )}
              <button
                aria-label={`Dismiss: ${toast.title}`}
                className={styles.dismiss}
                type="button"
                onClick={() => onDismiss(toast.id)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
