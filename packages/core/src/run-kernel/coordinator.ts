import { createRunEventFactory } from "./events.ts";
import { createRunState, reduceRunEvent } from "./reducer.ts";
import type {
  ConversationMessage,
  MessageContentPart,
  ProviderExecution,
  ProviderTransportEvent,
  ProviderTurnInput,
  ResolvedRunInput,
  RunError,
  RunEvent,
  RunState,
  ToolCall,
  ToolCallId,
  ToolContentProjection,
  ToolExecutionFailure,
  ToolExecutionId,
  ToolExecutorIdentity,
  ToolResult,
} from "./types.ts";
import { createEntityId } from "./types.ts";

export interface TurnCommand {
  events: RunEvent[];
  execution: ProviderExecution;
}

function terminal(state: RunState): boolean {
  return (
    state.status.kind === "completed" ||
    state.status.kind === "cancelled" ||
    state.status.kind === "failed"
  );
}

function textContent(text: string) {
  return text ? [{ type: "text" as const, text }] : [];
}

function nextTurnInput(state: RunState): ProviderTurnInput {
  const previousTurn = state.turns.at(-1);
  const previousAttempt = previousTurn?.attempts.at(-1);
  if (!previousTurn || !previousAttempt?.completedToolCalls) {
    throw new Error("The previous model turn has no completed tool calls.");
  }

  const callsById = new Map<ToolCall["id"], ToolCall>(
    previousAttempt.completedToolCalls.map((call) => [call.id, call]),
  );
  const results = state.toolResults.filter((result) =>
    callsById.has(result.toolCallId),
  );
  const assistant: ConversationMessage = {
    id: createEntityId("message", `${previousTurn.turnId}-assistant`),
    role: "assistant",
    content: textContent(previousAttempt.text),
    toolCalls: previousAttempt.completedToolCalls,
  };
  const toolMessages: ConversationMessage[] = results.map((result) => ({
    id: createEntityId("message", result.id),
    role: "tool",
    toolCallId: result.toolCallId,
    name: callsById.get(result.toolCallId)?.name,
    content: result.content,
  }));

  return {
    target: previousAttempt.input.target,
    messages: [...previousAttempt.input.messages, assistant, ...toolMessages],
    responseMode: previousAttempt.input.responseMode,
    options: previousAttempt.input.options,
    tools: previousAttempt.input.tools,
  };
}

/**
 * Client-owned, provider-neutral orchestration for a complete run. The class
 * contains no React, HTTP, Tauri, or credential behavior: callers execute the
 * returned ProviderExecution and feed its ProviderTransportEvents back in.
 */
export class RunCoordinator {
  readonly input: ResolvedRunInput;
  private stateValue: RunState;
  private readonly eventFactory;
  private activeExecution?: ProviderExecution;

  constructor(input: ResolvedRunInput, state?: RunState) {
    this.input = input;
    this.stateValue = state ?? createRunState(input.runId);
    this.eventFactory = createRunEventFactory(input.runId, {
      initialSequence: this.stateValue.lastSequence + 1,
      startedAt: this.stateValue.startedAt
        ? Date.parse(this.stateValue.startedAt)
        : undefined,
    });
  }

  get state(): RunState {
    return this.stateValue;
  }

  private apply(event: RunEvent): RunEvent {
    this.stateValue = reduceRunEvent(this.stateValue, event);
    return event;
  }

  private beginTurn(input: ProviderTurnInput): TurnCommand {
    const number = this.stateValue.turns.length + 1;
    const suffix = this.input.runId.slice("run_".length);
    const execution: ProviderExecution = {
      runId: this.input.runId,
      turnId: createEntityId("turn", `${suffix}-${number}`),
      attempt: 1,
      exchangeId: createEntityId("exchange", `${suffix}-${number}`),
      input,
    };
    this.activeExecution = execution;
    const event = this.apply(
      this.eventFactory.create({
        type: "turn.started",
        turnId: execution.turnId,
        attempt: execution.attempt,
        exchangeId: execution.exchangeId,
        input,
      }),
    );
    return { events: [event], execution };
  }

  retry(): TurnCommand {
    const status = this.stateValue.status;
    if (status.kind !== "paused" || status.reason !== "attempt_failed") {
      throw new Error("This run has no failed attempt to retry.");
    }
    const turn = this.stateValue.turns.find(
      ({ turnId }) => turnId === status.turnId,
    );
    const previousAttempt = turn?.attempts.at(-1);
    if (!previousAttempt || previousAttempt.status !== "failed") {
      throw new Error("The failed attempt is unavailable.");
    }
    const suffix = this.input.runId.slice("run_".length);
    const attempt = previousAttempt.attempt + 1;
    const execution: ProviderExecution = {
      runId: this.input.runId,
      turnId: status.turnId,
      attempt,
      exchangeId: createEntityId(
        "exchange",
        `${suffix}-${this.stateValue.turns.length}-${attempt}`,
      ),
      input: previousAttempt.input,
    };
    this.activeExecution = execution;
    const event = this.apply(
      this.eventFactory.create({
        type: "turn.attempt_started",
        turnId: execution.turnId,
        attempt: execution.attempt,
        exchangeId: execution.exchangeId,
      }),
    );
    return { events: [event], execution };
  }

  start(): TurnCommand {
    if (this.stateValue.status.kind !== "not_started") {
      throw new Error("This run has already started.");
    }
    const started = this.apply(
      this.eventFactory.create({ type: "run.started", input: this.input }),
    );
    const turn = this.beginTurn({
      target: this.input.target,
      messages: this.input.messages,
      responseMode: this.input.responseMode,
      options: this.input.options,
      tools: this.input.tools,
    });
    return { events: [started, ...turn.events], execution: turn.execution };
  }

