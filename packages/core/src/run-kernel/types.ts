import type { ProviderCapabilities, TokenUsage } from "../types";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type EntityIdKind =
  | "project"
  | "connection"
  | "conversation"
  | "revision"
  | "message"
  | "profile"
  | "run"
  | "turn"
  | "exchange"
  | "event"
  | "tool"
  | "tool-mock"
  | "tool-call"
  | "tool-result"
  | "template"
  | "template-revision";

export type EntityId<Kind extends EntityIdKind> = `${Kind}_${string}`;

export type ConversationId = EntityId<"conversation">;
export type ConversationRevisionId = EntityId<"revision">;
export type ProjectId = EntityId<"project">;
export type ConnectionRequirementId = EntityId<"connection">;
export type MessageId = EntityId<"message">;
export type ConnectionProfileId = EntityId<"profile">;
export type RunId = EntityId<"run">;
export type TurnId = EntityId<"turn">;
export type ExchangeId = EntityId<"exchange">;
export type EventId = EntityId<"event">;
export type ToolId = EntityId<"tool">;
export type ToolMockId = EntityId<"tool-mock">;
export type ToolCallId = EntityId<"tool-call">;
export type ToolResultId = EntityId<"tool-result">;
export type PromptTemplateId = EntityId<"template">;
export type PromptTemplateRevisionId = EntityId<"template-revision">;

export function createEntityId<Kind extends EntityIdKind>(
  kind: Kind,
  suffix: string,
): EntityId<Kind> {
  if (!suffix.trim()) throw new Error("Identifier suffix cannot be empty.");
  return `${kind}_${suffix}` as EntityId<Kind>;
}

export interface TextContentPart {
  type: "text";
  text: string;
}

export type MessageContentPart = TextContentPart;

interface MessageBase {
  id: MessageId;
  content: MessageContentPart[];
}

export interface SystemMessage extends MessageBase {
  role: "system";
}

export interface UserMessage extends MessageBase {
  role: "user";
}

export interface AssistantMessage extends MessageBase {
  role: "assistant";
  toolCalls?: ToolCall[];
}

export interface ToolMessage extends MessageBase {
  role: "tool";
  toolCallId: ToolCallId;
  name?: string;
}

export type ConversationMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface ConversationRevision {
  id: ConversationRevisionId;
  conversationId: ConversationId;
  parentRevisionId?: ConversationRevisionId;
  messages: ConversationMessage[];
  createdAt: string;
}

export type ProviderProtocol =
  | "openai-compatible-chat-completions"
  | "mock";

export interface InferenceOptions {
  temperature?: number;
  maxOutputTokens?: number;
  seed?: number;
  stop?: string[];
  providerOptions?: JsonObject;
}

export interface ToolDefinition {
  id: ToolId;
  name: string;
  description?: string;
  inputSchema: JsonObject;
  providerOptions?: JsonObject;
}

export interface ToolArguments {
  /**
   * The exact arguments text emitted by the provider.
   * `parsed` is present only when the complete value is a JSON object.
   */
  text: string;
  parsed?: JsonObject;
}

export interface ToolCall {
  id: ToolCallId;
  providerCallId?: string;
  name: string;
  arguments: ToolArguments;
}

export type ToolResolution =
  | { kind: "manual" }
  | { kind: "mock"; ruleId: string }
  | { kind: "replay"; recordingId: string }
  | { kind: "live"; executorId: string };

export interface ToolResult {
  id: ToolResultId;
  toolCallId: ToolCallId;
  content: MessageContentPart[];
  resolution: ToolResolution;
  isError?: boolean;
}

export interface RunPlan {
  conversationRevisionId: ConversationRevisionId;
  target: {
    profileId: ConnectionProfileId;
    model: string;
  };
  options: InferenceOptions;
  tools: ToolDefinition[];
}

export interface ResolvedProviderTarget {
  profileId: ConnectionProfileId;
  protocol: ProviderProtocol;
  endpoint: string;
  model: string;
  /** Capability snapshot selected before this request was serialized. */
  capabilities: ProviderCapabilities;
}

/**
 * A serializable, secret-free snapshot of the inputs selected when a run
 * starts. Credentials are supplied through ProviderRuntime instead.
 */
export interface ResolvedRunInput {
  runId: RunId;
  conversationId: ConversationId;
  conversationRevisionId: ConversationRevisionId;
  target: ResolvedProviderTarget;
  messages: ConversationMessage[];
  options: InferenceOptions;
  tools: ToolDefinition[];
  resolvedAt: string;
}

