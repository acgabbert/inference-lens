"use client";

import { useEffect, useRef, type ReactNode, type Ref } from "react";
import type { PromptTemplate } from "../../packages/core/src/project";
import type { PromptTemplateRevisionId } from "../../packages/core/src/run-kernel";
import { promptRevisionLabel, type RevisionVariableChanges } from "./prompt-revision-label";

/** Chooses which revision a pinned use in Compose points at; newest first. */
export function PinnedRevisionSelect({
  template,
  revisionId,
  disabled,
  selectRef,
  onSelect,
}: {
  template: PromptTemplate;
  revisionId: PromptTemplateRevisionId;
  disabled: boolean;
  /** Where focus returns when a switch review is cancelled. */
  selectRef?: Ref<HTMLSelectElement>;
  onSelect(revisionId: PromptTemplateRevisionId): void;
}) {
  return (
    <select
      aria-label="Pinned revision"
      ref={selectRef}
      className="pinned-revision-select"
      disabled={disabled}
      value={revisionId}
      onChange={(event) => onSelect(event.target.value as PromptTemplateRevisionId)}
    >
      {[...template.revisions].reverse().map((revision) => (
        <option key={revision.id} value={revision.id}>
          {promptRevisionLabel(template, revision.id)}
        </option>
      ))}
    </select>
  );
}

function variableList(names: readonly string[]): string {
  return names.map((name) => `{{${name}}}`).join(", ");
}

/**
 * Confirms moving a pinned use to another revision. Variable consequences
 * lead because they are what a switch can lose; the content diff stays
 * collapsed behind its one-line summary so long prompts do not bury them.
 */
export function RevisionSwitchReview({
  title,
  fromLabel,
  toLabel,
  changes,
  diffSummary,
  locked,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  fromLabel: string;
  toLabel: string;
  changes: RevisionVariableChanges;
  diffSummary: string;
  locked: boolean;
  onCancel(): void;
  onConfirm(): void;
  /** The full content diff, shown only on request. */
  children: ReactNode;
}) {
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialog.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), select:not([disabled]), input:not([disabled]), summary",
      );
      if (!focusable?.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  const rows = [
    { label: "Values cleared", names: changes.cleared, warning: true },
    { label: "Needs a value", names: changes.needsValue, warning: true },
    { label: "Added", names: changes.added, warning: false },
    { label: "Removed", names: changes.removed, warning: false },
  ].filter(({ names }) => names.length > 0);

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        aria-label={title}
        aria-modal="true"
        className="confirmation-dialog revision-switch-dialog"
        ref={dialog}
        role="dialog"
      >
        <span className="eyebrow">Switch revision</span>
        <h2>{title}</h2>
        <p>
          {fromLabel} → {toLabel}
        </p>
        <section aria-label="Variable changes" className="revision-switch-variables">
          {rows.length === 0 ? (
            <p>Variables and their values carry over unchanged.</p>
          ) : (
            <dl>
              {rows.map(({ label, names, warning }) => (
                <div className={warning ? "warning" : undefined} key={label}>
                  <dt>{label}</dt>
                  <dd>{variableList(names)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
        {diffSummary === "identical" ? (
          <p>Content is identical.</p>
        ) : (
          <details className="revision-switch-diff">
            <summary>Content changes · {diffSummary}</summary>
            {children}
          </details>
        )}
        <div className="confirmation-actions">
          <button className="button secondary" ref={cancel} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="button primary" disabled={locked} type="button" onClick={onConfirm}>
            Switch revision
          </button>
        </div>
      </section>
    </div>
  );
}
