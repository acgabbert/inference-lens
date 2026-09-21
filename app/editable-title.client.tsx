"use client";

import { useState } from "react";

import styles from "./editable-title.module.css";

/**
 * Drawn rather than typed for the same reason as the disclosure chevron: a
 * glyph's ink sits wherever its font puts it, which a small square button
 * exposes as off-centre.
 */
function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" fill="none">
      <path
        d="M8.2 1.8l2 2M1.5 10.5l.6-2.2 6.1-6.1a1 1 0 011.4 0l.8.8a1 1 0 010 1.4l-6.1 6.1-2.2.6z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" fill="none">
      <path d="M2.5 6.4l2.4 2.4 4.6-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" fill="none">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export interface EditableTitleProps {
  /** The committed name. Also what a discard restores the draft to. */
  value: string;
  /**
   * What the name names — "Case name", "Suite name". Used verbatim as the
   * input's accessible name, and as the tail of every control's label, so two
   * open editors on one screen never present the same button twice.
   */
  label: string;
  /** Display element for the committed name. Callers own the eyebrow beside it. */
  heading?: "h2" | "h3";
  readOnly?: boolean;
  /**
   * Applies the edit. `false` means the name was rejected — the editor stays
   * open with the draft the author typed rather than discarding their work,
   * and the caller renders the reason. Owners already return this shape.
   */
  onCommit(name: string): boolean;
}

/**
 * A title that edits in place: the committed name with a pencil beside it,
 * swapping for an input and save/discard when the pencil is pressed.
 *
 * The alternative — a heading with a permanently visible name field under it —
 * spends a label, a field, and a row of vertical space to restate what the
 * heading already says. Editing is the rare act; reading the name is the
 * common one, so only reading gets standing space.
 *
 * Editing is local state, so callers whose title can change identity underneath
 * the component (a rail that switches the focused record) must key it by that
 * identity, or a half-typed draft would carry across to a different record.
 */
export function EditableTitle({ value, label, heading = "h3", readOnly, onCommit }: EditableTitleProps) {
  // `undefined` is the display state; any string means the editor is open,
  // including "" — the two are distinct and a boolean flag would lose that.
  const [draft, setDraft] = useState<string>();
  const [rejected, setRejected] = useState(false);
  const Heading = heading;
  const box = `${styles.title} ${styles[heading]}`;

  const close = () => { setDraft(undefined); setRejected(false); };

  const commit = () => {
    if (draft === undefined) return;
    // An unchanged name is not a mutation: committing it would ask the owner to
    // re-validate a name it already holds, which can only produce a spurious
    // error on the way out of an editor the author is merely leaving.
    if (draft === value) { close(); return; }
    if (onCommit(draft)) close();
    else setRejected(true);
  };

  if (draft === undefined) {
    return (
      <div className={box}>
        <Heading className={styles.heading}>{value}</Heading>
        {!readOnly && (
          <button
            aria-label={`Edit ${label.toLowerCase()}`}
            className={styles.edit}
            type="button"
            onClick={() => setDraft(value)}
          >
            <PencilIcon />
          </button>
        )}
      </div>
    );
  }

  return (
    <form
      className={box}
      onSubmit={(event) => { event.preventDefault(); commit(); }}
      // Leaving the editor commits, the way the standing field it replaces
      // did. Focus moving between this form's own controls is not leaving:
      // without the containment check, tabbing to Discard would save the very
      // draft that button exists to throw away.
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        commit();
      }}
    >
      <input
        aria-invalid={rejected || undefined}
        aria-label={label}
        autoFocus
        className={styles.input}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setRejected(false); }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Escape discards without leaving the field first, so it must not
          // reach a dialog or drawer above and close that instead.
          event.stopPropagation();
          close();
        }}
      />
      <button aria-label={`Save ${label.toLowerCase()}`} className={styles.action} type="submit">
        <CheckIcon />
      </button>
      <button
        aria-label={`Discard ${label.toLowerCase()} change`}
        className={styles.action}
        type="button"
        // Pressing a button blurs the input first, and a blur commits. Holding
        // focus in the field is what keeps this button's own meaning.
        onMouseDown={(event) => event.preventDefault()}
        onClick={close}
      >
        <CrossIcon />
      </button>
    </form>
  );
}
