import type {
  ExchangeTrace,
  ModelTurnAttemptState,
  RunEvent,
  RunId,
  RunState,
  RunTrace,
  TerminalRunStatus,
  TurnId,
  ToolArguments,
  ToolCall,
  ToolCallAccumulator,
  ToolResult,
  ExchangeId,
} from "./types.ts";

export class RunInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunInvariantError";
  }
}

export function createRunState(runId: RunId): RunState {
  return {
    runId,
    status: { kind: "not_started" },
    events: [],
    turns: [],
    exchanges: {},
    toolResults: [],
    lastSequence: -1,
  };
}

function isTerminal(status: RunState["status"]): status is TerminalRunStatus {
  return (
    status.kind === "completed" ||
    status.kind === "cancelled" ||
    status.kind === "failed"
  );
}

function assertEventEnvelope(state: RunState, event: RunEvent): void {
  if (event.runId !== state.runId) {
    throw new RunInvariantError(
      `Event belongs to run ${event.runId}, not ${state.runId}.`,
    );
  }
  if (event.sequence !== state.lastSequence + 1) {
    throw new RunInvariantError(
      `Expected event sequence ${state.lastSequence + 1}, received ${event.sequence}.`,
    );
  }
  if (event.sequence < 0) {
    throw new RunInvariantError("Event sequence cannot be negative.");
  }
  if (event.elapsedMs < 0) {
    throw new RunInvariantError("Event elapsed time cannot be negative.");
  }
  if (isTerminal(state.status)) {
    throw new RunInvariantError(
      `Cannot apply ${event.type} after run ${state.runId} is terminal.`,
    );
  }
  if (state.events.some((existing) => existing.eventId === event.eventId)) {
    throw new RunInvariantError(`Duplicate event id ${event.eventId}.`);
  }
}

function assertStarted(state: RunState): asserts state is RunState & {
  input: NonNullable<RunState["input"]>;
  startedAt: string;
} {
  if (!state.input || !state.startedAt) {
    throw new RunInvariantError("Run has not started.");
  }
}

function findAttempt(
  state: RunState,
  event: {
    turnId: TurnId;
    attempt: number;
    exchangeId: ExchangeId;
  },
): ModelTurnAttemptState {
  const turn = state.turns.find(({ turnId }) => turnId === event.turnId);
  const attempt = turn?.attempts.find(
    (candidate) => candidate.attempt === event.attempt,
  );
  if (!attempt || attempt.exchangeId !== event.exchangeId) {
    throw new RunInvariantError(
      `Unknown turn attempt ${event.turnId}/${event.attempt}/${event.exchangeId}.`,
    );
  }
  return attempt;
}

function updateAttempt(
  state: RunState,
  event: { turnId: TurnId; attempt: number; exchangeId: ExchangeId },
  update: (attempt: ModelTurnAttemptState) => ModelTurnAttemptState,
): RunState["turns"] {
  findAttempt(state, event);
  return state.turns.map((turn) =>
    turn.turnId !== event.turnId
      ? turn
      : {
          ...turn,
          attempts: turn.attempts.map((attempt) =>
            attempt.attempt === event.attempt ? update(attempt) : attempt,
          ),
        },
  );
}

function assertStreamingAttempt(
  state: RunState,
  event: { turnId: TurnId; attempt: number; exchangeId: ExchangeId },
): ModelTurnAttemptState {
  const attempt = findAttempt(state, event);
  if (attempt.status !== "streaming") {
    throw new RunInvariantError(
      `Turn ${event.turnId} attempt ${event.attempt} is already complete.`,
    );
  }
  return attempt;
}

function appendEvent(state: RunState, event: RunEvent): RunState {
  return {
    ...state,
    events: [...state.events, event],
    lastSequence: event.sequence,
  };
}

function updateExchange(
  state: RunState,
  exchangeId: keyof RunState["exchanges"],
  update: (exchange: ExchangeTrace) => ExchangeTrace,
): RunState["exchanges"] {
  const exchange = state.exchanges[exchangeId];
  if (!exchange) {
    throw new RunInvariantError(`Unknown exchange ${exchangeId}.`);
  }
  return {
    ...state.exchanges,
    [exchangeId]: update(exchange),
  };
}

function parseToolArguments(text: string): ToolArguments {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        text,
        parsed: parsed as ToolArguments["parsed"],
      };
    }
  } catch {
    // The exact provider text remains valuable even when it is not valid JSON.
  }
  return { text };
}

function completedToolCalls(
  calls: ToolCallAccumulator[],
): ToolCall[] {
  return calls
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((call) => ({
      id: call.id,
      providerCallId: call.providerCallId,
      name: call.name,
      arguments: parseToolArguments(call.argumentsText),
    }));
}

