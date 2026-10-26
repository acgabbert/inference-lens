"use client";

import { useState } from "react";
import { diffDecisionPromptTemplateRevisions } from "../../packages/core/src/decision-template-revision-diff";
import type { DecisionPromptTemplate } from "../../packages/core/src/project";
import type { PromptTemplateRevisionId } from "../../packages/core/src/run-kernel";
import { discoverDecisionVariables } from "../../packages/core/src/decision-variables";
import { promptRevisionLabel } from "../templates/prompt-revision-label";
import { DecisionRevisionDiff } from "../templates/decision-revision-diff.client";

export function DecisionTemplateUse({ template, revisionId, locked, recommendation, onEdit, onUpdate, onDetach }: {
  template: DecisionPromptTemplate; revisionId: PromptTemplateRevisionId; locked: boolean;
  recommendation?: { model: string; connectionName: string; compatibleConnectionNames: string[]; matchesSelectedTarget: boolean };
  onEdit(): void; onUpdate(): void; onDetach(): void;
}) {
  const [review, setReview] = useState(false);
  const pinned = template.revisions.find(({ id }) => id === revisionId)!;
  const latest = template.revisions.find(({ id }) => id === template.currentRevisionId)!;
  return <section className="decision-template-use" aria-label="Saved decision prompt">
    <strong>{template.name}</strong><span> · {promptRevisionLabel(template, revisionId)}{template.archivedAt ? " · Archived" : ""}</span>
    {recommendation && <p>Recommended target: {recommendation.connectionName} · {recommendation.model}. {recommendation.matchesSelectedTarget
      ? "The selected target matches."
      : recommendation.compatibleConnectionNames.length === 0
        ? `No System One connection on this device matches ${recommendation.connectionName}.`
        : `Available on ${recommendation.compatibleConnectionNames.join(", ")}. Choose it in Target to use the recommendation.`}</p>}
    <p>Content is pinned. Values below remain editable.</p>
    <div className="decision-row-actions">
      <button className="text-button" disabled={locked} type="button" onClick={onEdit}>Edit source</button>
      {latest.id !== pinned.id && <button className="text-button" disabled={locked || Boolean(template.archivedAt)} type="button" onClick={() => setReview(true)}>Update to latest revision…</button>}
      <button className="text-button" disabled={locked} type="button" onClick={onDetach}>Detach</button>
    </div>
    {review && <div className="confirmation-backdrop" role="presentation"><section className="confirmation-dialog decision-update-dialog" role="dialog" aria-label="Update decision prompt" aria-modal="true">
      <h2>Update decision prompt</h2><p>{promptRevisionLabel(template, pinned.id)} → {promptRevisionLabel(template, latest.id)}. Overrides for surviving variables are retained; obsolete overrides are removed. Newly required values must be filled before running.</p>
      <DecisionRevisionDiff diff={diffDecisionPromptTemplateRevisions(pinned, latest)} />
      <p>Variables in the new revision: {discoverDecisionVariables(latest.decision).variables.join(", ") || "None"}</p>
      <div className="confirmation-actions"><button className="button secondary" type="button" onClick={() => setReview(false)}>Cancel</button><button className="button primary" disabled={locked} type="button" onClick={() => { setReview(false); onUpdate(); }}>Update revision</button></div>
    </section></div>}
  </section>;
}
