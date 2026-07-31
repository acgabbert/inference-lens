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

function rowStatus(execution: RepeatedExperimentExecution, runId: RunId): string {
  const state = execution.progress.states.get(runId);
  if (state) {
    switch (state.status.kind) {
      case "completed": return "completed";
      case "failed": return "failed";
      case "cancelled": return "cancelled";
      default: return "running";
    }
  }
  return execution.result?.cells.find((cell) => cell.runId === runId)?.status
    ?? (execution.progress.status === "running" ? "queued" : "not-run");
}

function rowMetrics(state: RunState | undefined): string {
  if (!state || !["completed", "failed", "cancelled"].includes(state.status.kind)) return "—";
  const metrics = runMetrics(state);
  return `${formatDuration(metrics.totalDurationMs)} · ${formatTokens(metrics.usage.totalTokens)} tokens`;
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

function range(label: string, values: { count: number; min?: number; median?: number; max?: number }, formatter: (value?: number) => string) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{values.count === 0 ? "—" : `${formatter(values.median)} median · ${formatter(values.min)}–${formatter(values.max)}`}</dd>
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
}: {
  execution: RepeatedExperimentExecution;
  onStop(): void;
  onOpenTrace(runId: RunId): void;
  placement?: "request" | "response";
  onReturnToRequest?(): void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const aggregate = repeatedExperimentAggregate(
    execution.plan,
    execution.result,
    execution.progress.states,
  );
  const isRunning = execution.progress.status === "running" && !execution.error && !execution.result;
  const lifecycle = isRunning ? "running" : execution.error ? "interrupted" : aggregate.lifecycle;
  const activeOrdinal = isRunning ? execution.progress.currentOrdinal : undefined;

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
            {isRunning
              ? <>{execution.progress.finished} of {execution.progress.requested} finished{activeOrdinal ? ` · Running repetition ${activeOrdinal}` : " · Preparing"} · <span className="experiment-elapsed">{elapsedTime(nowMs - execution.startedAtMs)} elapsed</span></>
              : `${aggregate.requested} requested repetitions`}
          </p>
        </div>
        <div className="repeated-experiment-actions">
          <span className={`run-history-status ${lifecycle}`}>{lifecycle}</span>
          {isRunning && <button className="button stop" type="button" onClick={onStop}>Stop remaining</button>}
          {placement === "request" && onReturnToRequest && <button className="button" type="button" onClick={onReturnToRequest}>Back to request</button>}
        </div>
      </header>

      {isRunning && <progress aria-label="Experiment progress" className="experiment-progress" max={execution.progress.requested} value={execution.progress.finished}>{execution.progress.finished} of {execution.progress.requested}</progress>}

      {execution.storage === "unsaved" && <p className="repeated-experiment-notice" role="status">This experiment is not saved and will be lost when this session closes.</p>}
      {execution.error && <p className="repeated-experiment-notice error" role="alert">{execution.error}</p>}

      <dl className="repeated-experiment-summary" aria-label="Repeated experiment summary">
        <div><dt>Outcomes</dt><dd>{aggregate.completed} completed · {aggregate.failed} failed · {aggregate.cancelled} cancelled</dd></div>
        <div><dt>Unstarted / missing</dt><dd>{aggregate.notRun} not run · {aggregate.missingTrace} missing trace</dd></div>
        <div><dt>Retries observed</dt><dd>{aggregate.runsWithRetries}</dd></div>
        <div><dt>Exact output variants</dt><dd>{aggregate.distinctFinalAssistantOutputs}</dd></div>
        {range("Total duration", aggregate.totalDurationMs, formatDuration)}
        {range("Time to first output", aggregate.ttfoMs, formatDuration)}
        {range("Reported total tokens", aggregate.reportedTotalTokens, formatTokens)}
        {range("Reported output tokens", aggregate.reportedOutputTokens, formatTokens)}
        {range("Output throughput", aggregate.outputTokensPerSecond, formatRate)}
        {range("Output characters", aggregate.outputCharacterCount, (value) => value?.toLocaleString() ?? "—")}
        <div><dt>Summed reported total tokens</dt><dd>{formatTokens(aggregate.totalTokens.total)} across {aggregate.totalTokens.reportedRuns} runs</dd></div>
        <div><dt>Summed reported output tokens</dt><dd>{formatTokens(aggregate.outputTokens.total)} across {aggregate.outputTokens.reportedRuns} runs</dd></div>
      </dl>

      <div className="repeated-experiment-rows">
        {execution.plan.cells.map((cell) => {
          const state = execution.progress.states.get(cell.runId);
          const trace = execution.traces.get(cell.runId);
          const isActive = activeOrdinal === cell.ordinal;
          const status = isActive ? "running" : rowStatus(execution, cell.runId);
          const isSelected = execution.selectedRunId === cell.runId;
          const preview = outputPreview(state);
          return (
            <article
              aria-current={isSelected ? "true" : undefined}
              className={`repeated-experiment-row${isActive ? " active" : ""}${isSelected ? " selected" : ""}`}
              key={cell.cellId}
            >
              <div><strong>Repetition {cell.ordinal}</strong><span className={`run-history-status ${status}`}>{isActive && <span className="experiment-row-activity-dot" aria-hidden="true" />}{status}</span></div>
              <span className="repeated-experiment-row-metrics">{rowMetrics(state)}</span>
              {trace ? <button className="text-button" type="button" onClick={() => onOpenTrace(cell.runId)}>Open Response &amp; Inspect</button> : <span className="repeated-experiment-row-pending">{status === "queued" ? "Waiting" : "Trace unavailable"}</span>}
              {preview !== undefined && <p className="repeated-experiment-output-preview"><span>Output ready</span>{preview}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
