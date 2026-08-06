"use client";

import { useMemo, useState } from "react";

import type {
  CaseOutcomeDelta,
  EvaluationCaseComparison,
  EvaluationCaseSideSummary,
  EvaluationExecutionDrift,
} from "../../packages/core/src/evaluation-comparison.ts";
import { finalAssistantOutput } from "../../packages/core/src/run-output.ts";
import { diffLines } from "../../packages/core/src/text-diff.ts";
import type { EvaluationCaseId, EvaluationVariantId, ExperimentCellId, RunId, RunTrace } from "../../packages/core/src/run-kernel/index.ts";
import { formatTokens } from "../run-metrics-format.client.ts";
import { StatusChip } from "../notifications/status-chip.client";
import type {
  LoadedComparisonSide,
  LoadedEvaluationComparison,
} from "./use-evaluation-baselines.client.ts";

const deltaLabels: Record<CaseOutcomeDelta, string> = {
  "unchanged-pass": "unchanged · passing",
  "unchanged-fail": "unchanged · failing",
  fixed: "fixed",
  regressed: "regressed",
  incomparable: "not comparable",
  "baseline-only": "removed",
  "candidate-only": "added",
};

/** Reuses the run-history status palette so one tone means one thing app-wide. */
const deltaTones: Record<CaseOutcomeDelta, string> = {
  "unchanged-pass": "completed",
  "unchanged-fail": "failed",
  fixed: "completed",
  regressed: "failed",
  incomparable: "not-evaluated",
  "baseline-only": "not-run",
  "candidate-only": "not-run",
};

const reasonLabels = {
  "values-changed": "input values changed",
  "reference-answer-changed": "reference answer changed",
  "checks-changed": "checks changed",
} as const;

