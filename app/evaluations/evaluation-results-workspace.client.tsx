"use client";

import { useEffect, useMemo, useState } from "react";

import {
  evaluationParsedExperimentAggregate,
  evaluationVariantAssessment,
  parseExperimentPlanFile,
  type EvaluationRepetitionAssessment,
  type EvaluationRepetitionClassification,
  type EvaluationVariantAssessment,
  type ExperimentMetricRange,
} from "../../packages/core/src/experiment.ts";
import { finalAssistantOutput } from "../../packages/core/src/run-output.ts";
import { diffLines } from "../../packages/core/src/text-diff.ts";
import type {
  EvaluationVariantId,
  RunId,
  RunState,
  RunTrace,
} from "../../packages/core/src/run-kernel/index.ts";
import { StatusChip } from "../notifications/status-chip.client";
import { formatTokens } from "../run-metrics-format.client.ts";
import { SideDrawer } from "../workbench-shell.client.tsx";
import { EvaluationReassessmentDrawer } from "./evaluation-reassessment-drawer.client.tsx";
import type { EvaluationReassessmentHandle } from "./use-evaluation-reassessment.client.ts";
import type { EvaluationExecution } from "./use-evaluation-execution-session.client.ts";

const classificationLabels: Record<EvaluationRepetitionClassification, string> = {
  passed: "passed",
  "check-failed": "check failed",
  "not-evaluated": "not evaluated",
  "run-failed": "run failed",
  cancelled: "cancelled",
  "not-run": "not run",
  "trace-unavailable": "trace unavailable",
};

export type EvidenceReachability =
  | { kind: "readable"; state: RunState }
  | { kind: "unreadable"; reason: string }
  | { kind: "absent" }
  | { kind: "not-created" };

type LiveCellOverlay = "running" | "queued";

/** Application-level join kept separate from the core scoring classification. */
export function evaluationEvidenceReachability(
  repetition: Pick<EvaluationRepetitionAssessment, "runId" | "classification">,
  execution: Pick<EvaluationExecution, "states" | "traces" | "unreadableTraces">,
): EvidenceReachability {
  if (repetition.classification === "not-run") return { kind: "not-created" };
  const unreadable = execution.unreadableTraces.get(repetition.runId);
  if (unreadable !== undefined) return { kind: "unreadable", reason: unreadable };
  const state = execution.states.get(repetition.runId);
  if (state && execution.traces.has(repetition.runId)) return { kind: "readable", state };
  return { kind: "absent" };
}

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

