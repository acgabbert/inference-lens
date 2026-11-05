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
  // Only a save that chooses a folder carries session drafts with it (S2).
  const saveKeepsWork = replacement.sessionOnlyWork === 0 || replacement.saveNeedsLocation;
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
      {replacement.sessionOnlyWork > 0 && (
        <p>
          {replacement.sessionOnlyWork === 1
            ? "1 unsaved draft is held only in this session."
            : `${replacement.sessionOnlyWork} unsaved drafts are held only in this session.`}{" "}
          {saveKeepsWork
            ? `Saving to a folder keeps ${replacement.sessionOnlyWork === 1 ? "it" : "them"} in that folder\u2019s personal workbench.`
            : `Switching discards ${replacement.sessionOnlyWork === 1 ? "it" : "them"}.`}
        </p>
      )}
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
        {saveKeepsWork && (
          <button
            className="button primary"
            disabled={replacement.saving}
            type="button"
            onClick={onSave}
          >
            {replacement.saving ? "Saving…" : "Save and switch"}
          </button>
        )}
      </div>
    </ModalDialog>
  );
}
