"use client";

import { useEffect } from "react";

import { DEFAULT_EXPERIMENT_TURN_CEILING, experimentConnectionKey } from "../../packages/core/src/experiment.ts";
import type { ExperimentConcurrencySetting } from "../../packages/core/src/experiment.ts";
import { ExperimentToolBindingList } from "../run/experiment-tool-binding-list.client.tsx";
import {
  ExperimentConcurrencyFields,
  settingMaxInFlight,
} from "../run/experiment-concurrency.client.tsx";
import type { ExperimentConnectionChoice } from "../run/experiment-concurrency.client.tsx";
import type { EvaluationExecutionDraft } from "./use-evaluation-execution-session.client.ts";
import {
  evaluationBatchGuardrail,
  evaluationCallRange,
} from "./evaluation-batch.client.ts";

function caseSummary(draft: EvaluationExecutionDraft): string {
  const names = draft.plan.suite.cases.map(({ name }) => name);
  const visible = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${visible}, and ${names.length - 5} more` : visible;
}

/** Each distinct connection the suite's configurations use, named by the first that uses it. */
function connectionChoices(draft: EvaluationExecutionDraft): ExperimentConnectionChoice[] {
  const choices = new Map<string, ExperimentConnectionChoice>();
  for (const { variantId, target } of draft.plan.suite.variants) {
    const key = experimentConnectionKey(target);
    if (choices.has(key)) continue;
    choices.set(key, {
      profileId: target.profileId,
      endpoint: target.endpoint,
      label: `${draft.targetNames[variantId] ?? target.profileId} · ${target.endpoint}`,
    });
  }
  return [...choices.values()];
}

export function EvaluationStartDialog({
  draft,
  onConcurrencyChange,
  onCancel,
  onConfirm,
}: {
  draft: EvaluationExecutionDraft;
  onConcurrencyChange(concurrency: ExperimentConcurrencySetting): void;
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

  const targets = draft.plan.suite.variants;
  const callCount = draft.plan.cells.length;
  const turnCeiling = draft.plan.turnCeiling ?? DEFAULT_EXPERIMENT_TURN_CEILING;
  const exposesTools = draft.toolBindings.length > 0;
  const atOnce = settingMaxInFlight(draft.concurrency);
  // "sequential" before the noun, or "up to N at once" after the count.
  const sequential = atOnce > 1 ? "" : "sequential ";
  const overlap = atOnce > 1 ? `, up to ${atOnce} at once` : "";
  // The same arithmetic the start gate applied, rather than a second estimate:
  // the number a person authorizes here is the number that was checked against
  // the safety maximum.
  const guardrail = evaluationBatchGuardrail(
    draft.plan.suite.cases.length,
    draft.plan.suite.variants.length,
    draft.plan.repetitions,
    { exposedToolCount: draft.toolBindings.length, turnCeiling },
  );
  return (
    <div className="confirmation-backdrop" role="presentation">
      <section aria-labelledby="evaluation-start-title" aria-modal="true" className="confirmation-dialog evaluation-start-dialog" role="dialog">
        <span className="eyebrow">Evaluation confirmation</span>
        <h2 id="evaluation-start-title">Start “{draft.plan.suite.name}”?</h2>
        <p>Each selected case is resolved from the frozen project revision and {atOnce > 1 ? <>runs up to {atOnce} at once. Latency measured under concurrent load is not comparable with one-at-a-time runs.</> : "runs sequentially."} Composer-only values are not included.</p>
        <dl className="confirmation-details evaluation-start-details">
          <div><dt>Revision</dt><dd>{draft.revisionLabel} <code>{draft.plan.suite.conversationRevisionId}</code></dd></div>
          <div><dt>Configurations</dt><dd>{targets.map(({ variantId, name, target, responseMode }) => `${name}: ${draft.targetNames[variantId]} · ${target.endpoint} · ${target.model} · ${responseMode}`).join("; ")}</dd></div>
          <div><dt>Cases</dt><dd>{draft.plan.suite.cases.length} · {caseSummary(draft)}</dd></div>
          <div><dt>Repetitions</dt><dd>{draft.plan.repetitions} per case and configuration</dd></div>
          <div><dt>Provider calls</dt><dd>{exposesTools
            ? <>{evaluationCallRange(guardrail)} — one per repetition, up to {turnCeiling} if every repetition keeps calling tools</>
            : <>{callCount.toLocaleString()} planned</>}</dd></div>
          <div className="evaluation-start-concurrency"><dt>Concurrency</dt><dd>
            <ExperimentConcurrencyFields
              connections={connectionChoices(draft)}
              value={draft.concurrency}
              onChange={onConcurrencyChange}
            />
          </dd></div>
          <div><dt>Evidence</dt><dd>{draft.storage === "durable" ? "Saved to the open project folder" : "Session only — lost when this session closes"}</dd></div>
        </dl>
        {exposesTools && <ExperimentToolBindingList toolBindings={draft.toolBindings} />}
        {guardrail.warning && <p className="evaluation-batch-warning" role="alert"><strong>Large evaluation batch.</strong> {exposesTools
          ? <>This will run {callCount.toLocaleString()} {sequential}repetitions{overlap}, up to {guardrail.worstCaseCalls.toLocaleString()} provider calls if every one keeps calling tools.</>
          : <>This will make {callCount.toLocaleString()} {sequential}provider calls{overlap}.</>} The batch size will not be adjusted.</p>}
        <div className="confirmation-actions">
          <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="button primary" type="button" onClick={onConfirm}>Start {exposesTools ? `${callCount.toLocaleString()} repetitions` : `${callCount.toLocaleString()} calls`}</button>
        </div>
      </section>
    </div>
  );
}
