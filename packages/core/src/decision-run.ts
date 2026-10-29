import type {
  DecisionAttempt,
  DecisionExchangeTrace,
  DecisionExecution,
  DecisionRun,
  DecisionTransportEvent,
  ResolvedDecisionRunInput,
} from "./decision.ts";
import { rateLimitPauseMs } from "./rate-limit-pause.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type { ExchangeId, RunError } from "./run-kernel/types.ts";

/**
 * How a decision run moves (D27): pure functions over `DecisionRun`, so the
 * session hook, tests, and a later CLI share one set of transitions. Every
 * function returns a new run and leaves its argument untouched. A run that
 * ends here is exactly what the D22 trace format accepts.
 *
 * A retryable failure pauses the run (D28); Retry sends the same input again
 * as the next attempt, and Stop ends the pause as failed with that error.
 */

const STOPPED_REASON = "Stopped by user.";

function exchangeIdFor(run: DecisionRun, attempt: number): ExchangeId {
  return createEntityId("exchange", `${run.runId.slice("run_".length)}-${attempt}`);
}

function lastAttempt(run: DecisionRun): DecisionAttempt {
  const attempt = run.attempts.at(-1);
  if (!attempt) throw new Error("The decision run has no attempt.");
  return attempt;
}

function withLastAttempt(run: DecisionRun, attempt: DecisionAttempt): DecisionAttempt[] {
  return [...run.attempts.slice(0, -1), attempt];
}

function requireRunning(run: DecisionRun, action: string): DecisionAttempt {
  if (run.status.kind !== "running") {
    throw new Error(`Cannot ${action}: the decision run is ${run.status.kind}, not running.`);
  }
  return lastAttempt(run);
}

/** A run that has resolved its input and target but sent nothing. */
export function createDecisionRun(input: ResolvedDecisionRunInput): DecisionRun {
  return {
    kind: "decision",
    runId: input.runId,
    input,
    status: { kind: "not_started" },
    attempts: [],
    exchanges: {},
  };
}

/**
 * Records the next attempt and its empty exchange before anything is sent, so
 * a stop before dispatch still leaves an attempt to save (D22).
 */
function beginAttempt(
  run: DecisionRun,
  at: string,
): { run: DecisionRun; execution: DecisionExecution } {
  const number = run.attempts.length + 1;
  const exchangeId = exchangeIdFor(run, number);
  const exchange: DecisionExchangeTrace = { exchangeId, attempt: number, frames: [] };
  return {
    run: {
      ...run,
      status: { kind: "running", attempt: number, exchangeId },
      attempts: [...run.attempts, { attempt: number, exchangeId, status: "running" }],
      exchanges: { ...run.exchanges, [exchangeId]: exchange },
      startedAt: run.startedAt ?? at,
    },
    execution: {
      runId: run.runId,
      attempt: number,
      exchangeId,
      input: { target: run.input.target, decision: run.input.decision },
    },
  };
}

/** Begins attempt 1 of a run that has not started. */
export function beginDecisionAttempt(
  run: DecisionRun,
  at: string,
): { run: DecisionRun; execution: DecisionExecution } {
  if (run.status.kind !== "not_started") {
    throw new Error(`Cannot begin: the decision run is already ${run.status.kind}.`);
  }
  return beginAttempt(run, at);
}

/** Sends the same input again as the next attempt; only a paused run can. */
export function retryDecisionRun(
  run: DecisionRun,
  at: string,
): { run: DecisionRun; execution: DecisionExecution } {
  if (run.status.kind !== "paused") {
    throw new Error(`Cannot retry: the decision run is ${run.status.kind}, not paused.`);
  }
  return beginAttempt(run, at);
}

function failAttempt(run: DecisionRun, error: RunError, at: string): DecisionRun {
  const attempt = requireRunning(run, "fail the attempt");
  const attempts = withLastAttempt(run, {
    attempt: attempt.attempt,
    exchangeId: attempt.exchangeId,
    status: "failed",
    error,
  });
  if (error.retryable) {
    return {
      ...run,
      attempts,
      status: {
        kind: "paused",
        reason: "attempt_failed",
        attempt: attempt.attempt,
        exchangeId: attempt.exchangeId,
        error,
      },
    };
  }
  return { ...run, attempts, status: { kind: "failed", failedAt: at, error }, endedAt: at };
}

function cancelAttempt(run: DecisionRun, at: string, reason?: string): DecisionRun {
  const attempt = requireRunning(run, "cancel the attempt");
  return {
    ...run,
    attempts: withLastAttempt(run, {
      attempt: attempt.attempt,
      exchangeId: attempt.exchangeId,
      status: "cancelled",
    }),
    status: {
      kind: "cancelled",
      cancelledAt: at,
      ...(reason === undefined ? {} : { reason }),
    },
    endedAt: at,
  };
}

function updateExchange(
  run: DecisionRun,
  exchangeId: ExchangeId,
  change: Partial<DecisionExchangeTrace>,
): DecisionRun {
  const exchange = run.exchanges[exchangeId]!;
  return { ...run, exchanges: { ...run.exchanges, [exchangeId]: { ...exchange, ...change } } };
}

