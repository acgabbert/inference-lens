"use client";

import { ModalDialog } from "./modal-dialog.client";
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
  return (
    <ModalDialog
      className="confirmation-dialog"
      labelledBy="project-replacement-title"
      onClose={() => {
        if (!replacement.saving) onCancel();
      }}
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
    </ModalDialog>
  );
}
