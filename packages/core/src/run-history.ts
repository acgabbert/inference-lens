import type {
  RunId,
  RunTokenUsage,
  RunTrace,
  TerminalRunStatus,
} from "./run-kernel/types.ts";
import { runMetrics } from "./run-metrics.ts";
import { parseRunTraceJson, runStateFromTrace } from "./run-trace.ts";

/**
 * Compact, derived metadata for a persisted trace. History summaries are
 * never serialized: the immutable trace remains the only source of truth.
 */
export interface RunHistorySummary {
  runId: RunId;
  startedAt: string;
  endedAt: string;
  status: TerminalRunStatus["kind"];
  model: string;
  durationMs?: number;
  usage: RunTokenUsage;
  turnCount: number;
  attemptCount: number;
  retryCount: number;
  messageCount: number;
}

export interface RunHistorySource {
  fileName: string;
  contents: string;
}

export interface RunHistoryItem {
  fileName: string;
  trace: RunTrace;
  summary: RunHistorySummary;
}

export interface RunHistoryFailure {
  fileName: string;
  message: string;
}

/** Builds the list projection through the same validated state used by the UI. */
export function summarizeRunTrace(trace: RunTrace): RunHistorySummary {
  const state = runStateFromTrace(trace);
  const metrics = runMetrics(state);

  return {
    runId: trace.runId,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    status: trace.status.kind,
    model: trace.input.target.model,
    durationMs: metrics.totalDurationMs,
    usage: metrics.usage,
    turnCount: metrics.turnCount,
    attemptCount: metrics.attemptCount,
    retryCount: metrics.retryCount,
    messageCount: trace.input.messages.length,
  };
}

/**
 * Validates files independently so one damaged or unrelated JSON artifact
 * cannot hide otherwise trustworthy project history.
 */
export function loadRunHistoryFiles(files: RunHistorySource[]): {
  items: RunHistoryItem[];
  failures: RunHistoryFailure[];
} {
  const items: RunHistoryItem[] = [];
  const failures: RunHistoryFailure[] = [];

  for (const file of files) {
    try {
      const trace = parseRunTraceJson(file.contents);
      items.push({
        fileName: file.fileName,
        trace,
        summary: summarizeRunTrace(trace),
      });
    } catch (error) {
      failures.push({
        fileName: file.fileName,
        message:
          error instanceof Error ? error.message : "The trace is invalid.",
      });
    }
  }

  items.sort((left, right) =>
    right.summary.startedAt.localeCompare(left.summary.startedAt),
  );
  return { items, failures };
}
