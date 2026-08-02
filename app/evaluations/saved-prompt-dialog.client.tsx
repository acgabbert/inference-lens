"use client";

import { useEffect, useState } from "react";

import type { SavedPromptCandidate } from "../../packages/core/src/evaluation-suite-authoring";
import { revisionTime } from "./revision-choice.client";

function roleSequence(roles: SavedPromptCandidate["roles"]): string {
  return roles.join(" → ");
}

function PromptDetails({ candidate }: { candidate: SavedPromptCandidate }) {
  return (
    <dl className="saved-prompt-details">
      <div>
        <dt>Messages</dt>
        <dd>
          {candidate.messageCount} · {roleSequence(candidate.roles)}
        </dd>
      </div>
      <div>
        <dt>Current revision</dt>
        <dd>
          <code>{candidate.currentRevisionId}</code> · {revisionTime(candidate.revisionCreatedAt)}
        </dd>
      </div>
      <div>
        <dt>Variables</dt>
        <dd>
          {candidate.variables.length === 0
            ? "None"
            : candidate.variables
                .map(({ name, hasDefault }) => `${name}${hasDefault ? " (has default)" : ""}`)
                .join(", ")}
        </dd>
      </div>
      {candidate.recommendedTarget && (
        <div>
          <dt>Recommended target</dt>
          <dd>
            {candidate.recommendedTarget.connectionName} · {candidate.recommendedTarget.model}{" "}
            <span className="saved-prompt-advisory">Advisory — the evaluation target is unchanged.</span>
          </dd>
        </div>
      )}
    </dl>
  );
}

export function SavedPromptDialog({
  candidates,
  hasExistingBindings,
  error,
  onCancel,
  onConfirm,
  onOpenTemplates,
}: {
  candidates: readonly SavedPromptCandidate[];
  hasExistingBindings: boolean;
  error?: string;
  onCancel(): void;
  onConfirm(templateId: SavedPromptCandidate["templateId"]): void;
  onOpenTemplates?(): void;
}) {
  const [selectedId, setSelectedId] = useState(candidates[0]?.templateId);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Capture phase, then stop propagation: this dialog can be layered over the
    // evaluation editor's focus mode, which also closes on Escape.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onCancel]);

  const selected = candidates.find(({ templateId }) => templateId === selectedId);

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        aria-labelledby="saved-prompt-title"
        aria-modal="true"
        className="confirmation-dialog saved-prompt-dialog"
        role="dialog"
      >
        <span className="eyebrow">Evaluation input</span>
        <h2 id="saved-prompt-title">Start from saved prompt</h2>
        {candidates.length === 0 ? (
          <>
            <p>
              This project has no active saved prompts. Create one in the Templates editor, then
              start an evaluation from it.
            </p>
            <div className="confirmation-actions">
              <button className="button secondary" type="button" onClick={onCancel}>
                Cancel
              </button>
              {onOpenTemplates && (
                <button className="button primary" type="button" onClick={onOpenTemplates}>
                  Open Templates
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p>
              This creates a new conversation revision containing one pinned use of the prompt’s
              current revision, and selects it for this evaluation. Surrounding messages are not
              copied; add them afterwards in Messages.
            </p>
            <fieldset className="saved-prompt-list">
              <legend>Active saved prompts</legend>
              {candidates.map((candidate) => (
                <label
                  className={
                    candidate.templateId === selectedId
                      ? "saved-prompt-option selected"
                      : "saved-prompt-option"
                  }
                  key={candidate.templateId}
                >
                  <input
                    checked={candidate.templateId === selectedId}
                    name="saved-prompt"
                    onChange={() => setSelectedId(candidate.templateId)}
                    type="radio"
                    value={candidate.templateId}
                  />
                  <strong>{candidate.name}</strong>
                </label>
              ))}
            </fieldset>
            {selected && <PromptDetails candidate={selected} />}
            {hasExistingBindings && (
              <p className="evaluation-batch-warning" role="status">
                <strong>This suite already has case inputs.</strong> The new template use gets a new
                stable ID, so existing bindings may not match the new revision. They are not
                rewritten — rebind them after creating it.
              </p>
            )}
            {error && (
              <p className="evaluation-field-error" role="alert">
                {error}
              </p>
            )}
            <div className="confirmation-actions">
              <button className="button secondary" type="button" onClick={onCancel}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={!selected}
                type="button"
                onClick={() => selected && onConfirm(selected.templateId)}
              >
                Create revision &amp; select
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
