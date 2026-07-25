"use client";

import type { RunMetrics } from "../packages/core/src/run-metrics";
import type { RunTimeline } from "../packages/core/src/run-timeline";
import {
  attemptLabel,
  formatDuration,
  formatRate,
  formatTokens,
} from "./run-metrics-format.client";
import { RunTimelineView } from "./run-timeline-view.client";

interface RunMetricsViewProps {
  metrics: RunMetrics | null;
  timeline: RunTimeline | null;
}

function SummaryTile({ label, value, hint }: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="run-metric-tile">
      <span className="run-metric-label">{label}</span>
      <span className="run-metric-value">{value}</span>
      {hint && <span className="run-metric-hint">{hint}</span>}
    </div>
  );
}

/**
 * Presents derived run timing and token metrics. Purely presentational: it
 * receives a projection and never derives, fetches, or stores anything.
 */
export function RunMetricsView({ metrics, timeline }: RunMetricsViewProps) {
  if (!metrics || metrics.attempts.length === 0) {
    return (
      <p className="trace-empty">
        Run timing and token metrics will appear here.
      </p>
    );
  }

  const { usage } = metrics;

  return (
    <div className="run-metrics">
      <div className="run-metrics-summary">
        <SummaryTile
          label="Duration"
          value={formatDuration(metrics.totalDurationMs)}
          hint={metrics.statusKind === "running" ? "still running" : undefined}
        />
        <SummaryTile
          label="Time to first token"
          value={formatDuration(metrics.ttftMs)}
          hint="from request"
        />
        <SummaryTile
          label="Throughput"
          value={formatRate(metrics.outputTokensPerSecond)}
          hint="generation only"
        />
        <SummaryTile
          label="Total tokens"
          value={formatTokens(usage.totalTokens)}
          hint={`${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out`}
        />
      </div>

      <dl className="run-metrics-counts">
        <div>
          <dt>Turns</dt>
          <dd>{metrics.turnCount}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{metrics.attemptCount}</dd>
        </div>
        <div>
          <dt>Retries</dt>
          <dd>{metrics.retryCount}</dd>
        </div>
        {usage.cachedInputTokens !== undefined && (
          <div>
            <dt>Cached input</dt>
            <dd>{formatTokens(usage.cachedInputTokens)}</dd>
          </div>
        )}
        {usage.reasoningTokens !== undefined && (
          <div>
            <dt>Reasoning</dt>
            <dd>{formatTokens(usage.reasoningTokens)}</dd>
          </div>
        )}
      </dl>

      {timeline && <RunTimelineView timeline={timeline} />}

      <div className="run-metrics-table-scroll">
        <table className="run-metrics-table">
          <caption className="visually-hidden">
            Per-attempt timing and token metrics
          </caption>
          <thead>
            <tr>
              <th scope="col">Attempt</th>
              <th scope="col">Status</th>
              <th scope="col">TTFB</th>
              <th scope="col">TTFT</th>
              <th scope="col">Duration</th>
              <th scope="col">Out tokens</th>
              <th scope="col">Rate</th>
            </tr>
          </thead>
          <tbody>
            {metrics.attempts.map((attempt) => (
              <tr key={attempt.exchangeId}>
                <th scope="row">{attemptLabel(attempt)}</th>
                <td>
                  <span className={`attempt-status ${attempt.status}`}>
                    {attempt.status}
                  </span>
                </td>
                <td>{formatDuration(attempt.ttfbMs)}</td>
                <td>{formatDuration(attempt.ttftMs)}</td>
                <td>{formatDuration(attempt.durationMs)}</td>
                <td>{formatTokens(attempt.usage?.outputTokens)}</td>
                <td>{formatRate(attempt.outputTokensPerSecond)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