/** The authored conversation and revision a run executes. */
export interface RunConversationIdentity {
  conversationId: ConversationId;
  conversationRevisionId: ConversationRevisionId;
}

/**
 * The exact provider-neutral context for one model request. Subsequent turns
 * contain assistant tool calls and tool results that were not in the initial
 * ResolvedRunInput.
 */
export interface ProviderTurnInput {
  target: ResolvedProviderTarget;
  messages: ConversationMessage[];
  options: InferenceOptions;
  tools: ToolDefinition[];
}

export interface RunTokenUsage extends TokenUsage {
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export type NormalizedFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "other";

export interface FinishReason {
  normalized: NormalizedFinishReason;
  raw?: string;
}

export interface RunError {
  code:
    | "invalid_input"
    | "provider_error"
    | "transport_error"
    | "protocol_error"
    | "tool_error"
    | "internal_error";
  message: string;
  retryable?: boolean;
  providerStatus?: number;
  details?: JsonValue;
}

/** Whether repeating the same immutable provider-turn input may succeed. */
export function isRetryableRunError(
  error: Pick<RunError, "code" | "providerStatus">,
): boolean {
  if (error.code === "transport_error") return true;
  if (error.code !== "provider_error") return false;
  const status = error.providerStatus;
  return (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  );
}

export interface RedactedProviderRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /**
   * The exact text supplied to the HTTP client after provider serialization.
   * Keeping text rather than a parsed projection makes the persisted exchange
   * suitable for byte-level inspection and later replay.
   */
  body?: string;
}

export interface RedactedProviderResponse {
  status: number;
  headers: Record<string, string>;
}

export interface ProviderFrame {
  index: number;
  /** One complete provider SSE data line, without its terminating CR/LF. */
  raw: string;
}

export interface EventSource {
  exchangeId: ExchangeId;
  frameIndex?: number;
}

export interface RunEventMetadata {
  eventId: EventId;
  runId: RunId;
  sequence: number;
  occurredAt: string;
  elapsedMs: number;
}

interface AttemptEvent {
  turnId: TurnId;
  attempt: number;
  exchangeId: ExchangeId;
}

export type RunEvent = RunEventMetadata &
  (
    | { type: "run.started"; input: ResolvedRunInput }
    | ({ type: "turn.started"; input: ProviderTurnInput } & AttemptEvent)
    | ({ type: "turn.attempt_started" } & AttemptEvent)
    | ({
        type: "turn.attempt_failed";
        error: RunError;
      } & AttemptEvent)
    | ({
        type: "exchange.requested";
        request: RedactedProviderRequest;
      } & AttemptEvent)
    | ({
        type: "exchange.response_started";
        response: RedactedProviderResponse;
      } & AttemptEvent)
    | ({
        type: "exchange.frame_received";
        frame: ProviderFrame;
      } & AttemptEvent)
    | ({
        type: "assistant.text_delta";
        text: string;
        source?: EventSource;
      } & AttemptEvent)
    | ({
        /**
         * Provider-supplied reasoning text. This is separate from the final
         * assistant response so consumers can choose whether to display it.
         */
        type: "assistant.reasoning_delta";
        reasoning: string;
        source?: EventSource;
      } & AttemptEvent)
    | ({
        type: "assistant.tool_call_delta";
        toolCallId: ToolCallId;
        index: number;
        providerCallId?: string;
        nameDelta?: string;
        argumentsDelta?: string;
        source?: EventSource;
      } & AttemptEvent)
    | ({
        type: "usage.reported";
        usage: RunTokenUsage;
        source?: EventSource;
      } & AttemptEvent)
    | ({
        type: "assistant.completed";
        finishReason: FinishReason;
        source?: EventSource;
      } & AttemptEvent)
    | {
        type: "tool.result_supplied";
        turnId: TurnId;
        result: ToolResult;
      }
    | {
        type: "run.completed";
      }
    | {
        type: "run.cancelled";
        reason?: string;
      }
    | {
        type: "run.failed";
        error: RunError;
      }
  );

export interface ToolCallAccumulator {
  id: ToolCallId;
  index: number;
  providerCallId?: string;
  name: string;
  argumentsText: string;
}

export type AttemptStatus = "streaming" | "completed" | "failed";

