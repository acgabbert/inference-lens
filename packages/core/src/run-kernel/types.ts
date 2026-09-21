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
  | "tool-execution"
  | "template"
  | "template-revision"
  | "template-use"
  | "external-import"
  | "experiment"
  | "experiment-cell"
  | "evaluation-suite"
  | "evaluation-variant"
  | "evaluation-input"
  | "evaluation-case"
  | "evaluation-baseline"
  | "evaluation-assessment"
  | "check";

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
export type ToolExecutionId = EntityId<"tool-execution">;
export type PromptTemplateId = EntityId<"template">;
export type PromptTemplateRevisionId = EntityId<"template-revision">;
export type PromptTemplateUseId = EntityId<"template-use">;
export type ExternalImportId = EntityId<"external-import">;
export type ExperimentId = EntityId<"experiment">;
export type ExperimentCellId = EntityId<"experiment-cell">;
export type EvaluationSuiteId = EntityId<"evaluation-suite">;
export type EvaluationVariantId = EntityId<"evaluation-variant">;
export type EvaluationInputBindingId = EntityId<"evaluation-input">;
export type EvaluationCaseId = EntityId<"evaluation-case">;
export type EvaluationBaselineId = EntityId<"evaluation-baseline">;
export type EvaluationAssessmentId = EntityId<"evaluation-assessment">;
export type CheckId = EntityId<"check">;

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

/**
 * How a provider response is delivered for every turn in one immutable run.
 * This is execution policy, not a model sampling option or connection setting.
 */
export type ResponseMode = "streaming" | "buffered";

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

/**
 * What an executor may hand back. This union is deliberately wider than
 * `MessageContentPart`, which stays text-only: a tool that returns an image or
 * a resource must be able to say so, even while the provider-neutral message
 * vocabulary cannot carry it. Everything outside `text` is projected to visible
 * placeholder text before it reaches a provider or a trace, and the projection
 * is recorded rather than performed silently.
 */
export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolImageContent {
  type: "image";
  mimeType: string;
  /** Base64, held in memory only. Raw bytes never enter a RunTrace. */
  data: string;
}

export interface ToolAudioContent {
  type: "audio";
  mimeType: string;
  data: string;
}

export interface ToolResourceContent {
  type: "resource";
  uri: string;
  mimeType?: string;
  text?: string;
}

export type ToolExecutionContentPart =
  | ToolTextContent
  | ToolImageContent
  | ToolAudioContent
  | ToolResourceContent;

/** One non-text part and the placeholder text that stood in for it. */
export interface ToolContentProjectionNote {
  type: Exclude<ToolExecutionContentPart["type"], "text">;
  mimeType?: string;
  uri?: string;
  placeholder: string;
}

export interface ToolContentProjection {
  /** Empty when the executor returned text only. */
  projectedParts: ToolContentProjectionNote[];
}

/**
 * Why an execution produced no result. These are deliberately distinct from a
 * tool that ran and reported an error: that is a completed execution carrying
 * `isError`, because the provider is entitled to see it and reason about it.
 *
 * The mock executor can only ever produce `cancelled`. The rest exist from day
 * one so that a transport-bearing executor — a command tool, an MCP client —
 * classifies into this vocabulary rather than reshaping it.
 */
export type ToolExecutionFailureKind =
  | "execution_failed"
  | "invalid_result"
  | "timeout"
  | "cancelled"
  | "rejected";

export interface ToolExecutionFailure {
  kind: ToolExecutionFailureKind;
  message: string;
  /** Secret-free detail the executor chose to surface. */
  details?: JsonValue;
}

export type ToolExecutionOutcome =
  | {
      status: "completed";
      content: ToolExecutionContentPart[];
      isError: boolean;
    }
  | { status: "failed"; failure: ToolExecutionFailure };

export type ToolExecutorKind = "mock" | "command" | "mcp";

/**
 * The only part of a binding that may be persisted. A binding holds device-local
 * executor configuration — an executable path, an endpoint, a credential
 * reference — and none of it belongs in a project, a plan, a result, or a
 * trace. What does belong is the answer to "what served this call", which is
 * exactly this shape.
 */
export interface ToolExecutorIdentity {
  kind: ToolExecutorKind;
  /** Stable and secret-free; safe to show beside a result and to serialize. */
  executorId: string;
  /** Human-readable binding name, when the binding has one. */
  label?: string;
}

export type ToolExecutionStatus = "executing" | "completed" | "failed";

/**
 * Execution evidence for one tool call, reduced from the event stream the same
 * way turns and exchanges are. A call may hold more than one record: a failed
 * execution does not forbid another attempt.
 */
export interface ToolExecutionRecord {
  id: ToolExecutionId;
  turnId: TurnId;
  toolCallId: ToolCallId;
  executor: ToolExecutorIdentity;
  status: ToolExecutionStatus;
  startedAt: string;
  startedElapsedMs: number;
  endedAt?: string;
  durationMs?: number;
  /** The provider-visible text projection, present once completed. */
  content?: MessageContentPart[];
  projection?: ToolContentProjection;
  isError?: boolean;
  failure?: ToolExecutionFailure;
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

export interface ResolvedTemplateMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Self-contained, secret-free provenance for one pinned authored template use. */
export interface ResolvedTemplateUse {
  templateUseId: PromptTemplateUseId;
  templateId: PromptTemplateId;
  templateRevisionId: PromptTemplateRevisionId;
  templateName: string;
  messages: [ResolvedTemplateMessage, ...ResolvedTemplateMessage[]];
  variableDefaults: Record<string, string>;
  values: Record<string, string>;
  outputMessageIds: MessageId[];
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
  templateResolutions: ResolvedTemplateUse[];
  responseMode: ResponseMode;
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
  responseMode: ResponseMode;
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
        type: "tool.execution_started";
        turnId: TurnId;
        executionId: ToolExecutionId;
        toolCallId: ToolCallId;
        executor: ToolExecutorIdentity;
      }
    | {
        type: "tool.execution_completed";
        turnId: TurnId;
        executionId: ToolExecutionId;
        toolCallId: ToolCallId;
        content: MessageContentPart[];
        projection: ToolContentProjection;
        isError: boolean;
      }
    | {
        type: "tool.execution_failed";
        turnId: TurnId;
        executionId: ToolExecutionId;
        toolCallId: ToolCallId;
        failure: ToolExecutionFailure;
      }
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
  toolExecutions: ToolExecutionRecord[];
  toolResults: ToolResult[];
  lastSequence: number;
  startedAt?: string;
  endedAt?: string;
}

export interface RunTrace {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6;
  runId: RunId;
  input: ResolvedRunInput;
  status: TerminalRunStatus;
  events: RunEvent[];
  turns: ModelTurnState[];
  exchanges: Record<ExchangeId, ExchangeTrace>;
  toolExecutions: ToolExecutionRecord[];
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
