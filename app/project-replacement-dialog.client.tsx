"use client";

import { useEffect } from "react";

import type { PendingProjectReplacement } from "./use-project-workspace.client";

export function ProjectReplacementDialog({
  replacement,
  onCancel,
  onDiscard,
  onSave,
}: {
  replacement: PendingProjectReplacement;
  onCancel(): void;
  onDiscard(): void;
  onSave(): void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !replacement.saving) onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onCancel, replacement.saving]);

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        aria-labelledby="project-replacement-title"
        aria-modal="true"
        className="confirmation-dialog"
        role="dialog"
      >
        <span className="eyebrow">Unsaved project</span>
        <h2 id="project-replacement-title">
          Save changes before switching projects?
        </h2>
        <p>
          Switching without saving will permanently discard the current
          project&apos;s unsaved changes.
        </p>
        <dl className="confirmation-details">
          <div>
            <dt>Current project</dt>
            <dd>{replacement.currentProjectName}</dd>
          </div>
          <div>
            <dt>Switching to</dt>
            <dd>{replacement.nextProjectName}</dd>
          </div>
        </dl>
        {replacement.error && (
          <p className="project-replacement-error" role="alert">
            {replacement.error} The current project is still open.
          </p>
        )}
        <div className="confirmation-actions">
          <button
            autoFocus
            className="button secondary"
            disabled={replacement.saving}
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="button stop"
            disabled={replacement.saving}
            type="button"
            onClick={onDiscard}
          >
            Discard and switch
          </button>
          <button
            className="button primary"
            disabled={replacement.saving}
            type="button"
            onClick={onSave}
          >
            {replacement.saving ? "Saving…" : "Save and switch"}
          </button>
        </div>
      </section>
    </div>
  );
}
