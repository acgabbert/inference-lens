import type {
  EventId,
  ProviderEvent,
  RunEvent,
  RunEventMetadata,
  RunId,
  TurnId,
  ExchangeId,
} from "./types.ts";
import { randomUUID } from "../random-id.ts";

export type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, keyof RunEventMetadata>
    : never
  : never;

export interface RunAttemptContext {
  turnId: TurnId;
  attempt: number;
  exchangeId: ExchangeId;
}

export interface RunEventFactoryOptions {
  now?: () => number;
  createEventId?: (sequence: number) => EventId;
  initialSequence?: number;
  startedAt?: number;
}

export interface RunEventFactory {
  create(payload: RunEventPayload): RunEvent;
  fromProvider(
    event: ProviderEvent,
    context: RunAttemptContext,
  ): RunEvent;
}

function defaultEventId(sequence: number): EventId {
  return `event_${randomUUID()}-${sequence}`;
}

function providerEventPayload(
  event: ProviderEvent,
  context: RunAttemptContext,
): RunEventPayload {
  switch (event.type) {
    case "request":
      return {
        type: "exchange.requested",
        ...context,
        request: event.request,
      };
    case "response_started":
      return {
        type: "exchange.response_started",
        ...context,
        response: event.response,
      };
    case "frame":
      return {
        type: "exchange.frame_received",
        ...context,
        frame: event.frame,
      };
    case "text_delta":
      return {
        type: "assistant.text_delta",
        ...context,
        text: event.text,
        source: event.source,
      };
    case "reasoning_delta":
      return {
        type: "assistant.reasoning_delta",
        ...context,
        reasoning: event.reasoning,
        source: event.source,
      };
    case "tool_call_delta":
      return {
        type: "assistant.tool_call_delta",
        ...context,
        toolCallId: event.toolCallId,
        index: event.index,
        providerCallId: event.providerCallId,
        nameDelta: event.nameDelta,
        argumentsDelta: event.argumentsDelta,
        source: event.source,
      };
    case "usage":
      return {
        type: "usage.reported",
        ...context,
        usage: event.usage,
        source: event.source,
      };
    case "completed":
      return {
        type: "assistant.completed",
        ...context,
        finishReason: event.finishReason,
        source: event.source,
      };
  }
}

export function createRunEventFactory(
  runId: RunId,
  options: RunEventFactoryOptions = {},
): RunEventFactory {
  const now = options.now ?? Date.now;
  const createEventId = options.createEventId ?? defaultEventId;
  const startedAt = options.startedAt ?? now();
  let sequence = options.initialSequence ?? 0;

  function create(payload: RunEventPayload): RunEvent {
    const currentSequence = sequence++;
    const timestamp = now();
    return {
      eventId: createEventId(currentSequence),
      runId,
      sequence: currentSequence,
      occurredAt: new Date(timestamp).toISOString(),
      elapsedMs: Math.max(0, timestamp - startedAt),
      ...payload,
    } as RunEvent;
  }

  return {
    create,
    fromProvider(event, context) {
      return create(providerEventPayload(event, context));
    },
  };
}