function formatMs(value?: number): string {
  if (value === undefined) return "—";
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function formatLatency(range: ExperimentMetricRange): string {
  if (range.median === undefined || range.min === undefined || range.max === undefined) return "—";
  return `${formatMs(range.median)} median · ${formatMs(range.min)}–${formatMs(range.max)}`;
}

function passRate(variant: EvaluationVariantAssessment): number {
  return variant.caseCounts.total === 0
    ? 0
    : Math.round((variant.caseCounts.passed / variant.caseCounts.total) * 100);
}

function evidenceLabel(reachability: EvidenceReachability): string {
  switch (reachability.kind) {
    case "readable": return "Response and trace available";
    case "unreadable": return `Trace unreadable: ${reachability.reason}`;
    case "absent": return "Trace absent";
    case "not-created": return "Trace not created";
  }
}

interface ComparisonSelection {
  caseId: string;
  repetition: number;
  left: EvaluationVariantId;
  right: EvaluationVariantId;
}

interface ComparisonSide {
  assessment: EvaluationVariantAssessment;
  repetition: EvaluationRepetitionAssessment | undefined;
  reachability: EvidenceReachability | undefined;
  output: string | undefined;
}

export function EvaluationResultsWorkspace({
  execution,
  onStop,
  onOpenTrace,
  onPromoteTrace,
  placement = "response",
  onReturnToEvaluation,
  onDismiss,
  reassessment,
}: {
  execution: EvaluationExecution;
  onStop(): void;
  onOpenTrace(runId: RunId): void;
  onPromoteTrace?(trace: RunTrace, experimentCellId: string): void;
  placement?: "request" | "response";
  onReturnToEvaluation?(): void;
  /**
   * Which interpretation the outcomes below are derived under.
   *
   * Optional because a live batch has nothing to reinterpret yet: absent, this
   * surface reads exactly as it always has, which is the As run reading.
   */
  reassessment?: EvaluationReassessmentHandle;
  /**
   * Hands the response pane back to the suite editor's provider-input preview.
   * Offered only once the batch is finished: a saved evaluation reopens from
   * project history, so this is a navigation, not a discard.
   */
  onDismiss?(): void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [activeVariantId, setActiveVariantId] = useState<EvaluationVariantId>();
  const [expandedCaseIds, setExpandedCaseIds] = useState<readonly string[]>([]);
  const [comparison, setComparison] = useState<ComparisonSelection>();
  const parsedPlan = useMemo(() => {
    const plan = parseExperimentPlanFile(execution.plan);
    if (plan.kind !== "evaluation") throw new Error("Expected an evaluation plan.");
    return plan;
  }, [execution.plan]);
  const criteria = reassessment?.criteria;
  const aggregate = useMemo(
    () => evaluationParsedExperimentAggregate(
      parsedPlan,
      execution.result,
      execution.states,
      criteria,
    ),
    [parsedPlan, execution.result, execution.states, criteria],
  );
  const interpretation = reassessment?.selected;
  const reinterpreted = Boolean(interpretation && interpretation.id.kind !== "as-run");
  const selectedVariantId = aggregate.variants.some(
    ({ variant }) => variant.variantId === activeVariantId,
  )
    ? activeVariantId
    : aggregate.variants[0]?.variant.variantId;
  const activeVariant = selectedVariantId
    ? evaluationVariantAssessment(aggregate, selectedVariantId)
    : undefined;
  const live = execution.result || execution.error ? undefined : execution.live;
  const activeCell = live?.currentOrdinal === undefined
    ? undefined
    : execution.plan.cells.find(({ ordinal }) => ordinal === live.currentOrdinal);
  const activeCase = activeCell
    ? execution.plan.suite.cases.find(({ caseId }) => caseId === activeCell.caseId)
    : undefined;
  const lifecycle = live ? "running" : execution.error ? "interrupted" : aggregate.lifecycle;

  function liveOverlay(ordinal: number): LiveCellOverlay | undefined {
    if (!live) return undefined;
    if (live.currentOrdinal === undefined || ordinal > live.currentOrdinal) return "queued";
    return ordinal === live.currentOrdinal ? "running" : undefined;
  }

  function comparisonSide(variantId: EvaluationVariantId): ComparisonSide {
    const assessment = evaluationVariantAssessment(aggregate, variantId);
    const repetition = assessment.cases
      .find(({ caseId }) => caseId === comparison?.caseId)
      ?.repetitions.find((item) => item.repetition === comparison?.repetition);
    const reachability = repetition
      ? evaluationEvidenceReachability(repetition, execution)
      : undefined;
    return {
      assessment,
      repetition,
      reachability,
      output: reachability?.kind === "readable"
        ? finalAssistantOutput(reachability.state)
        : undefined,
    };
  }

  const comparisonSides = comparison
    ? { left: comparisonSide(comparison.left), right: comparisonSide(comparison.right) }
    : undefined;
  const outputDiff = useMemo(() => {
    const left = comparisonSides?.left.output;
    const right = comparisonSides?.right.output;
    return left !== undefined && right !== undefined ? diffLines(left, right) : undefined;
  }, [comparisonSides?.left.output, comparisonSides?.right.output]);

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
            ? <>{live.finished} of {live.requested} finished{activeCase && activeCell ? ` · ${activeCase.name}, ${parsedPlan.suite.variants.find(({ variantId }) => variantId === activeCell.variantId)?.name ?? "Configuration"}, repetition ${activeCell.repetition}` : " · Preparing"} · {elapsedTime(nowMs - live.startedAtMs)} elapsed</>
            : <>{interpretation?.name ?? "As run"} · {execution.plan.suite.cases.length} cases · {execution.plan.repetitions} {execution.plan.repetitions === 1 ? "repetition" : "repetitions"}</>}</p>
        </div>
        <div className="evaluation-results-actions">
          <span className={`run-history-status ${lifecycle}`}>{lifecycle}</span>
          {reassessment?.available && reassessment.interpretations.length > 1 && (
            <label className="evaluation-interpretation-select">
              Reading
              <select
                value={reassessment.selected.value}
                onChange={(event) => reassessment.select(event.target.value)}
              >
                {reassessment.interpretations.map((option) => (
                  <option key={option.value} value={option.value}>{option.name}</option>
                ))}
              </select>
            </label>
          )}
          {reassessment?.available && (
            <button className="button" type="button" onClick={reassessment.openEditor}>
              Re-evaluate saved outputs…
            </button>
          )}
          {live && <button className="button stop" type="button" onClick={onStop}>Stop remaining</button>}
          {placement === "request" && onReturnToEvaluation && <button className="button" type="button" onClick={onReturnToEvaluation}>Back to evaluation</button>}
          {placement === "response" && !live && onDismiss && <button className="button" type="button" onClick={onDismiss}>Back to editing</button>}
        </div>
      </header>

      {live && <progress aria-label="Evaluation progress" className="experiment-progress" max={live.requested} value={live.finished}>{live.finished} of {live.requested}</progress>}
      {execution.storage === "unsaved" && <StatusChip tone="advisory" label="Session only" detail="This evaluation is not saved and will be lost when this session closes." />}
      {execution.error && <StatusChip tone="failure" label="Interrupted" detail={execution.error} />}
      {/*
        * Persistent, not dismissible. A pass rate with no visible interpretation
        * is the exact failure this feature was designed against: every number
        * below is re-derived from unchanged evidence under criteria that are not
        * the ones this batch ran with.
        */}
      {reinterpreted && interpretation && (
        <StatusChip
          tone="advisory"
          label={interpretation.preview ? "Preview interpretation" : "Saved reinterpretation"}
          detail={`Outcomes below are re-derived under “${interpretation.name}”, not the criteria this evaluation ran with. No saved output changed.${interpretation.preview ? " This reading is not saved." : ""}`}
        />
      )}
      {reassessment?.error && (
        <StatusChip
          tone="failure"
          label="Reassessment"
          detail={reassessment.error}
          actions={[{ key: "dismiss", label: "Dismiss", onSelect: reassessment.dismissError }]}
        />
      )}
      {reassessment?.notice && (
        <StatusChip
          tone="neutral"
          label="Reassessment"
          detail={reassessment.notice}
          actions={[{ key: "dismiss", label: "Dismiss", onSelect: reassessment.dismissNotice }]}
        />
      )}

      <div aria-label={reinterpreted && interpretation ? `${interpretation.name} summary` : "As run summary"} className="evaluation-configuration-table-scroll" role="region">
        <table className="evaluation-configuration-table" aria-label="Configuration results">
          <thead>
            <tr>
              <th scope="col">Configuration</th>
              <th scope="col">Outcome</th>
              <th scope="col">Cases</th>
              <th scope="col">Checks</th>
              <th scope="col">Latency</th>
              <th scope="col">Total tokens</th>
            </tr>
          </thead>
          <tbody>
            {aggregate.variants.map((variant) => {
              const expectedCells = variant.cases.reduce(
                (sum, evaluationCase) => sum + evaluationCase.repetitions.length,
                0,
              );
              const overlays = execution.plan.cells
                .filter(({ variantId }) => variantId === variant.variant.variantId)
                .map(({ ordinal }) => liveOverlay(ordinal));
              const liveStatus = overlays.includes("running")
                ? "In progress"
                : overlays.includes("queued")
                  ? "Queued"
                  : undefined;
              const statusClass = overlays.includes("running")
                ? "running"
                : overlays.includes("queued")
                  ? "queued"
                  : variant.passed ? "completed" : "failed";
              return (
                <tr className={variant.variant.variantId === activeVariant?.variant.variantId ? "selected" : undefined} key={variant.variant.variantId}>
                  <th scope="row">
                    <button type="button" onClick={() => setActiveVariantId(variant.variant.variantId)}>
                      <strong>{variant.variant.name}</strong>
                      <small>{variant.variant.target.model}</small>
                    </button>
                  </th>
                  <td><span className={`run-history-status ${statusClass}`}>{liveStatus ?? (variant.passed ? "passed" : "did not pass")}</span></td>
                  <td><strong>{variant.caseCounts.passed} / {variant.caseCounts.total} passed</strong><small>{passRate(variant)}% · {variant.caseCounts.failed} failed · {variant.caseCounts.incomplete} incomplete</small></td>
                  <td><strong>{variant.checkCounts.passed} passed · {variant.checkCounts.failed} failed · {variant.checkCounts.notEvaluated} not evaluated</strong></td>
                  <td><strong>{formatLatency(variant.totalDurationMs)}</strong><small>{variant.totalDurationMs.count}/{expectedCells} completed runs</small></td>
                  <td><strong>{variant.totalTokens.total === undefined ? "—" : `${formatTokens(variant.totalTokens.total)} tokens`} · {variant.totalTokens.reportedRuns}/{expectedCells} runs reported</strong></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {activeVariant && <div className="evaluation-case-results">
        {activeVariant.cases.map((caseAssessment) => {
          const planCase = execution.plan.suite.cases.find(({ caseId }) => caseId === caseAssessment.caseId)!;
          // Labels and the check count follow the interpretation being read, so
          // a replaced check is never described by the definition it replaced.
          const caseChecks = criteria?.get(caseAssessment.caseId) ?? planCase.checks;
          const caseCells = execution.plan.cells.filter(
            ({ caseId, variantId }) => caseId === caseAssessment.caseId && variantId === activeVariant.variant.variantId,
          );
          const caseOverlays = caseCells.map(({ ordinal }) => liveOverlay(ordinal));
          const caseLiveStatus = caseOverlays.includes("running")
            ? "running"
            : caseOverlays.includes("queued")
              ? "queued"
              : undefined;
          const open = activeVariant.cases.length === 1 || expandedCaseIds.includes(caseAssessment.caseId);
          return (
            <details
              className="evaluation-case-result"
              key={caseAssessment.caseId}
              open={open}
              onToggle={(event) => {
                const nextOpen = event.currentTarget.open;
                setExpandedCaseIds((current) => nextOpen
                  ? current.includes(caseAssessment.caseId) ? current : [...current, caseAssessment.caseId]
                  : current.filter((caseId) => caseId !== caseAssessment.caseId));
              }}
            >
              <summary><span><strong>{caseAssessment.name}</strong><small>{caseChecks.length} {caseChecks.length === 1 ? "check" : "checks"} · {caseAssessment.repetitions.length} {caseAssessment.repetitions.length === 1 ? "repetition" : "repetitions"}</small></span><span className={`run-history-status ${caseAssessment.passed ? "completed" : caseLiveStatus ?? "failed"}`}>{caseAssessment.passed ? "passed" : caseLiveStatus ?? "did not pass"}</span></summary>
              <div className="evaluation-repetition-results">
                {caseAssessment.repetitions.map((repetition) => {
                  const cell = caseCells.find(({ cellId }) => cellId === repetition.cellId)!;
                  const overlay = liveOverlay(cell.ordinal);
                  const reachability = evaluationEvidenceReachability(repetition, execution);
                  const presentation = overlay ?? repetition.classification;
                  return (
                    <article className={overlay ? `evaluation-repetition-result ${overlay}` : "evaluation-repetition-result"} key={repetition.cellId}>
                      <div className="evaluation-repetition-heading"><strong>Repetition {repetition.repetition}</strong><span className={`run-history-status ${presentation}`}>{overlay === "running" && <span className="experiment-row-activity-dot" aria-hidden="true" />}{overlay ?? classificationLabels[repetition.classification]}</span></div>
                      {repetition.checks.length > 0 && <ul className="evaluation-check-results">{repetition.checks.map((result) => {
                        const definition = caseChecks.find(({ checkId }) => checkId === result.checkId);
                        return <li className={result.outcome.status} key={result.checkId}><strong>{definition?.label ?? result.kind}</strong><span>{checkMessage(result.outcome)}</span></li>;
                      })}</ul>}
                      <div className={`evaluation-evidence-row ${overlay ?? reachability.kind}`}>
                        <span><strong>Evidence</strong><small>{overlay ? overlay === "running" ? "Running… · Pending while this run is active" : "Queued · Pending until this run starts" : evidenceLabel(reachability)}</small></span>
                        {!overlay && reachability.kind === "readable" && <button className="text-button" type="button" onClick={() => onOpenTrace(repetition.runId)}>Open Response &amp; Inspect</button>}
                        {!overlay && reachability.kind === "readable" && onPromoteTrace && <button className="text-button" type="button" onClick={() => {
                          const trace = execution.traces.get(repetition.runId);
                          if (trace) onPromoteTrace(trace, repetition.cellId);
                        }}>Promote to case…</button>}
                      </div>
                      {aggregate.variants.length > 1 && <button className="text-button evaluation-compare-output" type="button" onClick={() => {
                        const index = aggregate.variants.findIndex(({ variant }) => variant.variantId === activeVariant.variant.variantId);
                        const other = aggregate.variants[(index + 1) % aggregate.variants.length]!;
                        setComparison({ caseId: caseAssessment.caseId, repetition: repetition.repetition, left: activeVariant.variant.variantId, right: other.variant.variantId });
                      }}>Compare output…</button>}
                    </article>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>}

      <SideDrawer open={Boolean(comparison)} eyebrow="Evaluation evidence" title="Compare output" description={comparison ? `${execution.plan.suite.cases.find(({ caseId }) => caseId === comparison.caseId)?.name ?? "Case"} · repetition ${comparison.repetition}` : undefined} onClose={() => setComparison(undefined)}>
        {comparison && comparisonSides && <>
          {aggregate.variants.length > 2 && <div className="diff-controls">
            <label>Left <select value={comparison.left} onChange={(event) => setComparison({ ...comparison, left: event.target.value as EvaluationVariantId })}>{aggregate.variants.filter(({ variant }) => variant.variantId !== comparison.right).map(({ variant }) => <option key={variant.variantId} value={variant.variantId}>{variant.name} · {variant.target.model}</option>)}</select></label>
            <label>Right <select value={comparison.right} onChange={(event) => setComparison({ ...comparison, right: event.target.value as EvaluationVariantId })}>{aggregate.variants.filter(({ variant }) => variant.variantId !== comparison.left).map(({ variant }) => <option key={variant.variantId} value={variant.variantId}>{variant.name} · {variant.target.model}</option>)}</select></label>
          </div>}
          <div className="evaluation-output-comparison-cards">
            {(["left", "right"] as const).map((sideName) => {
              const side = comparisonSides[sideName];
              return <section aria-label={`${sideName} configuration`} className="evaluation-output-comparison-card" key={sideName}>
                <span className="eyebrow">{sideName}</span>
                <h3>{side.assessment.variant.name}</h3>
                <dl>
                  <div><dt>Model</dt><dd>{side.assessment.variant.target.model}</dd></div>
                  <div><dt>Endpoint</dt><dd>{side.assessment.variant.target.endpoint}</dd></div>
                  <div><dt>Delivery</dt><dd>{side.assessment.variant.responseMode}</dd></div>
                  <div><dt>Status</dt><dd>{side.repetition ? classificationLabels[side.repetition.classification] : "not available"}</dd></div>
                  <div><dt>Evidence</dt><dd>{side.reachability ? evidenceLabel(side.reachability) : "No matching repetition"}</dd></div>
                  <div><dt>Output</dt><dd>{side.output === undefined ? "No completed assistant output" : side.output === "" ? "Empty output" : "Readable output"}</dd></div>
                </dl>
              </section>;
            })}
          </div>
          {outputDiff && (outputDiff.identical ? <p className="evaluation-comparison-absent">The outputs are identical.</p> : <pre className="diff-code">{outputDiff.lines.map((line, index) => <span className={`diff-line ${line.kind}`} key={`${line.kind}:${index}`}><span className="diff-gutter">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span><span>{line.text || " "}</span></span>)}</pre>)}
          {!outputDiff && <p className="evaluation-comparison-absent">A line diff needs readable output on both sides.</p>}
        </>}
      </SideDrawer>

      {reassessment?.available && <EvaluationReassessmentDrawer handle={reassessment} />}
    </section>
  );
}
