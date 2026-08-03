"use client";

import { useEffect, useState } from "react";

import {
  finalAssistantOutput,
  repeatedExperimentAggregate,
} from "../../packages/core/src/experiment.ts";
import type { RunId, RunState } from "../../packages/core/src/run-kernel/index.ts";
import { runMetrics } from "../../packages/core/src/run-metrics.ts";
import { formatDuration, formatRate, formatTokens } from "../run-metrics-format.client.ts";
import type { RepeatedExperimentExecution } from "./use-repeated-experiment-session.client.ts";

function rowStatus(
  execution: RepeatedExperimentExecution,
  runId: RunId,
  isLive: boolean,
): string {
  const state = execution.states.get(runId);
  if (state) {
    switch (state.status.kind) {
      case "completed": return "completed";
      case "failed": return "failed";
      case "cancelled": return "cancelled";
      default: return "running";
    }
  }
  return execution.result?.cells.find((cell) => cell.runId === runId)?.status
    ?? (isLive ? "queued" : "not-run");
}

/**
 * Explains why a repetition cannot be opened yet. The roadmap keeps the reasons
 * distinct, and only the last of them reports durable data loss.
 *
 * A live experiment reaches a cell's terminal status before that cell's trace
 * exists: the controller emits terminal progress, then awaits `onTerminalTrace`
 * to write the trace. A running cell has no trace at all until it finishes.
 * Neither is a missing trace, so both are named rather than falling through to
 * one — otherwise every ordinary repetition claims its evidence was lost for as
 * long as the provider call and the filesystem write take.
 */
function pendingLabel(
  status: string,
  unreadable: string | undefined,
  isLive: boolean,
): string {
  if (unreadable) return "Trace could not be read";
  if (status === "queued") return "Waiting";
  if (status === "not-run") return "Not run";
  if (status === "running") return "Open when finished";
  // Terminal with no trace: still being written while this session drives the
  // experiment, genuinely absent once it no longer does.
  return isLive ? "Saving trace…" : "Trace missing";
}

function rowMetrics(state: RunState | undefined): string | undefined {
  if (!state || !["completed", "failed", "cancelled"].includes(state.status.kind)) return undefined;
  const metrics = runMetrics(state);
  const values = [
    metrics.totalDurationMs === undefined ? undefined : formatDuration(metrics.totalDurationMs),
    metrics.usage.totalTokens === undefined ? undefined : `${formatTokens(metrics.usage.totalTokens)} tokens`,
  ].filter((value): value is string => value !== undefined);
  return values.length > 0 ? values.join(" · ") : undefined;
}

const OUTPUT_PREVIEW_MAX_CHARACTERS = 240;

function outputPreview(state: RunState | undefined): string | undefined {
  if (state?.status.kind !== "completed") return undefined;
  const output = finalAssistantOutput(state);
  if (output === undefined) return undefined;
  const normalized = output.replace(/\s+/g, " ").trim();
  if (!normalized) return "No text output";
  const characters = Array.from(normalized);
  return characters.length > OUTPUT_PREVIEW_MAX_CHARACTERS
    ? `${characters.slice(0, OUTPUT_PREVIEW_MAX_CHARACTERS).join("")}…`
    : normalized;
}

function range(
  label: string,
  values: { count: number; min?: number; median?: number; max?: number },
  formatter: (value?: number) => string,
) {
  if (values.count === 0) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{formatter(values.median)} median · {formatter(values.min)}–{formatter(values.max)}</dd>
    </div>
  );
}

function elapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function RepeatedExperimentWorkspace({
  execution,
  onStop,
  onOpenTrace,
  placement = "response",
  onReturnToRequest,
  onDismiss,
}: {
  execution: RepeatedExperimentExecution;
  onStop(): void;
  onOpenTrace(runId: RunId): void;
  placement?: "request" | "response";
  onReturnToRequest?(): void;
  /**
   * Hands the response pane back to the single-run response. Offered only once
   * the batch is finished; a saved experiment reopens from project history.
   */
  onDismiss?(): void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const aggregate = repeatedExperimentAggregate(
    execution.plan,
    execution.result,
    execution.states,
  );
  const live = execution.result || execution.error ? undefined : execution.live;
  const isRunning = live !== undefined;
  const lifecycle = isRunning ? "running" : execution.error ? "interrupted" : aggregate.lifecycle;
  const activeOrdinal = live?.currentOrdinal;
  const incompleteOutcomes = [
    aggregate.notRun > 0 ? `${aggregate.notRun} not run` : undefined,
    aggregate.missingTrace > 0 ? `${aggregate.missingTrace} missing trace` : undefined,
  ].filter((value): value is string => value !== undefined);
  const hasLatency = aggregate.totalDurationMs.count > 0 || aggregate.ttfoMs.count > 0;
  const hasUsage = aggregate.reportedTotalTokens.count > 0;
  const hasMoreMetrics =
    aggregate.reportedOutputTokens.count > 0 ||
    aggregate.outputTokensPerSecond.count > 0 ||
    aggregate.outputCharacterCount.count > 0;

  useEffect(() => {
    if (!isRunning) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [isRunning]);

  return (
    <section
      aria-busy={isRunning ? "true" : undefined}
      aria-label="Repeated experiment results"
      className={`repeated-experiment-workspace ${placement === "request" ? "experiment-context-pane" : ""}`.trim()}
    >
      <header className="repeated-experiment-header">
        <div>
          <span className="eyebrow">{execution.storage === "durable" ? "Saved project experiment" : "Unsaved session experiment"}</span>
          <h2>Repeated experiment</h2>
          <p>
            {live
              ? <>{live.finished} of {live.requested} finished{activeOrdinal ? ` · Running repetition ${activeOrdinal}` : " · Preparing"} · <span className="experiment-elapsed">{elapsedTime(nowMs - live.startedAtMs)} elapsed</span></>
              : `${aggregate.requested} requested repetitions`}
          </p>
        </div>
        <div className="repeated-experiment-actions">
          <span className={`run-history-status ${lifecycle}`}>{lifecycle}</span>
          {isRunning && <button className="button stop" type="button" onClick={onStop}>Stop remaining</button>}
          {placement === "request" && onReturnToRequest && <button className="button" type="button" onClick={onReturnToRequest}>Back to request</button>}
          {placement === "response" && !isRunning && onDismiss && <button className="button" type="button" onClick={onDismiss}>Close results</button>}
        </div>
      </header>

      {live && <progress aria-label="Experiment progress" className="experiment-progress" max={live.requested} value={live.finished}>{live.finished} of {live.requested}</progress>}

      {execution.storage === "unsaved" && <p className="repeated-experiment-notice" role="status">This experiment is not saved and will be lost when this session closes.</p>}
      {execution.error && <p className="repeated-experiment-notice error" role="alert">{execution.error}</p>}

      <div className="repeated-experiment-summary" aria-label="Repeated experiment summary">
        <section className="repeated-experiment-metric-section">
          <h3>Outcomes</h3>
          <dl>
            <div><dt>Finished runs</dt><dd>{aggregate.completed} completed · {aggregate.failed} failed · {aggregate.cancelled} cancelled</dd></div>
            {incompleteOutcomes.length > 0 && <div><dt>Unstarted / missing</dt><dd>{incompleteOutcomes.join(" · ")}</dd></div>}
          </dl>
        </section>

        <section className="repeated-experiment-metric-section">
          <h3>Consistency</h3>
          <dl>
            <div><dt>Exact output variants</dt><dd>{aggregate.distinctFinalAssistantOutputs}</dd></div>
            <div><dt>Retries observed</dt><dd>{aggregate.runsWithRetries}</dd></div>
          </dl>
        </section>

        {hasLatency && <section className="repeated-experiment-metric-section">
          <h3>Latency</h3>
          <dl>
            {range("Total duration", aggregate.totalDurationMs, formatDuration)}
            {range("Time to first output", aggregate.ttfoMs, formatDuration)}
          </dl>
        </section>}

        {hasUsage && <section className="repeated-experiment-metric-section">
          <h3>Usage</h3>
          <dl>
            {range("Per-run total tokens", aggregate.reportedTotalTokens, formatTokens)}
            <div><dt>Experiment total</dt><dd>{formatTokens(aggregate.totalTokens.total)} across {aggregate.totalTokens.reportedRuns} runs</dd></div>
          </dl>
        </section>}
      </div>

      {hasMoreMetrics && <details className="repeated-experiment-more-metrics">
        <summary>More metrics</summary>
        <dl>
          {range("Per-run output tokens", aggregate.reportedOutputTokens, formatTokens)}
          {aggregate.outputTokens.reportedRuns > 0 && <div><dt>Experiment output tokens</dt><dd>{formatTokens(aggregate.outputTokens.total)} across {aggregate.outputTokens.reportedRuns} runs</dd></div>}
          {range("Output throughput", aggregate.outputTokensPerSecond, formatRate)}
          {range("Output characters", aggregate.outputCharacterCount, (value) => value?.toLocaleString() ?? "")}
        </dl>
      </details>}

      <div className="repeated-experiment-rows">
        {execution.plan.cells.map((cell) => {
          const state = execution.states.get(cell.runId);
          const trace = execution.traces.get(cell.runId);
          const unreadable = execution.unreadableTraces.get(cell.runId);
          const isActive = activeOrdinal === cell.ordinal;
          // The controller keeps reporting a cell as current while its terminal
          // trace is written, so the status word comes from the cell's own
          // evidence. Overriding it with the controller's cursor relabelled a
          // finished repetition as still running.
          const status = rowStatus(execution, cell.runId, isRunning);
          const isSelected = execution.selectedRunId === cell.runId;
          const preview = outputPreview(state);
          const metrics = rowMetrics(state);
          return (
            <article
              aria-current={isSelected ? "true" : undefined}
              className={`repeated-experiment-row${isActive ? " active" : ""}${isSelected ? " selected" : ""}`}
              key={cell.cellId}
            >
              <div><strong>Repetition {cell.ordinal}</strong><span className={`run-history-status ${status}`}>{isActive && <span className="experiment-row-activity-dot" aria-hidden="true" />}{status}</span></div>
              {metrics && <span className="repeated-experiment-row-metrics">{metrics}</span>}
              {trace
                ? <button className="text-button" type="button" onClick={() => onOpenTrace(cell.runId)}>Open Response &amp; Inspect</button>
                : <span className="repeated-experiment-row-pending" title={unreadable}>{pendingLabel(status, unreadable, isRunning)}</span>}
              {preview !== undefined && <p className="repeated-experiment-output-preview"><span>Output ready</span>{preview}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
