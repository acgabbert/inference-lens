import type {
  ConversationMessage,
  ProviderProtocol,
  RunId,
  RunState,
  RunTokenUsage,
  RunTrace,
  TerminalRunStatus,
} from "./run-kernel/types.ts";
import type { DecisionRun, DecisionWireProtocol } from "./decision.ts";
import { decisionRunFromTrace, type DecisionRunTrace } from "./decision-trace.ts";
import { runMetrics } from "./run-metrics.ts";
import { parseSavedRunTraceJson, runStateFromTrace, traceFileName } from "./run-trace.ts";

/**
 * Compact, derived metadata for a persisted trace. History summaries are
 * never serialized: the immutable trace remains the only source of truth.
 */
export interface RunHistorySummary {
  kind: "chat";
  runId: RunId;
  startedAt: string;
  endedAt: string;
  status: TerminalRunStatus["kind"];
  model: string;
  protocol: ProviderProtocol;
  /** What the user last asked, for recognising a row; see `runRequestExcerpt`. */
  requestExcerpt?: string;
  durationMs?: number;
  usage: RunTokenUsage;
  turnCount: number;
  attemptCount: number;
  retryCount: number;
  messageCount: number;
}

/** A decision run's row: what was asked of which model, and how it ended. */
export interface DecisionRunHistorySummary {
  kind: "decision";
  runId: RunId;
  startedAt: string;
  endedAt: string;
  status: TerminalRunStatus["kind"];
  model: string;
  protocol: DecisionWireProtocol;
  questionCount: number;
  attemptCount: number;
  durationMs: number;
}

export type SavedRunHistorySummary = RunHistorySummary | DecisionRunHistorySummary;

export interface RunHistorySource {
  fileName: string;
  contents: string;
  readError?: string;
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
  summary: SavedRunHistorySummary;
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
  /** Chat runs only; a decision run has no event-reduced state. */
  statesByRunId: ReadonlyMap<RunId, { fileName: string; state: RunState }>;
  /** Decision runs, as their traces restore them, for decision evaluations. */
  decisionRunsByRunId: ReadonlyMap<RunId, { fileName: string; run: DecisionRun }>;
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
    kind: "chat",
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
    protocol: trace.input.target.protocol,
    ...excerptField(trace.input.messages),
  };
}

export function summarizeDecisionRunTrace(
  trace: DecisionRunTrace,
): DecisionRunHistorySummary {
  return {
    kind: "decision",
    runId: trace.runId,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    status: trace.status.kind,
    model: trace.input.target.model,
    protocol: trace.input.target.protocol,
    questionCount: Object.keys(trace.input.decision.questions).length,
    attemptCount: trace.attempts.length,
    durationMs: Date.parse(trace.endedAt) - Date.parse(trace.startedAt),
  };
}

const REQUEST_EXCERPT_LENGTH = 120;

/**
 * The text of the last user message, collapsed to one line and shortened.
 *
 * A run is recognised by what was asked of it far more readily than by its
 * model or identifier, and the request is already in every trace, so this is
 * derived rather than stored. Absent when no user message carries text.
 */
export function runRequestExcerpt(
  messages: readonly ConversationMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const text = message.content
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    return text.length <= REQUEST_EXCERPT_LENGTH
      ? text
      : `${text.slice(0, REQUEST_EXCERPT_LENGTH - 1).trimEnd()}…`;
  }
  return undefined;
}

function excerptField(
  messages: readonly ConversationMessage[],
): { requestExcerpt?: string } {
  const requestExcerpt = runRequestExcerpt(messages);
  return requestExcerpt === undefined ? {} : { requestExcerpt };
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
  const decisionRunsByRunId = new Map<RunId, { fileName: string; run: DecisionRun }>();

  for (const file of files) {
    try {
      if (file.readError !== undefined) throw new Error(file.readError);
      const saved = parseSavedRunTraceJson(file.contents);
      if (saved.kind === "decision") {
        items.push({
          fileName: file.fileName,
          summary: summarizeDecisionRunTrace(saved.trace),
        });
        const current = decisionRunsByRunId.get(saved.trace.runId);
        if (!current || file.fileName === traceFileName(saved.trace.runId)) {
          decisionRunsByRunId.set(saved.trace.runId, { fileName: file.fileName, run: decisionRunFromTrace(saved.trace) });
        }
        continue;
      }
      const { trace } = saved;
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
  return { items, failures, statesByRunId, decisionRunsByRunId };
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
