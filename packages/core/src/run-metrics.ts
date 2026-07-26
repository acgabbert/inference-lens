import type {
  AttemptStatus,
  ExchangeId,
  RunEvent,
  RunId,
  RunState,
  RunTokenUsage,
  TurnId,
} from "./run-kernel/types.ts";

export type AttemptMetricStatus = AttemptStatus | "cancelled";

/**
 * Timing and cost projected from a run's event stream. Like the transcript
 * projection, this is derived state: it is never persisted, never part of the
 * RunTrace envelope, and is reconstructed identically from a live run or an
 * imported trace.
 *
 * Every timing is a millisecond delta between two `elapsedMs` stamps, which
 * the event factory assigns relative to run start and the reducer validates as
 * non-negative. Wall-clock `occurredAt` strings are deliberately unused: they
 * carry no additional precision and would introduce clock-skew artifacts.
 *
 * A metric is `undefined` when the run has not produced the evidence for it.
 * Callers must render that absence rather than substituting zero.
 */
export interface AttemptMetrics {
  turnId: TurnId;
  /** 1-based position of this attempt's turn, for display. IDs are opaque. */
  turnIndex: number;
  attempt: number;
  exchangeId: ExchangeId;
  /** Elapsed stamps, relative to run start. */
  requestedAtMs?: number;
  firstByteAtMs?: number;
  /** First model output of any kind: reasoning, visible text, or tool call. */
  firstOutputAtMs?: number;
  firstTextAtMs?: number;
  firstReasoningAtMs?: number;
  firstToolCallAtMs?: number;
  endedAtMs?: number;
  /**
   * Latencies relative to this attempt's own request, not to run start, so a
   * retried attempt reports its own latency instead of inheriting the time
   * spent on the attempt that failed before it.
   */
  ttfbMs?: number;
  ttfoMs?: number;
  durationMs?: number;
  usage?: RunTokenUsage;
  /** Output throughput; excludes the wait before the first model output. */
  outputTokensPerSecond?: number;
  status: AttemptMetricStatus;
}

export interface RunMetrics {
  runId: RunId;
  statusKind: RunState["status"]["kind"];
  /** Wall time from run start to the most recent event; grows while running. */
  totalDurationMs?: number;
  /** Latency of the first attempt that produced model output. */
  ttfoMs?: number;
  /**
   * Summed across every attempt that reported usage, including attempts that
   * later failed and were retried, because those tokens were still billed.
   */
  usage: RunTokenUsage;
  outputTokensPerSecond?: number;
  turnCount: number;
  attemptCount: number;
  retryCount: number;
  eventCount: number;
  attempts: AttemptMetrics[];
}

interface AttemptTimings {
  requestedAtMs?: number;
  firstByteAtMs?: number;
  firstOutputAtMs?: number;
  firstTextAtMs?: number;
  firstReasoningAtMs?: number;
  firstToolCallAtMs?: number;
  endedAtMs?: number;
}

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof RunTokenUsage)[];

function attemptKey(turnId: TurnId, attempt: number): string {
  return `${turnId}#${attempt}`;
}

/** Narrows the RunEvent union to the members carrying attempt identity. */
function attemptIdentity(
  event: RunEvent,
): { turnId: TurnId; attempt: number } | undefined {
  return "turnId" in event && "attempt" in event
    ? { turnId: event.turnId, attempt: event.attempt }
    : undefined;
}

/**
 * Collects the first occurrence of each timing landmark per attempt. Only the
 * first delta of a kind matters, so later ones are ignored rather than
 * overwriting an earlier, correct stamp.
 */
function collectTimings(events: RunEvent[]): Map<string, AttemptTimings> {
  const timings = new Map<string, AttemptTimings>();

  for (const event of events) {
    const identity = attemptIdentity(event);
    if (!identity) continue;

    const key = attemptKey(identity.turnId, identity.attempt);
    let entry = timings.get(key);
    if (!entry) {
      entry = {};
      timings.set(key, entry);
    }

    switch (event.type) {
      case "exchange.requested":
        entry.requestedAtMs ??= event.elapsedMs;
        break;
      case "exchange.response_started":
        entry.firstByteAtMs ??= event.elapsedMs;
        break;
      case "assistant.text_delta":
        entry.firstTextAtMs ??= event.elapsedMs;
        entry.firstOutputAtMs ??= event.elapsedMs;
        break;
      case "assistant.reasoning_delta":
        entry.firstReasoningAtMs ??= event.elapsedMs;
        entry.firstOutputAtMs ??= event.elapsedMs;
        break;
      case "assistant.tool_call_delta":
        entry.firstToolCallAtMs ??= event.elapsedMs;
        entry.firstOutputAtMs ??= event.elapsedMs;
        break;
      case "assistant.completed":
      case "turn.attempt_failed":
        entry.endedAtMs ??= event.elapsedMs;
        break;
      default:
        break;
    }
  }

  return timings;
}

