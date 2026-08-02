"use client";

import { useEffect } from "react";

import type { EvaluationExecutionDraft } from "./use-evaluation-execution-session.client.ts";
import { LARGE_EVALUATION_BATCH_WARNING_THRESHOLD } from "./evaluation-batch.client.ts";

function caseSummary(draft: EvaluationExecutionDraft): string {
  const names = draft.plan.suite.cases.map(({ name }) => name);
  const visible = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${visible}, and ${names.length - 5} more` : visible;
}

export function EvaluationStartDialog({
  draft,
  onCancel,
  onConfirm,
}: {
  draft: EvaluationExecutionDraft;
  onCancel(): void;
  onConfirm(): void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel]);

  const target = draft.plan.suite.cases[0]!.input.target;
  const callCount = draft.plan.cells.length;
  return (
    <div className="confirmation-backdrop" role="presentation">
      <section aria-labelledby="evaluation-start-title" aria-modal="true" className="confirmation-dialog evaluation-start-dialog" role="dialog">
        <span className="eyebrow">Evaluation confirmation</span>
        <h2 id="evaluation-start-title">Start “{draft.plan.suite.name}”?</h2>
        <p>Each selected case is resolved from the frozen project revision and runs sequentially. Composer-only values are not included.</p>
        <dl className="confirmation-details evaluation-start-details">
          <div><dt>Revision</dt><dd>{new Date(draft.revisionCreatedAt).toLocaleString()} <code>{draft.plan.suite.conversationRevisionId}</code></dd></div>
          <div><dt>Target</dt><dd>{draft.targetName} · {target.model}</dd></div>
          <div><dt>Cases</dt><dd>{draft.plan.suite.cases.length} · {caseSummary(draft)}</dd></div>
          <div><dt>Repetitions</dt><dd>{draft.plan.repetitions} per case</dd></div>
          <div><dt>Provider calls</dt><dd>{callCount.toLocaleString()} planned</dd></div>
          <div><dt>Evidence</dt><dd>{draft.storage === "durable" ? "Saved to the open project folder" : "Session only — lost when this session closes"}</dd></div>
        </dl>
        {callCount >= LARGE_EVALUATION_BATCH_WARNING_THRESHOLD && <p className="evaluation-batch-warning" role="alert"><strong>Large evaluation batch.</strong> This will make {callCount.toLocaleString()} sequential provider calls. The batch size will not be adjusted.</p>}
        <div className="confirmation-actions">
          <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="button primary" type="button" onClick={onConfirm}>Start {callCount.toLocaleString()} calls</button>
        </div>
      </section>
    </div>
  );
}
