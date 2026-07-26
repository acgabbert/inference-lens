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

/**
 * A listed entry carries only its summary, not the trace it came from. The
 * list is built by parsing every artifact in the folder, but retaining those
 * traces would hold every event and every raw SSE line the project has ever
 * recorded in memory to render a few lines of text each. The selected trace is
 * read again from its file, which also means the opened run reflects the
 * artifact as it is on disk rather than as it was when the list was built.
 */
export interface RunHistoryItem {
  fileName: string;
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
      items.push({
        fileName: file.fileName,
        summary: summarizeRunTrace(parseRunTraceJson(file.contents)),
      });
    } catch (error) {
      failures.push({
        fileName: file.fileName,
        message:
          error instanceof Error ? error.message : "The trace is invalid.",
      });
    }
  }

  items.sort(compareHistoryItems);
  return { items, failures };
}

/**
 * Newest first. Runs started within the same millisecond fall back to the file
 * name so the list has one stable order rather than one that depends on the
 * order the filesystem happened to enumerate.
 */
function compareHistoryItems(
  left: RunHistoryItem,
  right: RunHistoryItem,
): number {
  if (left.summary.startedAt !== right.summary.startedAt) {
    return left.summary.startedAt < right.summary.startedAt ? 1 : -1;
  }
  if (left.fileName === right.fileName) return 0;
  return left.fileName < right.fileName ? 1 : -1;
}
