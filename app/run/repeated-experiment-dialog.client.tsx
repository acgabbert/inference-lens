"use client";

import { useEffect } from "react";

import type { RepeatedExperimentDraft } from "./use-repeated-experiment-session.client.ts";
import { MAX_REPETITION_COUNT, MIN_REPETITION_COUNT } from "./use-repeated-experiment-session.client.ts";

export function RepeatedExperimentDialog({
  draft,
  onCountChange,
  onCancel,
  onConfirm,
}: {
  draft: RepeatedExperimentDraft;
  onCountChange(count: number): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section aria-labelledby="repeat-experiment-title" aria-modal="true" className="confirmation-dialog repeated-experiment-dialog" role="dialog">
        <span className="eyebrow">Repeated experiment</span>
        <h2 id="repeat-experiment-title">Run this frozen request repeatedly</h2>
        <p>Each repetition is a new ordinary run. Results execute one at a time, in order.</p>
        <dl className="confirmation-details repeat-experiment-details">
          <div><dt>Frozen request</dt><dd>{draft.requestSummary}</dd></div>
          <div><dt>Target</dt><dd>{draft.targetName} · {draft.plan.commonInput.target.model}</dd></div>
          <div><dt>Endpoint</dt><dd><code>{draft.plan.commonInput.target.endpoint}</code></dd></div>
        </dl>
        <label className="project-creation-name">
          <span>Repetitions</span>
          <input
            aria-label="Repetitions"
            min={MIN_REPETITION_COUNT}
            max={MAX_REPETITION_COUNT}
            type="number"
            value={draft.repetitionCount}
            onChange={(event) => onCountChange(Number(event.target.value))}
          />
          <small>Runs sequentially; the next starts only after the previous repetition is terminal.</small>
        </label>
        <p className="repeat-experiment-call-count"><strong>Minimum provider calls: {draft.repetitionCount}</strong> — one per repetition.</p>
        <div className="confirmation-actions">
          <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="button primary" type="button" onClick={onConfirm}>Start {draft.repetitionCount} repetitions</button>
        </div>
      </section>
    </div>
  );
}
