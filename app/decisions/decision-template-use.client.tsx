"use client";

import { useEffect, useRef, useState } from "react";
import { diffDecisionPromptTemplateRevisions } from "../../packages/core/src/decision-template-revision-diff";
import { discoverDecisionVariables } from "../../packages/core/src/decision-variables";
import type { DecisionPromptTemplate, DecisionPromptTemplateRevision } from "../../packages/core/src/project";
import type { PromptTemplateRevisionId } from "../../packages/core/src/run-kernel";
import { DecisionRevisionDiff } from "../templates/decision-revision-diff.client";
import { promptRevisionLabel } from "../templates/prompt-revision-label";

export interface DecisionTemplateRecommendation {
  model: string;
  connectionName: string;
  compatibleConnectionNames: string[];
  matchesSelectedTarget: boolean;
}

function recommendationText(recommendation: DecisionTemplateRecommendation): string {
  if (recommendation.matchesSelectedTarget) return "The selected target matches.";
  if (recommendation.compatibleConnectionNames.length === 0) {
    return `No System One connection on this device matches ${recommendation.connectionName}.`;
  }
  return `Available on ${recommendation.compatibleConnectionNames.join(", ")}. Choose it in Target to use the recommendation.`;
}

/** The pinned source of a template-backed decision request in Compose. */
export function DecisionTemplateUse({
  template,
  revisionId,
  locked,
  recommendation,
  onEdit,
  onUpdate,
  onDetach,
}: {
  template: DecisionPromptTemplate;
  revisionId: PromptTemplateRevisionId;
  locked: boolean;
  recommendation?: DecisionTemplateRecommendation;
  onEdit(): void;
  onUpdate(): void;
  onDetach(): void;
}) {
  const [review, setReview] = useState(false);
  const updateAction = useRef<HTMLButtonElement>(null);
  const pinned = template.revisions.find(({ id }) => id === revisionId)!;
  const latest = template.revisions.find(({ id }) => id === template.currentRevisionId)!;

  function closeReview(): void {
    setReview(false);
    updateAction.current?.focus();
  }

  return (
    <section className="decision-template-use" aria-label="Saved decision prompt">
      <strong>{template.name}</strong>
      <span>
        {" · "}
        {promptRevisionLabel(template, revisionId)}
        {template.archivedAt ? " · Archived" : ""}
      </span>
      {recommendation && (
        <p>
          Recommended target: {recommendation.connectionName} · {recommendation.model}.{" "}
          {recommendationText(recommendation)}
        </p>
      )}
      <p>Content is pinned. Values below remain editable.</p>
      <div className="decision-row-actions">
        <button className="text-button" disabled={locked} type="button" onClick={onEdit}>
          Edit source
        </button>
        {latest.id !== pinned.id && (
          <button
            className="text-button"
            disabled={locked || Boolean(template.archivedAt)}
            ref={updateAction}
            type="button"
            onClick={() => setReview(true)}
          >
            Update to latest revision…
          </button>
        )}
        <button className="text-button" disabled={locked} type="button" onClick={onDetach}>
          Detach
        </button>
      </div>
      {review && (
        <DecisionUpdateReview
          template={template}
          pinned={pinned}
          latest={latest}
          locked={locked}
          onCancel={closeReview}
          onConfirm={() => {
            setReview(false);
            onUpdate();
          }}
        />
      )}
    </section>
  );
}

function DecisionUpdateReview({
  template,
  pinned,
  latest,
  locked,
  onCancel,
  onConfirm,
}: {
  template: DecisionPromptTemplate;
  pinned: DecisionPromptTemplateRevision;
  latest: DecisionPromptTemplateRevision;
  locked: boolean;
  onCancel(): void;
  onConfirm(): void;
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

  const variables = discoverDecisionVariables(latest.decision).variables;
  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        aria-label="Update decision prompt"
        aria-modal="true"
        className="confirmation-dialog decision-update-dialog"
        ref={dialog}
        role="dialog"
      >
        <h2>Update decision prompt</h2>
        <p>
          {promptRevisionLabel(template, pinned.id)} → {promptRevisionLabel(template, latest.id)}. Overrides for
          surviving variables are retained; obsolete overrides are removed. Newly required values must be filled
          before running.
        </p>
        <DecisionRevisionDiff diff={diffDecisionPromptTemplateRevisions(pinned, latest)} />
        <p>Variables in the new revision: {variables.join(", ") || "None"}</p>
        <div className="confirmation-actions">
          <button className="button secondary" ref={cancel} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="button primary" disabled={locked} type="button" onClick={onConfirm}>
            Update revision
          </button>
        </div>
      </section>
    </div>
  );
}
