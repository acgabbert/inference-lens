import type {
  ConnectionProfileId,
  ExchangeId,
  ExchangeTrace,
  JsonObject,
  JsonValue,
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
  status: "running" | "completed" | "failed";
  result?: DecisionResult;
  error?: RunError;
}

export type DecisionRunStatus =
  | { kind: "not_started" }
  | { kind: "running"; attempt: number; exchangeId: ExchangeId }
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
