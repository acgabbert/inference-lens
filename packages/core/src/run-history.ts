import type {
  RunId,
  RunState,
  RunTokenUsage,
  RunTrace,
  TerminalRunStatus,
} from "./run-kernel/types.ts";
import { runMetrics } from "./run-metrics.ts";
import { parseRunTraceJson, runStateFromTrace, traceFileName } from "./run-trace.ts";

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

export interface LoadedRunHistoryFiles {
  items: RunHistoryItem[];
  failures: RunHistoryFailure[];
  /**
   * The run state each listed artifact reduces to, which the list projection
   * has already derived. Grouped projections read it instead of reducing the
   * same events a second time. It holds every event of every artifact in the
   * folder, so callers should build their projection and drop it.
   */
  statesByRunId: ReadonlyMap<RunId, { fileName: string; state: RunState }>;
}

/** Builds the list projection through the same validated state used by the UI. */
export function summarizeRunTrace(trace: RunTrace): RunHistorySummary {
  return summarizeReducedRunTrace(trace, runStateFromTrace(trace));
}

/** Summarizes a trace whose state the caller has already reduced. */
function summarizeReducedRunTrace(
  trace: RunTrace,
  state: RunState,
): RunHistorySummary {
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
  const { items, failures } = loadRunHistoryFilesWithStates(files);
  return { items, failures };
}

/**
 * Parses and reduces every trace exactly once while a caller builds a richer
 * on-demand projection, so grouped history costs one pass over the folder
 * rather than one pass per projection.
 */
export function loadRunHistoryFilesWithStates(
  files: RunHistorySource[],
): LoadedRunHistoryFiles {
  const items: RunHistoryItem[] = [];
  const failures: RunHistoryFailure[] = [];
  const statesByRunId = new Map<RunId, { fileName: string; state: RunState }>();

  for (const file of files) {
    try {
      const trace = parseRunTraceJson(file.contents);
      const state = runStateFromTrace(trace);
      items.push({
        fileName: file.fileName,
        summary: summarizeReducedRunTrace(trace, state),
      });
      // Prefer the canonical filename when duplicate/renamed artifacts carry
      // the same run. The selected filename remains explicit in the read model.
      const current = statesByRunId.get(trace.runId);
      if (!current || file.fileName === traceFileName(trace.runId)) {
        statesByRunId.set(trace.runId, { fileName: file.fileName, state });
      }
    } catch (error) {
      failures.push({
        fileName: file.fileName,
        message:
          error instanceof Error ? error.message : "The trace is invalid.",
      });
    }
  }

  items.sort(compareHistoryItems);
  return { items, failures, statesByRunId };
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
