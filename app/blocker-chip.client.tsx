"use client";

import { useId, useState, type ReactNode } from "react";
import styles from "./blocker-chip.module.css";

export interface BlockerChipAction {
  key: string;
  label: string;
  /** The action that resolves the chip. Rendered inline, always visible. */
  primary?: boolean;
  onSelect(): void;
}

export interface BlockerChipFact {
  label: string;
  value: string;
}

/**
 * How many conditions the chip stands for, in this surface's words. Compose
 * counts blockers; the evaluation surface counts setup issues, because that is
 * what its authors already call them.
 */
export interface BlockerChipNoun {
  one: string;
  many: string;
}

export interface BlockerChipProps {
  /** Names the region for assistive technology. */
  label: string;
  /**
   * `blocked` refuses the mode's primary action, `advisory` is a note the user
   * may ignore, `ready` states that nothing is in the way.
   */
  tone: "blocked" | "advisory" | "ready";
  /** The always-visible line: the condition, in one sentence. */
  summary: string;
  /**
   * Id for the summary line, so a disabled primary action elsewhere on the page
   * can point at the text that says why it is disabled.
   */
  summaryId?: string;
  /** Every condition this chip stands for. `summary` is the first of them. */
  issues?: readonly string[];
  noun?: BlockerChipNoun;
  /** What to do about it, in prose. */
  detail?: string;
  /** Why the rule exists — met once, so it never leads. */
  explanation?: string;
  facts?: readonly BlockerChipFact[];
  actions?: readonly BlockerChipAction[];
  /**
   * Announce the chip assertively rather than politely.
   *
   * Off by default, and deliberately so. A surface whose blockers change as the
   * user types — the evaluation editor recomputes preflight on every check
   * edit — would interrupt a screen reader on each keystroke if this were an
   * `alert`. Reserve it for a state the user arrives at rather than authors
   * through, such as a run refused the moment a project is opened.
   */
  assertive?: boolean;
  /** Surface-specific matter that must stay visible, such as a plan summary. */
  children?: ReactNode;
}

const defaultNoun: BlockerChipNoun = { one: "blocker", many: "blockers" };
const adviceNoun: BlockerChipNoun = { one: "note", many: "notes" };

/**
 * One compact line stating why a primary action is refused, with its fix inline
 * and the rest behind a disclosure.
 *
 * The invariant this component exists to hold: **a blocked primary action
 * states its reason in visible text.** The reason is the summary line and the
 * fix is the inline action's own label, so both are readable at 100% zoom with
 * no pointer and no expansion. Everything that explains rather than resolves —
 * the prose detail, the rule behind it, the supporting facts, the second and
 * later conditions — is held behind `Details`, which is what keeps this a chip
 * rather than the standing banner it replaces.
 *
 * A native `title` is deliberately not used for any of it: a tooltip is
 * invisible to touch and unreachable from the keyboard.
 */
export function BlockerChip({
  label,
  tone,
  summary,
  summaryId,
  issues = [],
  noun,
  detail,
  explanation,
  facts = [],
  actions = [],
  assertive = false,
  children,
}: BlockerChipProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const count = Math.max(issues.length, tone === "ready" ? 0 : 1);
  const words = noun ?? (tone === "advisory" ? adviceNoun : defaultNoun);
  const rest = issues.slice(1);
  const primary = actions.find((action) => action.primary);
  const secondary = actions.filter((action) => action !== primary);
  const expandable = Boolean(
    detail || explanation || rest.length > 0 || facts.length > 0 || secondary.length > 0,
  );
  return (
    <div
      aria-label={label}
      className={`${styles.chip} ${styles[tone]}`}
      role={assertive && tone === "blocked" ? "alert" : "status"}
    >
      <div className={styles.line}>
        <span className={styles.glyph} aria-hidden="true">
          {tone === "blocked" ? "!" : tone === "ready" ? "✓" : <span className="info-mark-glyph">i</span>}
        </span>
        {count > 0 && (
          <strong className={styles.count}>
            {count} {count === 1 ? words.one : words.many}
          </strong>
        )}
        <span className={styles.summary} {...(summaryId ? { id: summaryId } : {})}>
          {summary}
        </span>
        {children}
        <span className={styles.spacer} />
        {primary && (
          <button className="button primary" type="button" onClick={primary.onSelect}>
            {primary.label}
          </button>
        )}
        {expandable && (
          <button
            aria-controls={open ? bodyId : undefined}
            aria-expanded={open}
            className={styles.toggle}
            type="button"
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide details" : "Details"}
          </button>
        )}
      </div>
      {open && expandable && (
        <div className={styles.body} id={bodyId}>
          {detail && <p className={styles.detail}>{detail}</p>}
          {rest.length > 0 && (
            <ul className={styles.issues}>
              {rest.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          {explanation && <p className={styles.explanation}>{explanation}</p>}
          {facts.length > 0 && (
            <dl className={styles.facts}>
              {facts.map((fact) => (
                <div key={`${fact.label}-${fact.value}`}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {secondary.length > 0 && (
            <div className={styles.actions}>
              {secondary.map((action) => (
                <button
                  className="button secondary"
                  key={action.key}
                  type="button"
                  onClick={action.onSelect}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
