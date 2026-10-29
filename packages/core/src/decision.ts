import type {
  ConnectionProfileId,
  ExchangeId,
  ExchangeTrace,
  JsonObject,
  JsonValue,
  ProviderFrame,
  RedactedProviderRequest,
  RedactedProviderResponse,
  RunError,
  RunId,
  RunTokenUsage,
  TerminalRunStatus,
} from "./run-kernel/types.ts";
import type { ProviderCapabilities } from "./types.ts";

/**
 * Decision (System One) runs: one buffered exchange that answers typed
 * questions about a state, with no messages, tools, sampling options, or turn
 * loop. The types sit beside the chat run kernel rather than inside it, so a
 * conversation can never type-check against a decision endpoint. The shared
 * evidence pieces — exchange traces, errors, token usage, terminal status —
 * are the chat kernel's own.
 *
 * Field names follow the wire (`choice`, `score`, `noul`). Every implementation
 * uses them, and keeping them makes raw and normalized evidence read the same.
 */

/** A protocol that answers decision requests rather than conversations. */
export const DECISION_WIRE_PROTOCOLS = ["systemone"] as const;

export type DecisionWireProtocol = (typeof DECISION_WIRE_PROTOCOLS)[number];

/** What a question is about; free text or any JSON the caller chooses. */
export type DecisionState = string | JsonObject | JsonValue[];

export type DecisionQuestion =
  | {
      type: "choice";
      instructions: JsonValue;
      /** Option label → description. A description may be `null`. */
      criteria: Record<string, JsonValue | null>;
    }
  | {
      type: "score";
      instructions: JsonValue;
      /** Ordered low → high; level numbers are the 0-based positions. */
      criteria: JsonValue[];
    }
  | {
      type: "noul";
      instructions: JsonValue;
      criteria?: { true: JsonValue; false: JsonValue };
    };

export type DecisionQuestionType = DecisionQuestion["type"];

/**
 * The authored part of a decision request. Question ids are caller-chosen keys
 * that are never shown to the model; their order is authored order.
 */
export interface DecisionInput {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
}

export type DecisionAnswer =
  | {
      type: "choice";
      /** The most probable option. */
      choice: string;
      /** Keyed by option label. */
      probabilities: Record<string, number>;
      confidence?: number;
    }
  | {
      type: "score";
      /** The probability-weighted level position; it may fall between levels. */
      score: number;
      /** Keyed by level number as a string. */
      probabilities: Record<string, number>;
      /** Level number → that level's criterion. */
      legend?: Record<string, JsonValue>;
      confidence?: number;
    }
  | {
      type: "noul";
      /** P(true). The wire carries no confidence for noul. */
      noul: number;
    };

/** What one successful exchange established. */
export interface DecisionResult {
  /** The model the server resolved; it may differ from the alias sent. */
  model?: string;
  answers: Record<string, DecisionAnswer>;
  usage?: RunTokenUsage;
}

export interface ResolvedDecisionTarget {
  profileId: ConnectionProfileId;
  protocol: DecisionWireProtocol;
  endpoint: string;
  model: string;
  /** Capability snapshot selected before this request was serialized. */
  capabilities: ProviderCapabilities;
}

/** The exact provider-neutral context for one decision request. */
export interface DecisionProviderInput {
  target: ResolvedDecisionTarget;
  decision: DecisionInput;
}

/** One attempt at a decision exchange, as a host is asked to execute it. */
export interface DecisionExecution {
  runId: RunId;
  attempt: number;
  exchangeId: ExchangeId;
  input: DecisionProviderInput;
}

/**
 * What a host observed for one decision exchange, in order: the redacted
 * request, the response status, the whole body as a single frame (an error
 * body included), then the normalized result.
 */
export type DecisionEvent =
  | { type: "request"; request: RedactedProviderRequest }
  | { type: "response_started"; response: RedactedProviderResponse }
  | { type: "frame"; frame: ProviderFrame }
  | { type: "completed"; result: DecisionResult };

export type DecisionTransportEvent =
  | DecisionEvent
  | { type: "failed"; error: RunError }
  | { type: "cancelled"; reason?: string };

/** A serializable, secret-free snapshot of what a decision run sends. */
export interface ResolvedDecisionRunInput extends DecisionProviderInput {
  runId: RunId;
  resolvedAt: string;
}

/** One decision exchange. There are no turns, so it has no turn id. */
export type DecisionExchangeTrace = Omit<ExchangeTrace, "turnId">;

export interface DecisionAttempt {
  attempt: number;
  exchangeId: ExchangeId;
  /** A cancelled attempt was stopped in flight; it holds no result or error. */
  status: "running" | "completed" | "failed" | "cancelled";
  result?: DecisionResult;
  error?: RunError;
}

export type DecisionRunStatus =
  | { kind: "not_started" }
  | { kind: "running"; attempt: number; exchangeId: ExchangeId }
  /**
   * A retryable failure the user has neither retried nor stopped (D28). It is
   * live session state only: a trace stores a terminal status.
   */
  | {
      kind: "paused";
      reason: "attempt_failed";
      attempt: number;
      exchangeId: ExchangeId;
      error: RunError;
    }
  | TerminalRunStatus;

/**
 * A decision run: the same input sent once, plus any retries of that exact
 * input. Retries reuse the chat kernel's attempt semantics; there is never a
 * second exchange with different content.
 */
export interface DecisionRun {
  kind: "decision";
  runId: RunId;
  input: ResolvedDecisionRunInput;
  status: DecisionRunStatus;
  attempts: DecisionAttempt[];
  exchanges: Record<ExchangeId, DecisionExchangeTrace>;
  startedAt?: string;
  endedAt?: string;
}

/**
 * One decision protocol's serialization and normalization. Pure and
 * secret-free, like the chat adapters: the host that owns the credential and
 * the network sends the first and hands the body to the second.
 */
export interface DecisionProtocolAdapter {
  readonly protocol: DecisionWireProtocol;
  buildRequest(input: DecisionProviderInput): { url: string; body: JsonObject };
  /**
   * Normalizes a successful response body against the questions that were
   * asked. Throws ProviderProtocolError for anything the protocol does not
   * allow; unknown extra fields are left to the raw evidence.
   */
  normalizeResponse(input: DecisionProviderInput, raw: string): DecisionResult;
  /**
   * A readable message for an error body in a documented shape, or undefined
   * when the body is in none, so the host can show the raw text instead.
   */
  errorMessage(raw: string): string | undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecisionQuestion(value: unknown): value is DecisionQuestion {
  if (!isJsonObject(value) || value.instructions === undefined) return false;
  switch (value.type) {
    case "choice":
      return isJsonObject(value.criteria);
    case "score":
      return Array.isArray(value.criteria);
    case "noul":
      return (
        value.criteria === undefined ||
        (isJsonObject(value.criteria) &&
          value.criteria.true !== undefined &&
          value.criteria.false !== undefined)
      );
    default:
      return false;
  }
}

/**
 * Whether a value has the shape of a decision request: a state and at least
 * one question of a known type with criteria of that type's shape. Limits
 * (option counts, level counts, criterion types) are the server's to enforce;
 * its error is the evidence (D6).
 */
export function isDecisionInput(value: unknown): value is DecisionInput {
  if (!isJsonObject(value)) return false;
  const { state, questions } = value;
  if (typeof state !== "string" && !isJsonObject(state) && !Array.isArray(state)) {
    return false;
  }
  return (
    isJsonObject(questions) &&
    Object.keys(questions).length > 0 &&
    Object.values(questions).every(isDecisionQuestion)
  );
}