export interface ModelTurnAttemptState {
  attempt: number;
  exchangeId: ExchangeId;
  input: ProviderTurnInput;
  status: AttemptStatus;
  text: string;
  reasoning: string;
  toolCalls: ToolCallAccumulator[];
  completedToolCalls?: ToolCall[];
  usage?: RunTokenUsage;
  finishReason?: FinishReason;
  error?: RunError;
}

export interface ModelTurnState {
  turnId: TurnId;
  attempts: ModelTurnAttemptState[];
}

export interface ExchangeTrace {
  exchangeId: ExchangeId;
  turnId: TurnId;
  attempt: number;
  request?: RedactedProviderRequest;
  response?: RedactedProviderResponse;
  frames: ProviderFrame[];
}

export type TerminalRunStatus =
  | { kind: "completed"; completedAt: string }
  | { kind: "cancelled"; cancelledAt: string; reason?: string }
  | { kind: "failed"; failedAt: string; error: RunError };

export type RunStatus =
  | { kind: "not_started" }
  | { kind: "starting" }
  | {
      kind: "running";
      turnId: TurnId;
      attempt: number;
      exchangeId: ExchangeId;
    }
  | {
      kind: "awaiting_tool_results";
      turnId: TurnId;
      pendingToolCallIds: ToolCallId[];
    }
  | { kind: "paused"; reason: "tool_results_ready" }
  | {
      kind: "paused";
      reason: "attempt_failed";
      turnId: TurnId;
      attempt: number;
      exchangeId: ExchangeId;
      error: RunError;
    }
  | TerminalRunStatus;

export interface RunState {
  runId: RunId;
  input?: ResolvedRunInput;
  status: RunStatus;
  events: RunEvent[];
  turns: ModelTurnState[];
  exchanges: Record<ExchangeId, ExchangeTrace>;
  toolResults: ToolResult[];
  lastSequence: number;
  startedAt?: string;
  endedAt?: string;
}

export interface RunTrace {
  schemaVersion: 1 | 2;
  runId: RunId;
  input: ResolvedRunInput;
  status: TerminalRunStatus;
  events: RunEvent[];
  turns: ModelTurnState[];
  exchanges: Record<ExchangeId, ExchangeTrace>;
  toolResults: ToolResult[];
  startedAt: string;
  endedAt: string;
  /** Trace-only provenance; it neither changes execution nor the event stream. */
  branchedFrom?: {
    runId: RunId;
    parentConversationRevisionId?: ConversationRevisionId;
    messageId: MessageId;
  };
}

/**
 * Opaque reference to application-managed credential material. It is a
 * runtime capability, never part of ResolvedRunInput or RunTrace.
 */
export interface CredentialHandle {
  readonly id: string;
  readonly approvedOrigin: string;
}

export interface ProviderRuntime {
  signal: AbortSignal;
  credential?: CredentialHandle;
}

export interface ProviderExecution {
  runId: RunId;
  turnId: TurnId;
  attempt: number;
  exchangeId: ExchangeId;
  input: ProviderTurnInput;
}

export type ProviderEvent =
  | {
      type: "request";
      request: RedactedProviderRequest;
    }
  | {
      type: "response_started";
      response: RedactedProviderResponse;
    }
  | {
      type: "frame";
      frame: ProviderFrame;
    }
  | {
      type: "text_delta";
      text: string;
      source?: EventSource;
    }
  | {
      type: "reasoning_delta";
      reasoning: string;
      source?: EventSource;
    }
  | {
      type: "tool_call_delta";
      toolCallId: ToolCallId;
      index: number;
      providerCallId?: string;
      nameDelta?: string;
      argumentsDelta?: string;
      source?: EventSource;
    }
  | {
      type: "usage";
      usage: RunTokenUsage;
      source?: EventSource;
    }
  | {
      type: "completed";
      finishReason: FinishReason;
      source?: EventSource;
    };

/**
 * The complete event vocabulary crossing a provider-turn transport boundary.
 * Provider adapters emit ProviderEvent values; HTTP and native hosts append a
 * terminal failure/cancellation value when execution cannot finish normally.
 */
export type ProviderTransportEvent =
  | ProviderEvent
  | { type: "failed"; error: RunError }
  | { type: "cancelled"; reason?: string };

export interface ProviderAdapter {
  readonly protocol: ProviderProtocol;

  execute(
    execution: ProviderExecution,
    runtime: ProviderRuntime,
  ): AsyncIterable<ProviderEvent>;
}