function pendingToolCallIds(
  calls: ToolCallAccumulator[],
  results: ToolResult[],
): ToolCallAccumulator["id"][] {
  const resolved = new Set(results.map(({ toolCallId }) => toolCallId));
  return calls
    .map(({ id }) => id)
    .filter((toolCallId) => !resolved.has(toolCallId));
}

export function reduceRunEvent(state: RunState, event: RunEvent): RunState {
  assertEventEnvelope(state, event);

  let next: RunState;

  switch (event.type) {
    case "run.started": {
      if (state.status.kind !== "not_started") {
        throw new RunInvariantError("Run can only be started once.");
      }
      if (event.input.runId !== state.runId) {
        throw new RunInvariantError(
          `Resolved input belongs to run ${event.input.runId}, not ${state.runId}.`,
        );
      }
      next = {
        ...state,
        input: event.input,
        status: { kind: "starting" },
        startedAt: event.occurredAt,
      };
      break;
    }

    case "turn.started": {
      assertStarted(state);
      if (
        state.status.kind !== "starting" &&
        state.status.kind !== "paused"
      ) {
        throw new RunInvariantError(
          `Cannot start a turn while run is ${state.status.kind}.`,
        );
      }
      if (event.attempt !== 1) {
        throw new RunInvariantError(
          "The initial reducer slice supports one attempt per turn.",
        );
      }
      if (state.turns.some(({ turnId }) => turnId === event.turnId)) {
        throw new RunInvariantError(`Duplicate turn id ${event.turnId}.`);
      }
      if (state.exchanges[event.exchangeId]) {
        throw new RunInvariantError(
          `Duplicate exchange id ${event.exchangeId}.`,
        );
      }
      next = {
        ...state,
        turns: [
          ...state.turns,
          {
            turnId: event.turnId,
            attempts: [
              {
                attempt: event.attempt,
                exchangeId: event.exchangeId,
                input: event.input,
                status: "streaming",
                text: "",
                reasoning: "",
                toolCalls: [],
              },
            ],
          },
        ],
        exchanges: {
          ...state.exchanges,
          [event.exchangeId]: {
            exchangeId: event.exchangeId,
            turnId: event.turnId,
            attempt: event.attempt,
            frames: [],
          },
        },
        status: {
          kind: "running",
          turnId: event.turnId,
          attempt: event.attempt,
          exchangeId: event.exchangeId,
        },
      };
      break;
    }

    case "turn.attempt_started": {
      assertStarted(state);
      if (
        state.status.kind !== "paused" ||
        state.status.reason !== "attempt_failed" ||
        state.status.turnId !== event.turnId ||
        state.status.attempt + 1 !== event.attempt
      ) {
        throw new RunInvariantError(
          "A retry can only start from the matching failed attempt.",
        );
      }
      const turn = state.turns.find(({ turnId }) => turnId === event.turnId);
      const previousAttempt = turn?.attempts.at(-1);
      if (!turn || !previousAttempt || previousAttempt.status !== "failed") {
        throw new RunInvariantError(
          `Turn ${event.turnId} has no failed attempt to retry.`,
        );
      }
      if (event.attempt !== previousAttempt.attempt + 1) {
        throw new RunInvariantError(
          `Expected attempt ${previousAttempt.attempt + 1}, received ${event.attempt}.`,
        );
      }
      if (state.exchanges[event.exchangeId]) {
        throw new RunInvariantError(
          `Duplicate exchange id ${event.exchangeId}.`,
        );
      }
      next = {
        ...state,
        turns: state.turns.map((candidate) =>
          candidate.turnId === event.turnId
            ? {
                ...candidate,
                attempts: [
                  ...candidate.attempts,
                  {
                    attempt: event.attempt,
                    exchangeId: event.exchangeId,
                    input: previousAttempt.input,
                    status: "streaming",
                    text: "",
                    reasoning: "",
                    toolCalls: [],
                  },
                ],
              }
            : candidate,
        ),
        exchanges: {
          ...state.exchanges,
          [event.exchangeId]: {
            exchangeId: event.exchangeId,
            turnId: event.turnId,
            attempt: event.attempt,
            frames: [],
          },
        },
        status: {
          kind: "running",
          turnId: event.turnId,
          attempt: event.attempt,
          exchangeId: event.exchangeId,
        },
      };
      break;
    }

    case "turn.attempt_failed": {
      assertStarted(state);
      if (!event.error.retryable) {
        throw new RunInvariantError(
          "Only retryable failures may pause a run attempt.",
        );
      }
      const attempt = findAttempt(state, event);
      const turn = state.turns.find(({ turnId }) => turnId === event.turnId);
      const isLatestAttempt = turn?.attempts.at(-1) === attempt;
      const isActiveAttempt =
        (state.status.kind === "running" &&
          state.status.turnId === event.turnId &&
          state.status.attempt === event.attempt &&
          state.status.exchangeId === event.exchangeId) ||
        (state.status.kind === "awaiting_tool_results" &&
          state.status.turnId === event.turnId);
      if (!isLatestAttempt || !isActiveAttempt) {
        throw new RunInvariantError(
          "Only the active turn attempt may fail.",
        );
      }
      if (attempt.status === "failed") {
        throw new RunInvariantError(
          `Turn ${event.turnId} attempt ${event.attempt} already failed.`,
        );
      }
      next = {
        ...state,
        turns: updateAttempt(state, event, (current) => ({
          ...current,
          status: "failed",
          error: event.error,
        })),
        status: {
          kind: "paused",
          reason: "attempt_failed",
          turnId: event.turnId,
          attempt: event.attempt,
          exchangeId: event.exchangeId,
          error: event.error,
        },
      };
      break;
    }

    case "exchange.requested": {
      assertStreamingAttempt(state, event);
      const exchange = state.exchanges[event.exchangeId];
      if (exchange?.request) {
        throw new RunInvariantError(
          `Exchange ${event.exchangeId} already has a request.`,
        );
      }
      next = {
        ...state,
        exchanges: updateExchange(state, event.exchangeId, (current) => ({
          ...current,
          request: event.request,
        })),
      };
      break;
    }

    case "exchange.response_started": {
      assertStreamingAttempt(state, event);
      const exchange = state.exchanges[event.exchangeId];
      if (!exchange?.request) {
        throw new RunInvariantError(
          `Exchange ${event.exchangeId} has no recorded request.`,
        );
      }
      if (exchange.response) {
        throw new RunInvariantError(
          `Exchange ${event.exchangeId} already has a response.`,
        );
      }
      next = {
        ...state,
        exchanges: updateExchange(state, event.exchangeId, (current) => ({
          ...current,
          response: event.response,
        })),
      };
      break;
    }

    case "exchange.frame_received": {
      // A provider may send trace/accounting frames after its finish reason.
      // Assistant completion closes content mutation, not the underlying
      // exchange; raw evidence remains valid until the run is terminal.
      findAttempt(state, event);
      const exchange = state.exchanges[event.exchangeId];
      if (!exchange?.response) {
        throw new RunInvariantError(
          `Exchange ${event.exchangeId} has not started a response.`,
        );
      }
      if (event.frame.index !== exchange.frames.length) {
        throw new RunInvariantError(
          `Expected frame ${exchange.frames.length}, received ${event.frame.index}.`,
        );
      }
      next = {
        ...state,
        exchanges: updateExchange(state, event.exchangeId, (current) => ({
          ...current,
          frames: [...current.frames, event.frame],
        })),
      };
      break;
    }

    case "assistant.text_delta": {
      assertStreamingAttempt(state, event);
      next = {
        ...state,
        turns: updateAttempt(state, event, (attempt) => ({
          ...attempt,
          text: attempt.text + event.text,
        })),
      };
      break;
    }

    case "assistant.reasoning_delta": {
      assertStreamingAttempt(state, event);
      next = {
        ...state,
        turns: updateAttempt(state, event, (attempt) => ({
          ...attempt,
          reasoning: attempt.reasoning + event.reasoning,
        })),
      };
      break;
    }

    case "assistant.tool_call_delta": {
      assertStreamingAttempt(state, event);
      next = {
        ...state,
        turns: updateAttempt(state, event, (attempt) => {
          const existing = attempt.toolCalls.find(
            ({ id }) => id === event.toolCallId,
          );
          if (existing && existing.index !== event.index) {
            throw new RunInvariantError(
              `Tool call ${event.toolCallId} changed index.`,
            );
          }
          const updated: ToolCallAccumulator = {
            id: event.toolCallId,
            index: event.index,
            providerCallId:
              event.providerCallId ?? existing?.providerCallId,
            name: (existing?.name ?? "") + (event.nameDelta ?? ""),
            argumentsText:
              (existing?.argumentsText ?? "") + (event.argumentsDelta ?? ""),
          };
          return {
            ...attempt,
            toolCalls: existing
              ? attempt.toolCalls.map((call) =>
                  call.id === event.toolCallId ? updated : call,
                )
              : [...attempt.toolCalls, updated],
          };
        }),
      };
      break;
    }

    case "usage.reported": {
      // Providers may send final usage in a trailing frame after the assistant
      // has supplied its finish reason. Usage is accounting metadata, not a
      // content delta, so it remains valid until the run itself is terminal.
      findAttempt(state, event);
      next = {
        ...state,
        turns: updateAttempt(state, event, (attempt) => ({
          ...attempt,
          usage: { ...attempt.usage, ...event.usage },
        })),
      };
      break;
    }

    case "assistant.completed": {
      const attempt = assertStreamingAttempt(state, event);
      const toolCalls = completedToolCalls(attempt.toolCalls);
      for (const call of toolCalls) {
        if (!call.name) {
          throw new RunInvariantError(
            `Tool call ${call.id} completed without a name.`,
          );
        }
      }
      next = {
        ...state,
        turns: updateAttempt(state, event, (current) => ({
          ...current,
          status: "completed",
          completedToolCalls: toolCalls,
          finishReason: event.finishReason,
        })),
        status:
          toolCalls.length > 0
            ? {
                kind: "awaiting_tool_results",
                turnId: event.turnId,
                pendingToolCallIds: toolCalls.map(({ id }) => id),
              }
            : state.status,
      };
      break;
    }

    case "tool.result_supplied": {
      if (
        state.status.kind !== "awaiting_tool_results" ||
        state.status.turnId !== event.turnId
      ) {
        throw new RunInvariantError(
          "Tool results can only be supplied for the waiting turn.",
        );
      }
      if (
        !state.status.pendingToolCallIds.includes(event.result.toolCallId)
      ) {
        throw new RunInvariantError(
          `Tool call ${event.result.toolCallId} is not awaiting a result.`,
        );
      }
      if (
        state.toolResults.some(
          ({ toolCallId }) => toolCallId === event.result.toolCallId,
        )
      ) {
        throw new RunInvariantError(
          `Tool call ${event.result.toolCallId} already has a result.`,
        );
      }
      const toolResults = [...state.toolResults, event.result];
      const turn = state.turns.find(({ turnId }) => turnId === event.turnId);
      const attempt = turn?.attempts.at(-1);
      if (!attempt) {
        throw new RunInvariantError(`Unknown turn ${event.turnId}.`);
      }
      const pending = pendingToolCallIds(attempt.toolCalls, toolResults);
      next = {
        ...state,
        toolResults,
        status:
          pending.length === 0
            ? { kind: "paused", reason: "tool_results_ready" }
            : {
                kind: "awaiting_tool_results",
                turnId: event.turnId,
                pendingToolCallIds: pending,
              },
      };
      break;
    }

    case "run.completed": {
      assertStarted(state);
      if (state.status.kind !== "running") {
        throw new RunInvariantError(
          `Cannot complete a run while it is ${state.status.kind}.`,
        );
      }
      const attempt = findAttempt(state, state.status);
      if (attempt.status !== "completed") {
        throw new RunInvariantError(
          "Cannot complete a run before its active assistant turn completes.",
        );
      }
      if (attempt.toolCalls.length > 0) {
        throw new RunInvariantError(
          "Cannot complete a run with unresolved tool calls.",
        );
      }
      next = {
        ...state,
        status: {
          kind: "completed",
          completedAt: event.occurredAt,
        },
        endedAt: event.occurredAt,
      };
      break;
    }

    case "run.cancelled": {
      assertStarted(state);
      next = {
        ...state,
        status: {
          kind: "cancelled",
          cancelledAt: event.occurredAt,
          reason: event.reason,
        },
        endedAt: event.occurredAt,
      };
      break;
    }

    case "run.failed": {
      assertStarted(state);
      next = {
        ...state,
        status: {
          kind: "failed",
          failedAt: event.occurredAt,
          error: event.error,
        },
        endedAt: event.occurredAt,
      };
      break;
    }
  }

  return appendEvent(next, event);
}

export function reduceRunEvents(
  runId: RunId,
  events: Iterable<RunEvent>,
): RunState {
  let state = createRunState(runId);
  for (const event of events) state = reduceRunEvent(state, event);
  return state;
}

export function createRunTrace(
  state: RunState,
  options: Pick<RunTrace, "branchedFrom"> = {},
): RunTrace {
  assertStarted(state);
  if (!isTerminal(state.status) || !state.endedAt) {
    throw new RunInvariantError(
      `Run ${state.runId} must be terminal before creating a trace.`,
    );
  }
  return {
    schemaVersion: 2,
    runId: state.runId,
    input: state.input,
    status: state.status,
    events: state.events,
    turns: state.turns,
    exchanges: state.exchanges,
    toolResults: state.toolResults,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    ...options,
  };
}