/** Transient navigation state retained while an evidence trace is open. */
export interface EvaluationComparisonReturnTarget {
  caseId: EvaluationCaseId;
  repetition: number;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatMs(value?: number): string {
  if (value === undefined) return "—";
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function DriftList({ drift }: { drift: EvaluationExecutionDrift }) {
  const rows: Array<[string, string, string]> = [];
  if (drift.inputRevision) {
    rows.push(["Input revision", drift.inputRevision.baseline, drift.inputRevision.candidate]);
  }
  if (drift.model) rows.push(["Model", drift.model.baseline, drift.model.candidate]);
  if (drift.endpoint) rows.push(["Endpoint", drift.endpoint.baseline, drift.endpoint.candidate]);
  if (drift.responseMode) {
    rows.push(["Response mode", drift.responseMode.baseline, drift.responseMode.candidate]);
  }
  if (drift.optionsChanged) rows.push(["Inference options", "changed", "changed"]);
  if (drift.repetitions) {
    rows.push([
      "Repetitions",
      String(drift.repetitions.baseline),
      String(drift.repetitions.candidate),
    ]);
  }
  if (drift.checkSchemaVersion) {
    rows.push([
      "Check vocabulary",
      `Version ${drift.checkSchemaVersion.baseline}`,
      `Version ${drift.checkSchemaVersion.candidate}`,
    ]);
  }
  if (rows.length === 0) return null;

  return (
    <section className="evaluation-comparison-drift" aria-label="Execution differences">
      {/* Stated before the outcome table on purpose: a pass rate that moved
          under a changed model is a different finding from one that moved on
          its own, and a reader should know which they are looking at. */}
      <p>
        These executions did not run under the same conditions. A changed outcome
        below may be explained by the differences here.
      </p>
      <table className="run-metrics-table">
        <caption className="visually-hidden">Execution differences</caption>
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">Baseline</th>
            <th scope="col">Candidate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, baseline, candidate]) => (
            <tr data-changed="true" key={label}>
              <th scope="row">{label}</th>
              <td>{baseline}</td>
              <td>{candidate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SideCell({ summary }: { summary?: EvaluationCaseSideSummary }) {
  if (!summary) return <td className="evaluation-comparison-absent">not in this execution</td>;
  return (
    <td>
      <span className={`run-history-status ${summary.passed ? "completed" : "failed"}`}>
        {summary.passed ? "passed" : "did not pass"}
      </span>
      <small>
        {summary.checkCounts.passed}/{summary.checkCounts.total} checks ·{" "}
        {formatMs(summary.totalDurationMs.median)} median
        {summary.missingTrace > 0 && ` · ${summary.missingTrace} trace missing`}
        {summary.notRun > 0 && ` · ${summary.notRun} not run`}
      </small>
    </td>
  );
}

/**
 * One explicitly selected repetition pair, diffed. Repetition-level evidence
 * is never silently substituted with repetition 1: a regression can be real
 * in only one sampled run.
 */
function OutputDiff({
  caseId,
  repetition,
  baseline,
  candidate,
  baselineVariantId,
  candidateVariantId,
}: {
  caseId: EvaluationCaseId;
  repetition: number;
  baseline: LoadedComparisonSide;
  candidate: LoadedComparisonSide;
  baselineVariantId: EvaluationVariantId;
  candidateVariantId: EvaluationVariantId;
}) {
  const output = (side: LoadedComparisonSide, variantId: EvaluationVariantId): string | undefined => {
    const cell = side.plan.cells.find(
      (item) => item.caseId === caseId && item.variantId === variantId && item.repetition === repetition,
    );
    const state = cell ? side.states.get(cell.runId) : undefined;
    return state ? finalAssistantOutput(state) : undefined;
  };
  const left = output(baseline, baselineVariantId);
  const right = output(candidate, candidateVariantId);
  const diff = useMemo(() => diffLines(left ?? "", right ?? ""), [left, right]);

  if (left === undefined || right === undefined) {
    return (
      <p className="evaluation-comparison-absent">
        {left === undefined && right === undefined
          ? `Neither execution has a readable repetition ${repetition} for this case.`
          : `Only the ${left === undefined ? "candidate" : "baseline"} has a readable repetition ${repetition}, so there is nothing to diff.`}
      </p>
    );
  }
  if (diff.identical) {
    return <p className="evaluation-comparison-absent">The selected repetitions produced identical output.</p>;
  }
  return (
    <>
      {diff.truncated && (
        <p className="diff-warning">
          This output exceeded the 4,000-line limit. Showing a whole-block
          replacement instead of a computed line diff.
        </p>
      )}
      <pre className="diff-code">
        {diff.lines.map((line, index) => (
          <span
            className={`diff-line ${line.kind}`}
            key={`${line.kind}:${line.leftLine ?? ""}:${line.rightLine ?? ""}:${index}`}
          >
            <span className="diff-gutter" aria-hidden="true">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
            </span>
            <span>{line.text || " "}</span>
          </span>
        ))}
      </pre>
    </>
  );
}

function CaseRow({
  comparison,
  loaded,
  onOpenTrace,
  onPromoteCandidate,
  returnTarget,
  onReturnTargetChange,
}: {
  comparison: EvaluationCaseComparison;
  loaded: LoadedEvaluationComparison;
  onOpenTrace(side: LoadedComparisonSide, runId: RunId, target: EvaluationComparisonReturnTarget): void;
  onPromoteCandidate(trace: RunTrace, experimentCellId: ExperimentCellId): void;
  returnTarget?: EvaluationComparisonReturnTarget;
  onReturnTargetChange(target?: EvaluationComparisonReturnTarget): void;
}) {
  const preferredRepetition = comparison.repetitions.find(({ delta }) => delta === "regressed")?.repetition
    ?? comparison.repetitions.find(({ baseline, candidate }) => baseline && candidate)?.repetition
    ?? comparison.repetitions[0]?.repetition;
  const restored = returnTarget?.caseId === comparison.caseId ? returnTarget.repetition : undefined;
  const [open, setOpen] = useState(Boolean(restored));
  const [selectedRepetition, setSelectedRepetition] = useState(restored ?? preferredRepetition);
  const effectiveOpen = open || restored !== undefined;
  const effectiveRepetition = restored ?? selectedRepetition;
  const selected = comparison.repetitions.find(({ repetition }) => repetition === effectiveRepetition);
  const target = effectiveRepetition === undefined ? undefined : { caseId: comparison.caseId, repetition: effectiveRepetition };
  const readableTrace = (side: LoadedComparisonSide, runId: RunId | undefined): RunTrace | undefined =>
    runId ? side.traces.get(runId) : undefined;
  const baselineTrace = readableTrace(loaded.baseline, selected?.baseline?.runId);
  const candidateTrace = readableTrace(loaded.candidate, selected?.candidate?.runId);

  function selectRepetition(repetition: number): void {
    setSelectedRepetition(repetition);
    onReturnTargetChange({ caseId: comparison.caseId, repetition });
  }

  return (
    <>
      <tr data-delta={comparison.delta}>
        <th scope="row">
          <button
            aria-expanded={effectiveOpen}
            className="text-button"
            type="button"
            onClick={() => {
              if (effectiveOpen) {
                setOpen(false);
                onReturnTargetChange(undefined);
              } else {
                setOpen(true);
              }
            }}
          >
            {comparison.name}
          </button>
          {comparison.reasons.length > 0 && (
            <small className="evaluation-comparison-reasons">
              {comparison.reasons.map((reason) => reasonLabels[reason]).join(", ")}
            </small>
          )}
        </th>
        <SideCell summary={comparison.baseline} />
        <SideCell summary={comparison.candidate} />
        <td>
          <span className={`run-history-status ${deltaTones[comparison.delta]}`}>
            {deltaLabels[comparison.delta]}
          </span>
        </td>
      </tr>
      {effectiveOpen && (
        <tr className="evaluation-comparison-detail">
          <td colSpan={4}>
            <div className="evaluation-comparison-detail-actions">
              <button
                className="text-button"
                disabled={!baselineTrace || !target}
                type="button"
                onClick={() => baselineTrace && target && onOpenTrace(loaded.baseline, baselineTrace.runId, target)}
              >
                Open baseline trace
              </button>
              <button
                className="text-button"
                disabled={!candidateTrace || !target}
                type="button"
                onClick={() => candidateTrace && target && onOpenTrace(loaded.candidate, candidateTrace.runId, target)}
              >
                Open candidate trace
              </button>
              {comparison.delta === "regressed" && candidateTrace && selected?.candidate && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => onPromoteCandidate(candidateTrace, selected.candidate!.cellId)}
                >
                  Promote candidate input to case…
                </button>
              )}
            </div>
            <div aria-label="Repetition evidence" className="evaluation-comparison-repetitions">
              {comparison.repetitions.map((item) => (
                <button
                  aria-pressed={item.repetition === effectiveRepetition}
                  className="text-button"
                  key={item.repetition}
                  type="button"
                  onClick={() => selectRepetition(item.repetition)}
                >
                  Repetition {item.repetition} · {item.baseline && item.candidate
                    ? deltaLabels[item.delta]
                    : item.baseline ? "baseline only" : "candidate only"}
                </button>
              ))}
            </div>
            {selected && (!selected.baseline || !selected.candidate) && (
              <p className="evaluation-comparison-absent">
                Repetition {selected.repetition} is unmatched: it exists only in the {selected.baseline ? "baseline" : "candidate"} execution.
              </p>
            )}
            <OutputDiff
              baseline={loaded.baseline}
              candidate={loaded.candidate}
              caseId={comparison.caseId}
              repetition={effectiveRepetition ?? 1}
              baselineVariantId={loaded.comparison.baseline.variantId}
              candidateVariantId={loaded.comparison.candidate.variantId}
            />
            <ul className="evaluation-comparison-checks">
              {comparison.checks.map((check) => (
                <li key={check.checkId}>
                  <strong>{check.label ?? check.kind}</strong>
                  <span>
                    {check.status === "aligned"
                      ? `baseline ${check.baseline?.passed ?? 0} passed / ${check.baseline?.failed ?? 0} failed · candidate ${check.candidate?.passed ?? 0} passed / ${check.candidate?.failed ?? 0} failed`
                      : check.status === "added"
                        ? "only in the candidate"
                        : check.status === "removed"
                          ? "only in the baseline"
                          : "its definition changed between these executions"}
                  </span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

export function EvaluationComparisonWorkspace({
  loaded,
  onOpenTrace,
  onPromoteCandidate,
  onDismiss,
  returnTarget,
  onReturnTargetChange,
}: {
  loaded: LoadedEvaluationComparison;
  onOpenTrace(side: LoadedComparisonSide, runId: RunId, target: EvaluationComparisonReturnTarget): void;
  onPromoteCandidate(trace: RunTrace, experimentCellId: ExperimentCellId): void;
  onDismiss(): void;
  returnTarget?: EvaluationComparisonReturnTarget;
  onReturnTargetChange(target?: EvaluationComparisonReturnTarget): void;
}) {
  const { comparison } = loaded;
  return (
    <section aria-label="Evaluation comparison" className="evaluation-comparison-workspace">
      <header className="evaluation-results-header">
        <div>
          <span className="eyebrow">Baseline comparison</span>
          <h2>{loaded.candidate.plan.suite.name}</h2>
          <p>
            {loaded.baselineName} · {comparison.baseline.variantName} ({formatDate(loaded.baseline.plan.createdAt)}) compared with{" "}
            {comparison.candidate.variantName} · {formatDate(loaded.candidate.plan.createdAt)}
          </p>
        </div>
        <div className="evaluation-results-actions">
          <button className="button" type="button" onClick={onDismiss}>
            Back to editing
          </button>
        </div>
      </header>

      {!comparison.sameSuite && (
        <StatusChip
          tone="advisory"
          label="Different suites"
          detail="Cases still align by identity where they share one, but the two suites are not the same question."
        />
      )}

      <section className="evaluation-results-summary" aria-label="Comparison summary">
        <div>
          <span>Regressed</span>
          <strong>{comparison.counts.regressed}</strong>
        </div>
        <div>
          <span>Fixed</span>
          <strong>{comparison.counts.fixed}</strong>
        </div>
        <div>
          <span>Unchanged</span>
          <strong>
            {comparison.counts.unchangedPass} passing · {comparison.counts.unchangedFail} failing
          </strong>
        </div>
        <div>
          <span>Not comparable</span>
          <strong>
            {comparison.counts.incompatible} changed · {comparison.counts.added} added ·{" "}
            {comparison.counts.removed} removed
          </strong>
        </div>
      </section>

      <DriftList drift={comparison.drift} />

      <div className="run-metrics-table-scroll">
        <table className="run-metrics-table evaluation-comparison-table">
          <caption className="visually-hidden">Case outcomes</caption>
          <thead>
            <tr>
              <th scope="col">Case</th>
              <th scope="col">Baseline</th>
              <th scope="col">Candidate</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {comparison.cases.map((item) => (
              <CaseRow
                comparison={item}
                key={item.caseId}
                loaded={loaded}
                onOpenTrace={onOpenTrace}
                onPromoteCandidate={onPromoteCandidate}
                returnTarget={returnTarget}
                onReturnTargetChange={onReturnTargetChange}
              />
            ))}
          </tbody>
        </table>
      </div>

      <section className="evaluation-results-summary" aria-label="Execution totals">
        <div>
          <span>Cases passed</span>
          <strong>
            {comparison.baseline.caseCounts.passed}/{comparison.baseline.caseCounts.total} →{" "}
            {comparison.candidate.caseCounts.passed}/{comparison.candidate.caseCounts.total}
          </strong>
        </div>
        <div>
          <span>Median latency</span>
          <strong>
            {formatMs(comparison.baseline.totalDurationMs.median)} →{" "}
            {formatMs(comparison.candidate.totalDurationMs.median)}
          </strong>
        </div>
        <div>
          <span>Total tokens</span>
          <strong>
            {formatTokens(comparison.baseline.totalTokens.total)} →{" "}
            {formatTokens(comparison.candidate.totalTokens.total)}
          </strong>
        </div>
        <div>
          <span>Usage coverage</span>
          <strong>
            {comparison.baseline.totalTokens.reportedRuns} →{" "}
            {comparison.candidate.totalTokens.reportedRuns} runs reported
          </strong>
        </div>
      </section>
    </section>
  );
}
