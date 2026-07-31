"use client";

import { repeatedExperimentAggregate } from "../../packages/core/src/experiment.ts";
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
  return execution.result?.cells.find((cell) => cell.runId === runId)?.status ?? "queued";
}

function rowMetrics(state: RunState | undefined): string {
  if (!state || !["completed", "failed", "cancelled"].includes(state.status.kind)) return "—";
  const metrics = runMetrics(state);
  return `${formatDuration(metrics.totalDurationMs)} · ${formatTokens(metrics.usage.totalTokens)} tokens`;
}

function range(label: string, values: { count: number; min?: number; median?: number; max?: number }, formatter: (value?: number) => string) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{values.count === 0 ? "—" : `${formatter(values.median)} median · ${formatter(values.min)}–${formatter(values.max)}`}</dd>
    </div>
  );
}

export function RepeatedExperimentWorkspace({
  execution,
  onStop,
  onOpenTrace,
}: {
  execution: RepeatedExperimentExecution;
  onStop(): void;
  onOpenTrace(runId: RunId): void;
}) {
  const aggregate = repeatedExperimentAggregate(
    execution.plan,
    execution.result,
    execution.progress.states,
  );
  const isRunning = execution.progress.status === "running";
  const lifecycle = isRunning ? "running" : execution.error ? "interrupted" : aggregate.lifecycle;

  return (
    <section className="repeated-experiment-workspace" aria-label="Repeated experiment results">
      <header className="repeated-experiment-header">
        <div>
          <span className="eyebrow">{execution.storage === "durable" ? "Saved project experiment" : "Unsaved session experiment"}</span>
          <h2>Repeated experiment</h2>
          <p>{isRunning ? `Completed ${execution.progress.finished} / ${execution.progress.requested}` : `${aggregate.requested} requested repetitions`}</p>
        </div>
        <div className="repeated-experiment-actions">
          <span className={`run-history-status ${lifecycle}`}>{lifecycle}</span>
          {isRunning && <button className="button stop" type="button" onClick={onStop}>Stop remaining</button>}
        </div>
      </header>

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
          const status = rowStatus(execution, cell.runId);
          const trace = execution.traces.get(cell.runId);
          return (
            <article className="repeated-experiment-row" key={cell.cellId}>
              <div><strong>Repetition {cell.ordinal}</strong><span className={`run-history-status ${status}`}>{status}</span></div>
              <span>{rowMetrics(state)}</span>
              {trace ? <button className="text-button" type="button" onClick={() => onOpenTrace(cell.runId)}>Open Response &amp; Inspect</button> : <span className="repeated-experiment-row-pending">{status === "queued" ? "Waiting" : "Trace unavailable"}</span>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
