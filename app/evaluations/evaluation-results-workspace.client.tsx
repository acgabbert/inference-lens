"use client";

import { useEffect, useMemo, useState } from "react";

import {
  evaluationParsedExperimentAggregate,
  parseExperimentPlanFile,
} from "../../packages/core/src/experiment.ts";
import type { EvaluationRepetitionClassification } from "../../packages/core/src/experiment.ts";
import type { RunId } from "../../packages/core/src/run-kernel/index.ts";
import { formatTokens } from "../run-metrics-format.client.ts";
import type { EvaluationExecution } from "./use-evaluation-execution-session.client.ts";
import { StatusChip } from "../notifications/status-chip.client";

const classificationLabels: Record<EvaluationRepetitionClassification, string> = {
  passed: "passed",
  "check-failed": "check failed",
  "not-evaluated": "not evaluated",
  "run-failed": "run failed",
  cancelled: "cancelled",
  "not-run": "not run",
  "missing-trace": "trace missing",
};

function elapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function checkMessage(outcome: { status: string; message?: string; reason?: string }): string {
  if (outcome.status === "failed") return outcome.message ?? "Check failed.";
  if (outcome.status === "not-evaluated") return outcome.reason ?? "Check could not be evaluated.";
  return "Passed";
}

export function EvaluationResultsWorkspace({
  execution,
  onStop,
  onOpenTrace,
  placement = "response",
  onReturnToEvaluation,
  onDismiss,
}: {
  execution: EvaluationExecution;
  onStop(): void;
  onOpenTrace(runId: RunId): void;
  placement?: "request" | "response";
  onReturnToEvaluation?(): void;
  /**
   * Hands the response pane back to the suite editor's provider-input preview.
   * Offered only once the batch is finished: a saved evaluation reopens from
   * project history, so this is a navigation, not a discard.
   */
  onDismiss?(): void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const parsedPlan = useMemo(() => {
    const plan = parseExperimentPlanFile(execution.plan);
    if (plan.kind !== "evaluation") throw new Error("Expected an evaluation plan.");
    return plan;
  }, [execution.plan]);
  const aggregate = useMemo(
    () => evaluationParsedExperimentAggregate(parsedPlan, execution.result, execution.states),
    [parsedPlan, execution.result, execution.states],
  );
  const live = execution.result || execution.error ? undefined : execution.live;
  const activeCell = live?.currentOrdinal === undefined
    ? undefined
    : execution.plan.cells.find(({ ordinal }) => ordinal === live.currentOrdinal);
  const activeCase = activeCell
    ? execution.plan.suite.cases.find(({ caseId }) => caseId === activeCell.caseId)
    : undefined;
  const lifecycle = live ? "running" : execution.error ? "interrupted" : aggregate.lifecycle;

  const liveActive = Boolean(live);
  const liveStartedAtMs = live?.startedAtMs;
  useEffect(() => {
    if (!liveActive) return;
    const tick = () => setNowMs(Date.now());
    const immediate = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 1_000);
    return () => {
      window.clearTimeout(immediate);
      window.clearInterval(interval);
    };
  }, [liveActive, liveStartedAtMs]);

  return (
    <section aria-busy={live ? "true" : undefined} aria-label="Evaluation results" className={`evaluation-results-workspace ${placement === "request" ? "experiment-context-pane" : ""}`.trim()}>
      <header className="evaluation-results-header">
        <div>
          <span className="eyebrow">{execution.storage === "durable" ? "Saved project evaluation" : "Unsaved session evaluation"}</span>
          <h2>{execution.plan.suite.name}</h2>
          <p>{live
            ? <>{live.finished} of {live.requested} finished{activeCase && activeCell ? ` · ${activeCase.name}, repetition ${activeCell.repetition}` : " · Preparing"} · {elapsedTime(nowMs - live.startedAtMs)} elapsed</>
            : <>As run · {execution.plan.suite.cases.length} cases · {execution.plan.repetitions} {execution.plan.repetitions === 1 ? "repetition" : "repetitions"}</>}</p>
        </div>
        <div className="evaluation-results-actions">
          <span className={`run-history-status ${lifecycle}`}>{lifecycle}</span>
          {live && <button className="button stop" type="button" onClick={onStop}>Stop remaining</button>}
          {placement === "request" && onReturnToEvaluation && <button className="button" type="button" onClick={onReturnToEvaluation}>Back to evaluation</button>}
          {placement === "response" && !live && onDismiss && <button className="button" type="button" onClick={onDismiss}>Back to editing</button>}
        </div>
      </header>

      {live && <progress aria-label="Evaluation progress" className="experiment-progress" max={live.requested} value={live.finished}>{live.finished} of {live.requested}</progress>}
      {execution.storage === "unsaved" && <StatusChip tone="advisory" label="Session only" detail="This evaluation is not saved and will be lost when this session closes." />}
      {execution.error && <StatusChip tone="failure" label="Interrupted" detail={execution.error} />}

      <section className="evaluation-results-summary" aria-label="As run summary">
        <div><span>Suite</span><strong>{aggregate.passed ? "Passed" : live ? "In progress" : "Did not pass"}</strong></div>
        <div><span>Cases</span><strong>{aggregate.caseCounts.passed} / {aggregate.caseCounts.total} passed</strong></div>
        <div><span>Checks</span><strong>{aggregate.checkCounts.passed} passed · {aggregate.checkCounts.failed} failed · {aggregate.checkCounts.notEvaluated} not evaluated</strong></div>
        <div><span>Usage coverage</span><strong>{formatTokens(aggregate.totalTokens.total)} tokens · {aggregate.totalTokens.reportedRuns}/{execution.plan.cells.length} runs reported</strong></div>
      </section>

      <div className="evaluation-case-results">
        {aggregate.cases.map((caseAssessment) => {
          const planCase = execution.plan.suite.cases.find(({ caseId }) => caseId === caseAssessment.caseId)!;
          const caseStillRunning = Boolean(live && execution.plan.cells
            .filter(({ caseId }) => caseId === caseAssessment.caseId)
            .some(({ runId }) => {
              const status = execution.states.get(runId)?.status.kind;
              return status !== "completed" && status !== "failed" && status !== "cancelled";
            }));
          return (
            <details className="evaluation-case-result" key={caseAssessment.caseId} open={aggregate.cases.length === 1}>
              <summary><span><strong>{caseAssessment.name}</strong><small>{planCase.checks.length} {planCase.checks.length === 1 ? "check" : "checks"} · {caseAssessment.repetitions.length} {caseAssessment.repetitions.length === 1 ? "repetition" : "repetitions"}</small></span><span className={`run-history-status ${caseAssessment.passed ? "completed" : caseStillRunning ? "running" : "failed"}`}>{caseAssessment.passed ? "passed" : caseStillRunning ? "running" : "did not pass"}</span></summary>
              <div className="evaluation-repetition-results">
                {caseAssessment.repetitions.map((repetition) => {
                  const trace = execution.traces.get(repetition.runId);
                  const unreadable = execution.unreadableTraces.get(repetition.runId);
                  const cell = execution.plan.cells.find(({ cellId }) => cellId === repetition.cellId)!;
                  const active = live?.currentOrdinal === cell.ordinal;
                  const classification = active && !trace ? "not-evaluated" : repetition.classification;
                  return (
                    <article className={active ? "evaluation-repetition-result active" : "evaluation-repetition-result"} key={repetition.cellId}>
                      <div className="evaluation-repetition-heading"><strong>Repetition {repetition.repetition}</strong><span className={`run-history-status ${classification}`}>{active && <span className="experiment-row-activity-dot" aria-hidden="true" />}{active ? "running" : classificationLabels[repetition.classification]}</span></div>
                      {repetition.checks.length > 0 && <ul className="evaluation-check-results">{repetition.checks.map((result) => {
                        const definition = planCase.checks.find(({ checkId }) => checkId === result.checkId);
                        return <li className={result.outcome.status} key={result.checkId}><strong>{definition?.label ?? result.kind}</strong><span>{checkMessage(result.outcome)}</span></li>;
                      })}</ul>}
                      {trace
                        ? <button className="text-button" type="button" onClick={() => onOpenTrace(repetition.runId)}>Open Response &amp; Inspect</button>
                        : <span className="repeated-experiment-row-pending" title={unreadable}>{unreadable ? "Trace could not be read" : active ? "Running…" : repetition.classification === "not-run" ? "Not run" : repetition.classification === "missing-trace" ? "Trace missing" : "Waiting"}</span>}
                    </article>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
