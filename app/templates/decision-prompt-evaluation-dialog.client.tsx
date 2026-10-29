"use client";

import { useEffect, useRef, useState } from "react";
import type { DecisionTemplateEvaluationRetargetPreview } from "../../packages/core/src/decision-template-evaluation";
import { diffDecisionPromptTemplateRevisions } from "../../packages/core/src/decision-template-revision-diff";
import type { DecisionPromptTemplate } from "../../packages/core/src/project";
import type { EvaluationSuiteId, PromptTemplateId, PromptTemplateRevisionId } from "../../packages/core/src/run-kernel";
import type { CompatibleEvaluationSuite } from "./chat-prompt-template-editor.client";
import { DecisionRevisionDiff } from "./decision-revision-diff.client";
import { promptRevisionLabel } from "./prompt-revision-label";
import { ModalDialog } from "../modal-dialog.client";

export interface DecisionPromptEvaluationActions {
  evaluationSuites?: readonly CompatibleEvaluationSuite[];
  onPreviewEvaluation?(templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId, suiteId: EvaluationSuiteId): DecisionTemplateEvaluationRetargetPreview;
  onEvaluateRevision?(templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId, suiteId?: EvaluationSuiteId): boolean;
  onOpenEvaluationSuite?(suiteId: EvaluationSuiteId): void;
  evaluateRevisionError?: string;
  onDismissEvaluateRevisionError?(): void;
}

/** Review before moving a suite's pin; cases, checks, targets and saved results keep their owners. */
export function DecisionPromptEvaluationDialog({
  template, revisionId, onClose, evaluationSuites = [], onPreviewEvaluation,
  onEvaluateRevision, onOpenEvaluationSuite, evaluateRevisionError,
}: DecisionPromptEvaluationActions & {
  template: DecisionPromptTemplate;
  revisionId: PromptTemplateRevisionId;
  onClose(): void;
}) {
  const [review, setReview] = useState<{ entry: CompatibleEvaluationSuite; preview: DecisionTemplateEvaluationRetargetPreview }>();
  const [error, setError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  // Focus moves only when the dialog opens or switches to the review step.
  useEffect(() => { cancel.current?.focus(); }, [review]);

  const target = template.revisions.find(({ id }) => id === revisionId)!;
  const pinned = review && template.revisions.find(({ id }) => id === review.entry.pinnedRevisionId);
  function evaluate(suiteId?: EvaluationSuiteId) {
    if (onEvaluateRevision?.(template.id, revisionId, suiteId)) onClose();
  }
  return (
    <ModalDialog className="confirmation-dialog" label="Evaluate decision revision" onClose={onClose}>
      <h2>{review ? "Review suite retarget" : "Evaluate decision revision"}</h2>
      <p>{template.name} · {promptRevisionLabel(template, revisionId)}. Compose keeps its current request. Nothing runs until you start the evaluation.</p>
      {(error || evaluateRevisionError) && <p className="template-diagnostic" role="alert">{error ?? evaluateRevisionError}</p>}
      {review ? <>
        <p><strong>{review.entry.suite.name}</strong> will move from {promptRevisionLabel(template, review.entry.pinnedRevisionId)} to {promptRevisionLabel(template, revisionId)}. Cases, checks, configurations and target are retained. Saved results keep their original input.</p>
        {review.preview.changes.length > 0 && <ul>{review.preview.changes.map((change) => <li key={change}>{change}</li>)}</ul>}
        {review.preview.diagnostics.length > 0 ? <div className="template-warning" role="status">
          <strong>This retarget leaves inputs or checks to repair before running:</strong>
          <ul>{review.preview.diagnostics.map(({ message }, index) => <li key={index}>{message}</li>)}</ul>
        </div> : <p>This retarget introduces no incompatible inputs or checks.</p>}
        {review.preview.existingDiagnostics.length > 0 && <details className="template-revision-diff">
          <summary>Already needs repair ({review.preview.existingDiagnostics.length}), unchanged by this retarget</summary>
          <ul>{review.preview.existingDiagnostics.map(({ message }, index) => <li key={index}>{message}</li>)}</ul>
        </details>}
        {pinned && <details className="template-revision-diff"><summary>Revision changes</summary><DecisionRevisionDiff diff={diffDecisionPromptTemplateRevisions(pinned, target)} /></details>}
        <div className="confirmation-actions">
          <button className="button secondary" type="button" ref={cancel} onClick={onClose}>Cancel</button>
          <button className="button primary" type="button" onClick={() => evaluate(review.entry.suite.id)}>Retarget suite</button>
        </div>
      </> : <>
        <p>Create a new decision suite, then choose its connection and model in Setup. Or open a suite using this prompt and review any revision change.</p>
        {evaluationSuites.length > 0 && <div className="confirmation-dialog-suite-rows">
          {evaluationSuites.map((entry) => <div className="confirmation-dialog-suite-row" key={entry.suite.id}>
            <span><strong>{entry.suite.name}</strong> — {entry.pinnedRevisionId === revisionId ? "already pinned to this revision" : `currently ${promptRevisionLabel(template, entry.pinnedRevisionId)} → will pin ${promptRevisionLabel(template, revisionId)}`}</span>
            <button className="button secondary" type="button" onClick={() => {
              if (entry.pinnedRevisionId === revisionId) { onOpenEvaluationSuite?.(entry.suite.id); onClose(); return; }
              try {
                const preview = onPreviewEvaluation?.(template.id, revisionId, entry.suite.id);
                if (!preview) throw new Error("The suite review is unavailable. Reopen the project and try again.");
                setError(undefined); setReview({ entry, preview });
              } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not review this suite."); }
            }}>{entry.pinnedRevisionId === revisionId ? "Open" : `Review ${entry.suite.name}…`}</button>
          </div>)}
        </div>}
        <div className="confirmation-actions">
          <button className="button secondary" type="button" ref={cancel} onClick={onClose}>Cancel</button>
          <button className="button primary" type="button" onClick={() => evaluate()}>Create new suite</button>
        </div>
      </>}
    </ModalDialog>
  );
}
