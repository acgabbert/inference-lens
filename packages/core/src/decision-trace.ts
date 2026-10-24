import { z } from "zod";

import {
  isDecisionInput,
  type DecisionAttempt,
  type DecisionExchangeTrace,
  type DecisionRun,
  type ResolvedDecisionRunInput,
} from "./decision.ts";
import { RunTraceValidationError } from "./run-trace-error.ts";
import type {
  ExchangeId,
  JsonValue,
  RunError,
  RunId,
  TerminalRunStatus,
} from "./run-kernel/types.ts";
import { stableJsonValue } from "./stable-json.ts";

/**
 * The saved form of a finished decision run (D22): the terminal `DecisionRun`
 * as it was, not an event log. A decision exchange has a single frame, so
 * events would only repeat what the exchange trace already holds. Import checks
 * the shape and the consistency between the parts, then uses the run as stored;
 * it does not re-normalize raw bodies, so a later adapter rule cannot reject a
 * trace that was valid when saved.
 *
 * `run-trace.ts` owns the file envelope, filenames, serialization, and dispatch
 * by `kind`; this module owns what a decision trace must hold.
 */
export interface DecisionRunTrace {
  schemaVersion: 8;
  kind: "decision";
  runId: RunId;
  input: ResolvedDecisionRunInput;
  status: TerminalRunStatus;
  /** Numbered 1…n, n ≥ 1; every attempt before the last failed. */
  attempts: DecisionAttempt[];
  exchanges: Record<ExchangeId, DecisionExchangeTrace>;
  startedAt: string;
  endedAt: string;
}

export const DECISION_TRACE_SCHEMA_VERSION = 8;

/**
 * Subtrees whose key order is authored meaning: question order, option order,
 * and the answers and probabilities that follow them. Everything else in the
 * file uses the usual deterministic order.
 */
export const DECISION_TRACE_ORDER_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "decision",
  "result",
]);

const runIdSchema = z.string().regex(/^run_.+/);
const exchangeIdSchema = z.string().regex(/^exchange_.+/);
const timestampSchema = z.string().datetime();
const probabilitySchema = z.number().min(0).max(1);
const probabilitiesSchema = z.record(z.string(), probabilitySchema);

const runErrorSchema = z
  .object({
    code: z.enum([
      "invalid_input",
      "provider_error",
      "transport_error",
      "protocol_error",
      "tool_error",
      "internal_error",
    ]),
    message: z.string(),
    retryable: z.boolean().optional(),
    providerStatus: z.number().int().optional(),
    details: z.unknown().optional(),
  })
  .strict();

const usageSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
    cachedInputTokens: z.number().nonnegative().optional(),
    reasoningTokens: z.number().nonnegative().optional(),
  })
  .strict();

const answerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("choice"),
      choice: z.string(),
      probabilities: probabilitiesSchema,
      confidence: probabilitySchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("score"),
      score: z.number(),
      probabilities: probabilitiesSchema,
      legend: z.record(z.string(), z.unknown()).optional(),
      confidence: probabilitySchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("noul"), noul: probabilitySchema }).strict(),
]);

const attemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    exchangeId: exchangeIdSchema,
    // A saved attempt has finished; `running` exists only in a live session.
    status: z.enum(["completed", "failed", "cancelled"]),
    result: z
      .object({
        model: z.string().optional(),
        answers: z.record(z.string(), answerSchema),
        usage: usageSchema.optional(),
      })
      .strict()
      .optional(),
    error: runErrorSchema.optional(),
  })
  .strict();

const exchangeSchema = z
  .object({
    exchangeId: exchangeIdSchema,
    attempt: z.number().int().positive(),
    request: z
      .object({
        url: z.string(),
        method: z.string(),
        headers: z.record(z.string(), z.string()),
        body: z.string().optional(),
      })
      .strict()
      .optional(),
    response: z
      .object({
        status: z.number().int(),
        headers: z.record(z.string(), z.string()),
      })
      .strict()
      .optional(),
    frames: z.array(
      z.object({ index: z.number().int().nonnegative(), raw: z.string() }).strict(),
    ),
  })
  .strict();

const statusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed"), completedAt: timestampSchema }).strict(),
  z
    .object({
      kind: z.literal("cancelled"),
      cancelledAt: timestampSchema,
      reason: z.string().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("failed"), failedAt: timestampSchema, error: runErrorSchema })
    .strict(),
]);

const decisionTraceSchema = z
  .object({
    schemaVersion: z.literal(DECISION_TRACE_SCHEMA_VERSION),
    kind: z.literal("decision"),
    runId: runIdSchema,
    input: z
      .object({
        runId: runIdSchema,
        resolvedAt: timestampSchema,
        target: z
          .object({
            profileId: z.string().regex(/^profile_.+/),
            protocol: z.literal("systemone"),
            endpoint: z.string().min(1),
            model: z.string().min(1),
            capabilities: z.record(z.string(), z.boolean()),
          })
          .strict(),
        decision: z.unknown(),
      })
      .strict(),
    status: statusSchema,
    attempts: z.array(attemptSchema).min(1),
    exchanges: z.record(z.string(), exchangeSchema),
    startedAt: timestampSchema,
    endedAt: timestampSchema,
  })
  .strict();

function invalid(path: string, problem: string): never {
  throw new RunTraceValidationError(`Invalid decision trace at ${path}: ${problem}.`);
}

function sameJson(left: JsonValue | RunError, right: JsonValue | RunError): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