/** Returns `to - from` only when both stamps exist, preserving absence. */
function delta(from?: number, to?: number): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  return Math.max(0, to - from);
}

/**
 * Tokens per second over an output span. A zero-length span means the
 * evidence cannot support a rate, so none is reported: a fabricated rate would
 * be indistinguishable from a measured one.
 */
function throughput(outputTokens?: number, spanMs?: number): number | undefined {
  if (outputTokens === undefined || spanMs === undefined) return undefined;
  if (spanMs <= 0) return undefined;
  return (outputTokens * 1000) / spanMs;
}

/**
 * Adds usage across attempts. A field stays absent unless at least one attempt
 * reported it, so "the provider never told us" is not flattened into zero.
 */
function sumUsage(reported: RunTokenUsage[]): RunTokenUsage {
  const total: RunTokenUsage = {};
  for (const field of USAGE_FIELDS) {
    let sum: number | undefined;
    for (const usage of reported) {
      const value = usage[field];
      if (typeof value === "number") sum = (sum ?? 0) + value;
    }
    if (sum !== undefined) total[field] = sum;
  }
  return total;
}

function attemptMetrics(
  turnId: TurnId,
  turnIndex: number,
  attempt: number,
  exchangeId: ExchangeId,
  status: AttemptMetricStatus,
  usage: RunTokenUsage | undefined,
  timings: AttemptTimings,
): AttemptMetrics {
  const outputSpanMs = delta(timings.firstOutputAtMs, timings.endedAtMs);

  return {
    turnId,
    turnIndex,
    attempt,
    exchangeId,
    status,
    ...timings,
    ttfbMs: delta(timings.requestedAtMs, timings.firstByteAtMs),
    ttfoMs: delta(timings.requestedAtMs, timings.firstOutputAtMs),
    durationMs: delta(timings.requestedAtMs, timings.endedAtMs),
    usage,
    outputTokensPerSecond: throughput(usage?.outputTokens, outputSpanMs),
  };
}

function terminalAttemptEnd(
  state: RunState,
): { atMs: number; status: AttemptMetricStatus } | undefined {
  if (state.status.kind !== "failed" && state.status.kind !== "cancelled") {
    return undefined;
  }
  const terminal = state.events.at(-1);
  if (
    !terminal ||
    (terminal.type !== "run.failed" && terminal.type !== "run.cancelled")
  ) {
    return undefined;
  }
  return {
    atMs: terminal.elapsedMs,
    status: state.status.kind === "cancelled" ? "cancelled" : "failed",
  };
}

/**
 * Projects timing and token metrics from run state. Pure: no clock, no I/O,
 * and no mutation of the state passed in.
 */
export function runMetrics(state: RunState): RunMetrics {
  const timings = collectTimings(state.events);
  const terminalEnd = terminalAttemptEnd(state);
  const activeAttempt = state.turns.at(-1)?.attempts.at(-1);
  const attempts: AttemptMetrics[] = [];

  for (const [turnIndex, turn] of state.turns.entries()) {
    for (const attempt of turn.attempts) {
      const attemptTimings =
        timings.get(attemptKey(turn.turnId, attempt.attempt)) ?? {};
      const closesWithRun =
        attempt.status === "streaming" &&
        terminalEnd !== undefined &&
        attempt === activeAttempt;
      attempts.push(
        attemptMetrics(
          turn.turnId,
          turnIndex + 1,
          attempt.attempt,
          attempt.exchangeId,
          closesWithRun ? terminalEnd.status : attempt.status,
          attempt.usage,
          closesWithRun
            ? { ...attemptTimings, endedAtMs: terminalEnd.atMs }
            : attemptTimings,
        ),
      );
    }
  }

  const usage = sumUsage(
    attempts.flatMap(({ usage: reported }) => (reported ? [reported] : [])),
  );

  // Run-level throughput sums only the output spans, so time spent waiting
  // on tool results between turns is not charged against the model's rate.
  let generatedTokens: number | undefined;
  let outputSpanMs: number | undefined;
  for (const attempt of attempts) {
    const span = delta(attempt.firstOutputAtMs, attempt.endedAtMs);
    if (span === undefined || span <= 0) continue;
    const outputTokens = attempt.usage?.outputTokens;
    if (typeof outputTokens !== "number") continue;
    generatedTokens = (generatedTokens ?? 0) + outputTokens;
    outputSpanMs = (outputSpanMs ?? 0) + span;
  }

  const turnCount = state.turns.length;
  const attemptCount = attempts.length;

  return {
    runId: state.runId,
    statusKind: state.status.kind,
    totalDurationMs: state.events.at(-1)?.elapsedMs,
    ttfoMs: attempts.find(({ ttfoMs }) => ttfoMs !== undefined)?.ttfoMs,
    usage,
    outputTokensPerSecond: throughput(generatedTokens, outputSpanMs),
    turnCount,
    attemptCount,
    retryCount: Math.max(0, attemptCount - turnCount),
    eventCount: state.events.length,
    attempts,
  };
}
