"use client";

import type {
  AttemptMetrics,
  RunMetrics,
} from "../packages/core/src/run-metrics";

interface RunMetricsViewProps {
  metrics: RunMetrics | null;
}

const ABSENT = "—";

/**
 * Formats a millisecond duration. Absent values render as a dash rather than
 * zero: a run that never reported a timing is not a run that took no time.
 */
function formatDuration(value?: number): string {
  if (value === undefined) return ABSENT;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(2)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = (value % 60_000) / 1000;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function formatRate(value?: number): string {
  if (value === undefined) return ABSENT;
  return `${value.toFixed(1)} tok/s`;
}

function formatTokens(value?: number): string {
  if (value === undefined) return ABSENT;
  return value.toLocaleString();
}

/** Turn IDs are opaque, so attempts are labelled by position instead. */
function attemptLabel({ turnIndex, attempt }: AttemptMetrics): string {
  return attempt === 1
    ? `Turn ${turnIndex}`
    : `Turn ${turnIndex} · retry ${attempt - 1}`;
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
export function RunMetricsView({ metrics }: RunMetricsViewProps) {
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