function terminalTime(status: TerminalRunStatus): string {
  switch (status.kind) {
    case "completed":
      return status.completedAt;
    case "cancelled":
      return status.cancelledAt;
    case "failed":
      return status.failedAt;
  }
}

function checkAttempts(trace: DecisionRunTrace): void {
  const { attempts, exchanges } = trace;
  const questions = trace.input.decision.questions;
  const used = new Set<string>();

  attempts.forEach((attempt, index) => {
    const path = `attempts.${index}`;
    if (attempt.attempt !== index + 1) {
      invalid(path, `expected attempt ${index + 1}, found ${attempt.attempt}`);
    }
    if (used.has(attempt.exchangeId) || !Object.hasOwn(exchanges, attempt.exchangeId)) {
      invalid(path, `exchange ${attempt.exchangeId} is missing or shared with another attempt`);
    }
    used.add(attempt.exchangeId);

    const last = index === attempts.length - 1;
    if (!last && attempt.status !== "failed") {
      invalid(path, `is ${attempt.status}, but only a failed attempt can be retried`);
    }
    switch (attempt.status) {
      case "completed": {
        if (!attempt.result || attempt.error) {
          invalid(path, "a completed attempt needs a result and no error");
        }
        const answers = attempt.result.answers;
        for (const questionId of Object.keys(answers)) {
          if (!Object.hasOwn(questions, questionId)) {
            invalid(`${path}.result.answers`, `"${questionId}" answers no asked question`);
          }
        }
        for (const [questionId, question] of Object.entries(questions)) {
          if (!Object.hasOwn(answers, questionId)) {
            invalid(`${path}.result.answers`, `"${questionId}" has no answer`);
          }
          if (answers[questionId]!.type !== question.type) {
            invalid(
              `${path}.result.answers.${questionId}`,
              `a ${answers[questionId]!.type} answer to a ${question.type} question`,
            );
          }
        }
        break;
      }
      case "failed":
        if (!attempt.error || attempt.result) {
          invalid(path, "a failed attempt needs an error and no result");
        }
        break;
      case "cancelled":
        if (attempt.error || attempt.result) {
          invalid(path, "a cancelled attempt holds neither a result nor an error");
        }
        break;
    }
  });

  for (const [key, exchange] of Object.entries(exchanges)) {
    const path = `exchanges.${key}`;
    if (!used.has(key)) invalid(path, "no attempt made this exchange");
    if (exchange.exchangeId !== key) invalid(`${path}.exchangeId`, "differs from its key");
    const owner = attempts.find((attempt) => attempt.exchangeId === key)!;
    if (exchange.attempt !== owner.attempt) {
      invalid(`${path}.attempt`, `belongs to attempt ${owner.attempt}`);
    }
    if (
      exchange.frames.length > 1 ||
      exchange.frames.some((frame) => frame.index !== 0)
    ) {
      invalid(`${path}.frames`, "a decision exchange has at most one frame, at index 0");
    }
  }
}

function checkStatus(trace: DecisionRunTrace): void {
  const { status } = trace;
  const last = trace.attempts.at(-1)!;
  if (last.status !== status.kind) {
    invalid("status", `the run is ${status.kind} but its last attempt is ${last.status}`);
  }
  if (status.kind === "failed" && !sameJson(status.error, last.error!)) {
    invalid("status.error", "differs from the last attempt's error");
  }
  if (terminalTime(status) !== trace.endedAt) {
    invalid("status", "its time differs from endedAt");
  }
  if (trace.startedAt > trace.endedAt) invalid("endedAt", "is before startedAt");
}

/**
 * Validates a value already known to claim `kind: "decision"` and returns it
 * as stored. The caller checks that its run ID is safe as a filename.
 */
export function parseDecisionRunTrace(value: unknown): DecisionRunTrace {
  const result = decisionTraceSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new RunTraceValidationError(
      first
        ? `Invalid decision trace at ${first.path.join(".") || "root"}: ${first.message}`
        : "Decision trace is invalid.",
    );
  }
  // The schema checks shape only; the value is returned as stored so that
  // caller-chosen keys such as `__proto__` are never rebuilt.
  const trace = value as DecisionRunTrace;
  if (trace.input.runId !== trace.runId) {
    invalid("input.runId", "names another run");
  }
  if (!isDecisionInput(trace.input.decision)) {
    invalid("input.decision", "is not a decision request with at least one question");
  }
  checkAttempts(trace);
  checkStatus(trace);
  return trace;
}

/** The saved form of a finished run. */
export function decisionRunTrace(run: DecisionRun): DecisionRunTrace {
  const { status, startedAt, endedAt } = run;
  if (
    (status.kind !== "completed" && status.kind !== "failed" && status.kind !== "cancelled") ||
    startedAt === undefined ||
    endedAt === undefined
  ) {
    throw new RunTraceValidationError("Only a finished decision run can be saved.");
  }
  return parseDecisionRunTrace({
    schemaVersion: DECISION_TRACE_SCHEMA_VERSION,
    kind: "decision",
    runId: run.runId,
    input: run.input,
    status,
    attempts: run.attempts,
    exchanges: run.exchanges,
    startedAt,
    endedAt,
  });
}

/** Restores a saved run for read-only inspection, exactly as stored. */
export function decisionRunFromTrace(trace: DecisionRunTrace): DecisionRun {
  const parsed = parseDecisionRunTrace(trace);
  return {
    kind: "decision",
    runId: parsed.runId,
    input: parsed.input,
    status: parsed.status,
    attempts: parsed.attempts,
    exchanges: parsed.exchanges,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
  };
}
