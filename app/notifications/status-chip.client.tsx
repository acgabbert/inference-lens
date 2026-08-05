"use client";

import type { ReactNode } from "react";
import styles from "./status-chip.module.css";

export interface StatusChipAction {
  key: string;
  label: string;
  onSelect(): void;
}

interface StatusChipProps {
  /**
   * `neutral` for a fact, `advisory` for one with a cost the user should weigh,
   * `failure` for something that went wrong and is still true.
   */
  tone: "neutral" | "advisory" | "failure";
  /** The state, named in two or three words. Always the first thing read. */
  label: string;
  /** What it means, in one sentence. */
  detail?: ReactNode;
  actions?: readonly StatusChipAction[];
}

/**
 * The ambient tier: state that is true right now, rendered inline beside what
 * it describes.
 *
 * This is the tier the other two are defined against. A chip does not expire,
 * so it can carry something the user needs later — which is exactly why the
 * completion toast is allowed to be transient. And a chip does not displace the
 * page, so a condition that is merely true rather than in the way never gets
 * to push the workbench down; that is the difference between "this batch was
 * never saved" and "this project failed to load".
 *
 * `role="status"` throughout, including for the failure tone. These chips
 * describe a state the user is looking at, not an event that just interrupted
 * them; `alert` is reserved for the banner, which is where an interruption
 * belongs.
 */
export function StatusChip({ tone, label, detail, actions = [] }: StatusChipProps) {
  return (
    <p className={`${styles.chip} ${styles[tone]}`} role="status">
      <strong className={styles.label}>{label}</strong>
      {detail && <span className={styles.detail}>{detail}</span>}
      {actions.map((action) => (
        <button
          className="text-button"
          key={action.key}
          type="button"
          onClick={action.onSelect}
        >
          {action.label}
        </button>
      ))}
    </p>
  );
}