  accept(event: ProviderTransportEvent): RunEvent {
    if (!this.activeExecution) {
      throw new Error("No provider turn is active.");
    }
    if (event.type === "failed") {
      const execution = this.activeExecution;
      this.activeExecution = undefined;
      if (event.error.retryable) {
        return this.apply(
          this.eventFactory.create({
            type: "turn.attempt_failed",
            turnId: execution.turnId,
            attempt: execution.attempt,
            exchangeId: execution.exchangeId,
            error: event.error,
          }),
        );
      }
      return this.apply(
        this.eventFactory.create({ type: "run.failed", error: event.error }),
      );
    }
    if (event.type === "cancelled") {
      this.activeExecution = undefined;
      return this.apply(
        this.eventFactory.create({
          type: "run.cancelled",
          reason: event.reason,
        }),
      );
    }
    return this.apply(
      this.eventFactory.fromProvider(event, {
        turnId: this.activeExecution.turnId,
        attempt: this.activeExecution.attempt,
        exchangeId: this.activeExecution.exchangeId,
      }),
    );
  }

  finishTurnStream(): RunEvent[] {
    this.activeExecution = undefined;
    if (terminal(this.stateValue)) return [];
    if (
      this.stateValue.status.kind === "paused" &&
      this.stateValue.status.reason === "attempt_failed"
    ) {
      return [];
    }
    if (this.stateValue.status.kind === "awaiting_tool_results") return [];
    if (this.stateValue.status.kind === "running") {
      const status = this.stateValue.status;
      const turn = this.stateValue.turns.find(
        ({ turnId }) => turnId === status.turnId,
      );
      const attempt = turn?.attempts.find(
        ({ attempt }) => attempt === status.attempt,
      );
      if (attempt?.status === "completed") {
        return [
          this.apply(this.eventFactory.create({ type: "run.completed" })),
        ];
      }
    }
    return [
      this.fail({
        code: "protocol_error",
        message: "Provider turn ended before assistant completion.",
      }),
    ];
  }

  /**
   * Opens execution evidence for one waiting call. The coordinator does not run
   * the executor: callers await the executor and report its outcome back, the
   * same division of labor as a provider turn. The execution ID is derived so
   * that identical runs produce identical traces.
   */
  startToolExecution(input: {
    toolCallId: ToolCallId;
    executor: ToolExecutorIdentity;
  }): { event: RunEvent; executionId: ToolExecutionId } {
    const status = this.stateValue.status;
    if (status.kind !== "awaiting_tool_results") {
      throw new Error("This run is not awaiting tool results.");
    }
    const suffix = input.toolCallId.slice("tool-call_".length);
    const previous = this.stateValue.toolExecutions.filter(
      ({ toolCallId }) => toolCallId === input.toolCallId,
    ).length;
    const executionId = createEntityId(
      "tool-execution",
      `${suffix}-${previous + 1}`,
    );
    const event = this.apply(
      this.eventFactory.create({
        type: "tool.execution_started",
        turnId: status.turnId,
        executionId,
        toolCallId: input.toolCallId,
        executor: input.executor,
      }),
    );
    return { event, executionId };
  }

  completeToolExecution(input: {
    executionId: ToolExecutionId;
    toolCallId: ToolCallId;
    content: MessageContentPart[];
    projection: ToolContentProjection;
    isError: boolean;
  }): RunEvent {
    return this.apply(
      this.eventFactory.create({
        type: "tool.execution_completed",
        turnId: this.awaitingTurnId(),
        ...input,
      }),
    );
  }

  failToolExecution(input: {
    executionId: ToolExecutionId;
    toolCallId: ToolCallId;
    failure: ToolExecutionFailure;
  }): RunEvent {
    return this.apply(
      this.eventFactory.create({
        type: "tool.execution_failed",
        turnId: this.awaitingTurnId(),
        ...input,
      }),
    );
  }

  private awaitingTurnId() {
    const status = this.stateValue.status;
    if (status.kind !== "awaiting_tool_results") {
      throw new Error("This run is not awaiting tool results.");
    }
    return status.turnId;
  }

  supplyToolResults(results: ToolResult[]): RunEvent[] {
    return results.map((result) => {
      if (this.stateValue.status.kind !== "awaiting_tool_results") {
        throw new Error("This run is not awaiting tool results.");
      }
      return this.apply(
        this.eventFactory.create({
          type: "tool.result_supplied",
          turnId: this.stateValue.status.turnId,
          result,
        }),
      );
    });
  }

  continue(): TurnCommand {
    if (
      this.stateValue.status.kind !== "paused" ||
      this.stateValue.status.reason !== "tool_results_ready"
    ) {
      throw new Error("All pending tool results must be supplied first.");
    }
    return this.beginTurn(nextTurnInput(this.stateValue));
  }

  fail(error: RunError): RunEvent {
    if (terminal(this.stateValue)) {
      throw new Error("This run is already terminal.");
    }
    this.activeExecution = undefined;
    return this.apply(
      this.eventFactory.create({ type: "run.failed", error }),
    );
  }

  cancel(reason?: string): RunEvent {
    if (terminal(this.stateValue)) {
      throw new Error("This run is already terminal.");
    }
    this.activeExecution = undefined;
    return this.apply(
      this.eventFactory.create({ type: "run.cancelled", reason }),
    );
  }
}