/** Applies one host event to the running attempt. */
export function applyDecisionEvent(
  run: DecisionRun,
  event: DecisionTransportEvent,
  at: string,
): DecisionRun {
  const attempt = requireRunning(run, `apply ${event.type}`);
  const { exchangeId } = attempt;
  switch (event.type) {
    case "request":
      return updateExchange(run, exchangeId, { request: event.request });
    case "response_started":
      return updateExchange(run, exchangeId, { response: event.response });
    case "frame":
      // D22 saves at most one frame per exchange. A host never sends a second,
      // so one that does is a protocol failure, not evidence to overwrite.
      if (run.exchanges[exchangeId]!.frames.length > 0) {
        return failAttempt(
          run,
          {
            code: "protocol_error",
            message: "The host sent more than one frame for a decision exchange.",
            retryable: false,
          },
          at,
        );
      }
      return updateExchange(run, exchangeId, { frames: [{ ...event.frame, index: 0 }] });
    case "completed":
      return {
        ...run,
        attempts: withLastAttempt(run, {
          attempt: attempt.attempt,
          exchangeId,
          status: "completed",
          result: event.result,
        }),
        status: { kind: "completed", completedAt: at },
        endedAt: at,
      };
    case "failed":
      return failAttempt(run, event.error, at);
    case "cancelled":
      return cancelAttempt(run, at, event.reason);
  }
}

/**
 * Settles an attempt whose stream ended without an outcome. A run that has
 * already settled is returned unchanged.
 */
export function finishDecisionAttemptStream(run: DecisionRun, at: string): DecisionRun {
  if (run.status.kind !== "running") return run;
  return failAttempt(
    run,
    {
      code: "protocol_error",
      message: "The decision stream ended without a result or an error.",
      retryable: false,
    },
    at,
  );
}

/**
 * The user's Stop. An attempt in flight is cancelled; a paused run ends as
 * failed with its attempt's error, as chat's Stop does (D22). Any other run is
 * returned unchanged.
 */
export function stopDecisionRun(run: DecisionRun, at: string): DecisionRun {
  switch (run.status.kind) {
    case "running":
      return cancelAttempt(run, at, STOPPED_REASON);
    case "paused":
      return {
        ...run,
        status: { kind: "failed", failedAt: at, error: run.status.error },
        endedAt: at,
      };
    default:
      return run;
  }
}

/**
 * How long Retry waits after a paused run's 429 (D23), by the same header rules
 * as batches; undefined when the run is not paused on a provider 429.
 */
export function decisionRetryWaitMs(run: DecisionRun, now: number): number | undefined {
  const { status } = run;
  if (
    status.kind !== "paused" ||
    status.error.code !== "provider_error" ||
    status.error.providerStatus !== 429
  ) {
    return undefined;
  }
  return rateLimitPauseMs(run.exchanges[status.exchangeId]?.response?.headers, now);
}

export interface DecisionAttemptDriverOptions {
  /** A run whose latest attempt is running, as begin or retry returned it. */
  run: DecisionRun;
  execution: DecisionExecution;
  /**
   * Starts the exchange and returns its events. The caller composes the
   * credential and the host transport here, which keeps core free of both.
   */
  open(execution: DecisionExecution, signal: AbortSignal): Promise<AsyncIterable<DecisionTransportEvent>>;
  signal: AbortSignal;
  /** Prevents a superseded attempt from reporting any change. */
  isCurrent?(): boolean;
  now?(): string;
  /** Called after every applied event and after the stream settles. */
  onRunChange?(run: DecisionRun): void;
}

export type DecisionAttemptOutcome = "settled" | "aborted" | "superseded";

/**
 * A thrown host failure, classified as chat's driver does: retryable unless it
 * is malformed output or an HTTP status that repeating cannot change.
 */
function thrownError(error: unknown): RunError {
  const status =
    typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
  const malformed = error instanceof SyntaxError;
  return {
    code: malformed ? "protocol_error" : "transport_error",
    message: error instanceof Error ? error.message : "Request failed.",
    retryable:
      !malformed &&
      (status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599)),
  };
}

/**
 * Drives one attempt through a host. An abort is left to the caller, whose
 * Stop decides the run's terminal state; a superseded attempt reports nothing.
 */
export async function driveDecisionAttempt({
  run: initial,
  execution,
  open,
  signal,
  isCurrent = () => true,
  now = () => new Date().toISOString(),
  onRunChange,
}: DecisionAttemptDriverOptions): Promise<{ outcome: DecisionAttemptOutcome; run: DecisionRun }> {
  let run = initial;
  try {
    const events = await open(execution, signal);
    for await (const event of events) {
      if (signal.aborted) return { outcome: "aborted", run };
      if (!isCurrent()) return { outcome: "superseded", run };
      run = applyDecisionEvent(run, event, now());
      onRunChange?.(run);
      if (run.status.kind !== "running") return { outcome: "settled", run };
    }
    if (signal.aborted) return { outcome: "aborted", run };
    if (!isCurrent()) return { outcome: "superseded", run };
    run = finishDecisionAttemptStream(run, now());
    onRunChange?.(run);
    return { outcome: "settled", run };
  } catch (error) {
    if (signal.aborted) return { outcome: "aborted", run };
    if (!isCurrent()) return { outcome: "superseded", run };
    run = failAttempt(run, thrownError(error), now());
    onRunChange?.(run);
    return { outcome: "settled", run };
  }
}
