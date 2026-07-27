import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverOpenAICompatibleModels,
  modelsUrl,
  OpenAICompatibleStreamProtocolError,
  streamOpenAICompatibleProvider,
} from "../packages/core/src/openai-compatible.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import {
  createEntityId,
  createSingleTurnRunExecution,
  createRunEventFactory,
  createRunState,
  createRunTrace,
  isRetryableRunError,
  reduceRunEvent,
  RunCoordinator,
  RunInvariantError,
  transcriptFromRunState,
} from "../packages/core/src/run-kernel/index.ts";
import {
  parseRunTraceJson,
  runStateFromTrace,
  serializeRunTrace,
} from "../packages/core/src/run-trace.ts";
import type {
  ProviderTurnInput,
  ResolvedRunInput,
  RunEvent,
  RunEventMetadata,
  RunId,
} from "../packages/core/src/run-kernel/index.ts";

type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, keyof RunEventMetadata>
    : never
  : never;

const runId = createEntityId("run", "test");
const turnId = createEntityId("turn", "first");
const exchangeId = createEntityId("exchange", "first");
const profileId = createEntityId("profile", "openai");
const conversationId = createEntityId("conversation", "test");
const revisionId = createEntityId("revision", "test");

const initialMessage = {
  id: createEntityId("message", "user"),
  role: "user" as const,
  content: [{ type: "text" as const, text: "Hello" }],
};

const turnInput: ProviderTurnInput = {
  target: {
    profileId,
    protocol: "openai-compatible-chat-completions",
    endpoint: "https://api.example.com/v1",
    model: "example-model",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  messages: [initialMessage],
  options: { temperature: 0.2 },
  tools: [],
};

const providerExecution = {
  runId,
  turnId,
  attempt: 1 as const,
  exchangeId,
  input: turnInput,
};

const resolvedInput: ResolvedRunInput = {
  runId,
  conversationId,
  conversationRevisionId: revisionId,
  ...turnInput,
  templateResolutions: [],
  resolvedAt: "2026-07-23T12:00:00.000Z",
};

test("preserves rich draft message and tool-call IDs in a new run", () => {
  const messages = [
    {
      id: createEntityId("message", "assistant"),
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Calling lookup." }],
      toolCalls: [
        {
          id: createEntityId("tool-call", "lookup"),
          name: "lookup",
          arguments: { text: "{}" },
        },
      ],
    },
    {
      id: createEntityId("message", "tool"),
      role: "tool" as const,
      toolCallId: createEntityId("tool-call", "lookup"),
      name: "lookup",
      content: [{ type: "text" as const, text: "result" }],
    },
  ];
  const execution = createSingleTurnRunExecution(
    {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      messages,
    },
    {
      conversationId: createEntityId("conversation", "rich"),
      conversationRevisionId: createEntityId("revision", "rich"),
    },
    "rich",
  );

  assert.deepEqual(execution.input.messages, messages);
  assert.equal(execution.turnInput.messages[1].role, "tool");
  if (execution.turnInput.messages[1].role === "tool") {
    assert.equal(execution.turnInput.messages[1].toolCallId, "tool-call_lookup");
  }
});

function eventFactory(id: RunId) {
  let sequence = 0;
  return (payload: RunEventPayload): RunEvent => {
    const current = sequence++;
    return {
      eventId: createEntityId("event", String(current)),
      runId: id,
      sequence: current,
      occurredAt: `2026-07-23T12:00:${String(current).padStart(2, "0")}.000Z`,
      elapsedMs: current * 10,
      ...payload,
    } as RunEvent;
  };
}

test("reduces a complete text run into an immutable trace", () => {
  const nextEvent = eventFactory(runId);
  const events: RunEvent[] = [
    nextEvent({ type: "run.started", input: resolvedInput }),
    nextEvent({
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    nextEvent({
      type: "exchange.requested",
      turnId,
      attempt: 1,
      exchangeId,
      request: {
        url: "https://api.example.com/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: "Bearer ••••••••",
          "content-type": "application/json",
        },
        body: '{"model":"example-model"}',
      },
    }),
    nextEvent({
      type: "exchange.response_started",
      turnId,
      attempt: 1,
      exchangeId,
      response: {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    }),
    nextEvent({
      type: "exchange.frame_received",
      turnId,
      attempt: 1,
      exchangeId,
      frame: { index: 0, raw: "data: {\"choices\":[]}" },
    }),
    nextEvent({
      type: "assistant.text_delta",
      turnId,
      attempt: 1,
      exchangeId,
      text: "Hello",
      source: { exchangeId, frameIndex: 0 },
    }),
    nextEvent({
      type: "assistant.reasoning_delta",
      turnId,
      attempt: 1,
      exchangeId,
      reasoning: "I should greet the user first.",
      source: { exchangeId, frameIndex: 0 },
    }),
    nextEvent({
      type: "assistant.text_delta",
      turnId,
      attempt: 1,
      exchangeId,
      text: " world",
    }),
    nextEvent({
      type: "usage.reported",
      turnId,
      attempt: 1,
      exchangeId,
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    }),
    nextEvent({
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    nextEvent({ type: "run.completed" }),
  ];

  const state = events.reduce(reduceRunEvent, createRunState(runId));
  const trace = createRunTrace(state);

  assert.equal(trace.status.kind, "completed");
  assert.equal(trace.turns[0]?.attempts[0]?.text, "Hello world");
  assert.equal(
    trace.turns[0]?.attempts[0]?.reasoning,
    "I should greet the user first.",
  );
  assert.deepEqual(trace.turns[0]?.attempts[0]?.usage, {
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
  });
  assert.equal(trace.exchanges[exchangeId].frames.length, 1);
  assert.equal(trace.events.length, events.length);
  assert.equal("credential" in trace.input, false);
});

test("records trailing usage after assistant completion", () => {
  const nextEvent = eventFactory(runId);
  const events: RunEvent[] = [
    nextEvent({ type: "run.started", input: resolvedInput }),
    nextEvent({
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    nextEvent({
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    nextEvent({
      type: "usage.reported",
      turnId,
      attempt: 1,
      exchangeId,
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    }),
    nextEvent({ type: "run.completed" }),
  ];

  const state = events.reduce(reduceRunEvent, createRunState(runId));

  assert.equal(state.status.kind, "completed");
  assert.deepEqual(state.turns[0]?.attempts[0]?.usage, {
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
  });
});

test("records trailing exchange frames after assistant completion", () => {
  const nextEvent = eventFactory(runId);
  const events: RunEvent[] = [
    nextEvent({ type: "run.started", input: resolvedInput }),
    nextEvent({
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    nextEvent({
      type: "exchange.requested",
      turnId,
      attempt: 1,
      exchangeId,
      request: {
        url: "https://api.example.com/v1/chat/completions",
        method: "POST",
        headers: {},
      },
    }),
    nextEvent({
      type: "exchange.response_started",
      turnId,
      attempt: 1,
      exchangeId,
      response: { status: 200, headers: {} },
    }),
    nextEvent({
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    nextEvent({
      type: "exchange.frame_received",
      turnId,
      attempt: 1,
      exchangeId,
      frame: {
        index: 0,
        raw: 'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
      },
    }),
    nextEvent({
      type: "usage.reported",
      turnId,
      attempt: 1,
      exchangeId,
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    }),
    nextEvent({ type: "run.completed" }),
  ];

  const state = events.reduce(reduceRunEvent, createRunState(runId));

  assert.equal(state.status.kind, "completed");
  assert.equal(state.exchanges[exchangeId].frames.length, 1);
  assert.deepEqual(state.turns[0]?.attempts[0]?.usage, {
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
  });
});

test("rejects content deltas after assistant completion", () => {
  const nextEvent = eventFactory(runId);
  let state = createRunState(runId);
  for (const event of [
    nextEvent({ type: "run.started", input: resolvedInput }),
    nextEvent({
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    nextEvent({
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
  ]) {
    state = reduceRunEvent(state, event);
  }

  assert.throws(
    () =>
      reduceRunEvent(
        state,
        nextEvent({
          type: "assistant.text_delta",
          turnId,
          attempt: 1,
          exchangeId,
          text: "late content",
        }),
      ),
    /already complete/,
  );
});

test("assembles tool-call deltas and pauses after receiving all results", () => {
  const nextEvent = eventFactory(runId);
  const toolCallId = createEntityId("tool-call", "weather");
  const resultId = createEntityId("tool-result", "weather");
  let state = createRunState(runId);

  for (const current of [
    nextEvent({ type: "run.started", input: resolvedInput }),
    nextEvent({
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    nextEvent({
      type: "assistant.tool_call_delta",
      turnId,
      attempt: 1,
      exchangeId,
      toolCallId,
      index: 0,
      providerCallId: "call_provider_1",
      nameDelta: "get_weather",
      argumentsDelta: '{"city":',
    }),
    nextEvent({
      type: "assistant.tool_call_delta",
      turnId,
      attempt: 1,
      exchangeId,
      toolCallId,
      index: 0,
      argumentsDelta: '"Chicago"}',
    }),
    nextEvent({
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "tool_calls", raw: "tool_calls" },
    }),
  ]) {
    state = reduceRunEvent(state, current);
  }

  assert.deepEqual(state.status, {
    kind: "awaiting_tool_results",
    turnId,
    pendingToolCallIds: [toolCallId],
  });
  assert.deepEqual(
    state.turns[0]?.attempts[0]?.completedToolCalls?.[0]?.arguments,
    {
      text: '{"city":"Chicago"}',
      parsed: { city: "Chicago" },
    },
  );

  state = reduceRunEvent(
    state,
    nextEvent({
      type: "tool.result_supplied",
      turnId,
      result: {
        id: resultId,
        toolCallId,
        content: [{ type: "text", text: "72°F and clear" }],
        resolution: { kind: "manual" },
      },
    }),
  );

  assert.deepEqual(state.status, {
    kind: "paused",
    reason: "tool_results_ready",
  });
  assert.equal(state.toolResults[0]?.id, resultId);
});

test("coordinates a tool result into a second provider turn", () => {
  const input: ResolvedRunInput = {
    ...resolvedInput,
    target: {
      ...resolvedInput.target,
      capabilities: {
        ...OPENAI_COMPATIBLE_CAPABILITIES,
        tools: true,
      },
    },
    tools: [
      {
        id: createEntityId("tool", "weather"),
        name: "get_weather",
        description: "Look up current weather.",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
  };
  const coordinator = new RunCoordinator(input);
  const first = coordinator.start();
  const callId = createEntityId("tool-call", "coordinator-weather");

  coordinator.accept({
    type: "tool_call_delta",
    toolCallId: callId,
    index: 0,
    providerCallId: "call_weather_1",
    nameDelta: "get_weather",
    argumentsDelta: '{"city":"Chicago"}',
  });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "tool_calls", raw: "tool_calls" },
  });
  assert.deepEqual(coordinator.finishTurnStream(), []);
  assert.equal(coordinator.state.status.kind, "awaiting_tool_results");

  coordinator.supplyToolResults([
    {
      id: createEntityId("tool-result", "coordinator-weather"),
      toolCallId: callId,
      content: [{ type: "text", text: "72°F and clear" }],
      resolution: { kind: "manual" },
    },
  ]);
  const second = coordinator.continue();

  assert.notEqual(first.execution.turnId, second.execution.turnId);
  assert.equal(second.execution.input.messages.at(-2)?.role, "assistant");
  assert.equal(second.execution.input.messages.at(-1)?.role, "tool");
  const assistant = second.execution.input.messages.at(-2);
  const tool = second.execution.input.messages.at(-1);
  assert.equal(
    assistant?.role === "assistant"
      ? assistant.toolCalls?.[0]?.providerCallId
      : undefined,
    "call_weather_1",
  );
  assert.equal(
    tool?.role === "tool" ? tool.toolCallId : undefined,
    callId,
  );

  coordinator.accept({ type: "reasoning_delta", reasoning: "It's Chicago, 72°F." });
  coordinator.accept({ type: "text_delta", text: "It is 72°F." });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop", raw: "stop" },
  });
  coordinator.finishTurnStream();

  assert.equal(coordinator.state.status.kind, "completed");
  assert.deepEqual(
    coordinator.state.events.map(({ type }) => type),
    [
      "run.started",
      "turn.started",
      "assistant.tool_call_delta",
      "assistant.completed",
      "tool.result_supplied",
      "turn.started",
      "assistant.reasoning_delta",
      "assistant.text_delta",
      "assistant.completed",
      "run.completed",
    ],
  );

  const transcript = transcriptFromRunState(coordinator.state);
  assert.deepEqual(transcript.map(({ message }) => message.role), [
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  assert.deepEqual(transcript.map(({ message }) => message.id), [
    "message_user",
    "message_test-t1-assistant",
    "message_test-t1-r1",
    "message_test-t2-assistant",
  ]);
  // Reasoning is evidence about the turn, kept off the message itself; it
  // belongs only to the assistant entry whose attempt produced it.
  assert.deepEqual(
    transcript.map((entry) => entry.reasoning),
    [undefined, undefined, undefined, "It's Chicago, 72°F."],
  );
  const imported = runStateFromTrace(
    parseRunTraceJson(serializeRunTrace(createRunTrace(coordinator.state))),
  );
  assert.deepEqual(transcriptFromRunState(imported), transcript);
});

test("retries a failed turn with the same input and a new exchange", () => {
  const coordinator = new RunCoordinator(resolvedInput);
  const first = coordinator.start();

  coordinator.accept({ type: "text_delta", text: "Partial" });
  coordinator.accept({
    type: "failed",
    error: {
      code: "provider_error",
      message: "Temporarily unavailable.",
      providerStatus: 503,
      retryable: true,
    },
  });

  assert.deepEqual(coordinator.finishTurnStream(), []);
  assert.equal(coordinator.state.status.kind, "paused");
  assert.equal(coordinator.state.turns[0]?.attempts[0]?.status, "failed");
  assert.equal(coordinator.state.turns[0]?.attempts[0]?.text, "Partial");

  const second = coordinator.retry();
  assert.equal(second.execution.turnId, first.execution.turnId);
  assert.equal(second.execution.attempt, 2);
  assert.notEqual(second.execution.exchangeId, first.execution.exchangeId);
  assert.equal(second.execution.input, first.execution.input);

  coordinator.accept({ type: "text_delta", text: "Recovered" });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop", raw: "stop" },
  });
  coordinator.finishTurnStream();

  assert.equal(coordinator.state.status.kind, "completed");
  assert.equal(coordinator.state.turns[0]?.attempts.length, 2);
  assert.equal(coordinator.state.turns[0]?.attempts[0]?.text, "Partial");
  assert.equal(coordinator.state.turns[0]?.attempts[1]?.text, "Recovered");
  assert.equal(
    coordinator.state.exchanges[first.execution.exchangeId].attempt,
    1,
  );
  assert.equal(
    coordinator.state.exchanges[second.execution.exchangeId].attempt,
    2,
  );
  const transcript = transcriptFromRunState(coordinator.state);
  const lastMessage = transcript.at(-1)?.message;
  assert.equal(lastMessage?.role, "assistant");
  assert.equal(
    lastMessage?.role === "assistant"
      ? lastMessage.content[0]?.text
      : undefined,
    "Recovered",
  );
  assert.deepEqual(
    coordinator.state.events.map(({ type }) => type),
    [
      "run.started",
      "turn.started",
      "assistant.text_delta",
      "turn.attempt_failed",
      "turn.attempt_started",
      "assistant.text_delta",
      "assistant.completed",
      "run.completed",
    ],
  );
});

test("ends a cancelled transcript at its last completed turn", () => {
  const coordinator = new RunCoordinator({
    ...resolvedInput,
    target: {
      ...resolvedInput.target,
      capabilities: { ...OPENAI_COMPATIBLE_CAPABILITIES, tools: true },
    },
  });
  const callId = createEntityId("tool-call", "cancelled-weather");
  coordinator.start();
  coordinator.accept({
    type: "tool_call_delta",
    toolCallId: callId,
    index: 0,
    nameDelta: "get_weather",
    argumentsDelta: "{}",
  });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "tool_calls", raw: "tool_calls" },
  });
  coordinator.finishTurnStream();
  coordinator.supplyToolResults([{
    id: createEntityId("tool-result", "cancelled-weather"),
    toolCallId: callId,
    content: [{ type: "text", text: "72°F and clear" }],
    resolution: { kind: "manual" },
  }]);
  coordinator.continue();
  coordinator.accept({ type: "text_delta", text: "Partial second turn" });
  coordinator.cancel("Stopped by user.");

  assert.equal(coordinator.state.status.kind, "cancelled");
  assert.deepEqual(
    transcriptFromRunState(coordinator.state).map(({ message }) => message.role),
    ["user", "assistant", "tool"],
  );
});

test("keeps non-retryable turn failures terminal", () => {
  const coordinator = new RunCoordinator(resolvedInput);
  coordinator.start();
  coordinator.accept({
    type: "failed",
    error: {
      code: "provider_error",
      message: "Invalid API key.",
      providerStatus: 401,
      retryable: false,
    },
  });

  assert.equal(coordinator.state.status.kind, "failed");
  assert.throws(() => coordinator.retry(), /no failed attempt/i);
});

test("can finalize a paused retryable failure without retrying", () => {
  const coordinator = new RunCoordinator(resolvedInput);
  coordinator.start();
  const error = {
    code: "transport_error" as const,
    message: "Connection reset.",
    retryable: true,
  };
  coordinator.accept({ type: "failed", error });
  coordinator.fail(error);

  assert.deepEqual(coordinator.state.status, {
    kind: "failed",
    failedAt: coordinator.state.endedAt,
    error,
  });
});

test("classifies only transient provider statuses and transport errors as retryable", () => {
  for (const providerStatus of [408, 429, 500, 502, 503, 599]) {
    assert.equal(
      isRetryableRunError({ code: "provider_error", providerStatus }),
      true,
    );
  }
  for (const providerStatus of [400, 401, 403, 404, 600]) {
    assert.equal(
      isRetryableRunError({ code: "provider_error", providerStatus }),
      false,
    );
  }
  assert.equal(isRetryableRunError({ code: "transport_error" }), true);
  assert.equal(isRetryableRunError({ code: "protocol_error" }), false);
});

test("rejects gaps and events after a terminal event", () => {
  const nextEvent = eventFactory(runId);
  let state = createRunState(runId);
  state = reduceRunEvent(
    state,
    nextEvent({ type: "run.started", input: resolvedInput }),
  );

  const skippedSequence = {
    ...nextEvent({ type: "run.cancelled", reason: "test" }),
    sequence: 3,
  } as RunEvent;
  assert.throws(
    () => reduceRunEvent(state, skippedSequence),
    RunInvariantError,
  );

  state = reduceRunEvent(
    state,
    {
      ...skippedSequence,
      sequence: 1,
    },
  );
  assert.equal(state.status.kind, "cancelled");
  assert.deepEqual(
    transcriptFromRunState(state),
    resolvedInput.messages.map((message) => ({ message })),
  );

  assert.throws(
    () =>
      reduceRunEvent(
        state,
        {
          ...nextEvent({ type: "run.completed" }),
          sequence: 2,
        },
      ),
    /terminal/,
  );
});

test("stamps provider events with ordered run metadata", () => {
  const timestamps = [
    Date.parse("2026-07-23T12:00:00.000Z"),
    Date.parse("2026-07-23T12:00:00.010Z"),
    Date.parse("2026-07-23T12:00:00.025Z"),
  ];
  const factory = createRunEventFactory(runId, {
    now: () => timestamps.shift() ?? 0,
    createEventId: (sequence) => createEntityId("event", `provider-${sequence}`),
  });
  const context = { turnId, attempt: 1, exchangeId };

  const requestEvent = factory.fromProvider(
    {
      type: "request",
      request: {
        url: "https://api.example.com/v1/chat/completions",
        method: "POST",
        headers: { authorization: "Bearer ••••••••" },
      },
    },
    context,
  );
  const deltaEvent = factory.fromProvider(
    {
      type: "text_delta",
      text: "hello",
      source: { exchangeId, frameIndex: 0 },
    },
    context,
  );

  assert.equal(requestEvent.type, "exchange.requested");
  assert.equal(requestEvent.sequence, 0);
  assert.equal(requestEvent.elapsedMs, 10);
  assert.equal(deltaEvent.type, "assistant.text_delta");
  assert.equal(deltaEvent.sequence, 1);
  assert.equal(deltaEvent.elapsedMs, 25);
  if (deltaEvent.type === "assistant.text_delta") {
    assert.equal(deltaEvent.text, "hello");
    assert.deepEqual(deltaEvent.source, { exchangeId, frameIndex: 0 });
  }
});

test("emits provider events with raw frames and normalized deltas", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = "";
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
    "data: [DONE]",
    "",
  ].join("\n");
  globalThis.fetch = async (_input, init) => {
    sentBody = String(init?.body);
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const providerEvents = [];
    for await (const event of streamOpenAICompatibleProvider(
      providerExecution,
      "secret",
    )) {
      providerEvents.push(event);
    }
    assert.deepEqual(
      providerEvents.map(({ type }) => type),
      [
        "request",
        "response_started",
        "frame",
        "text_delta",
        "frame",
        "usage",
        "completed",
        "frame",
      ],
    );
    const request = providerEvents.find(({ type }) => type === "request");
    assert.equal(request?.type, "request");
    if (request?.type === "request") {
      assert.equal(request.request.body, sentBody);
    }

  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("serializes tool definitions, assistant calls, and tool results", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const callId = createEntityId("tool-call", "serialize-weather");
  const execution = {
    ...providerExecution,
    input: {
      ...turnInput,
      target: {
        ...turnInput.target,
        capabilities: { ...OPENAI_COMPATIBLE_CAPABILITIES, tools: true },
      },
      messages: [
        initialMessage,
        {
          id: createEntityId("message", "assistant-tool"),
          role: "assistant" as const,
          content: [],
          toolCalls: [
            {
              id: callId,
              providerCallId: "call_provider_weather",
              name: "get_weather",
              arguments: {
                text: '{"city":"Chicago"}',
                parsed: { city: "Chicago" },
              },
            },
          ],
        },
        {
          id: createEntityId("message", "weather-result"),
          role: "tool" as const,
          toolCallId: callId,
          name: "get_weather",
          content: [{ type: "text" as const, text: "72°F" }],
        },
      ],
      tools: [
        {
          id: createEntityId("tool", "weather"),
          name: "get_weather",
          description: "Look up weather.",
          inputSchema: { type: "object" },
        },
      ],
    },
  };

  try {
    for await (const event of streamOpenAICompatibleProvider(
      execution,
      "secret",
    )) {
      assert.ok(event.type);
    }
    const messages = sentBody?.messages as Array<Record<string, unknown>>;
    const tools = sentBody?.tools as Array<Record<string, unknown>>;
    assert.equal(
      (messages[1]?.tool_calls as Array<{ id: string }>)[0]?.id,
      "call_provider_weather",
    );
    assert.equal(messages[2]?.tool_call_id, "call_provider_weather");
    assert.deepEqual(tools[0], {
      type: "function",
      function: {
        name: "get_weather",
        description: "Look up weather.",
        parameters: { type: "object" },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes streamed provider reasoning separately from answer text", async () => {
  const originalFetch = globalThis.fetch;
  const sse = [
    'data: {"choices":[{"delta":{"reasoning":" Parks","reasoning_details":[{"type":"reasoning.text","text":" Parks"}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}',
    "data: [DONE]",
    "",
  ].join("\n");
  globalThis.fetch = async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  try {
    const events = [];
    for await (const event of streamOpenAICompatibleProvider(
      providerExecution,
      "secret",
    )) {
      events.push(event);
    }
    assert.deepEqual(
      events.map(({ type }) => type),
      [
        "request",
        "response_started",
        "frame",
        "reasoning_delta",
        "frame",
        "text_delta",
        "completed",
        "frame",
      ],
    );
    const reasoning = events.find(({ type }) => type === "reasoning_delta");
    assert.equal(reasoning?.type, "reasoning_delta");
    if (reasoning?.type === "reasoning_delta") {
      assert.equal(reasoning.reasoning, " Parks");
    }

  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("treats [DONE] as a completion when no finish reason was sent", async () => {
  const originalFetch = globalThis.fetch;
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
    "data: [DONE]",
  ].join("\n");
  globalThis.fetch = async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  try {
    const providerEvents = [];
    for await (const event of streamOpenAICompatibleProvider(
      providerExecution,
      "secret",
    )) {
      providerEvents.push(event);
    }
    assert.deepEqual(
      providerEvents.map(({ type }) => type),
      [
        "request",
        "response_started",
        "frame",
        "text_delta",
        "frame",
        "completed",
      ],
    );
    const completion = providerEvents.at(-1);
    assert.deepEqual(completion, {
      type: "completed",
      finishReason: { normalized: "other" },
      source: {
        exchangeId: providerExecution.exchangeId,
        frameIndex: 1,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an EOF without an OpenAI-compatible terminal signal", async () => {
  const originalFetch = globalThis.fetch;
  const sse =
    'data: {"choices":[{"delta":{"content":"Incomplete"},"finish_reason":null}]}';
  globalThis.fetch = async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  try {
    let partialText = "";
    await assert.rejects(
      async () => {
        for await (const event of streamOpenAICompatibleProvider(
          providerExecution,
          "secret",
        )) {
          if (event.type === "text_delta") partialText += event.text;
        }
      },
      OpenAICompatibleStreamProtocolError,
    );
    assert.equal(partialText, "Incomplete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("constructs model-discovery URLs and normalizes discovered model IDs", async () => {
  assert.equal(
    modelsUrl("https://api.example.com/v1"),
    "https://api.example.com/v1/models",
  );
  assert.equal(
    modelsUrl("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1/models",
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://api.example.com/v1/models");
    assert.deepEqual(init, {
      method: "GET",
      headers: { authorization: "Bearer secret" },
      signal: undefined,
    });
    return Response.json({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "z-model" }, {}] });
  };

  try {
    assert.deepEqual(
      await discoverOpenAICompatibleModels({
        endpoint: "https://api.example.com/v1",
        apiKey: "secret",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      }),
      ["a-model", "z-model"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not call a provider when the profile disables model discovery", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch must not be called");
  };

  try {
    await assert.rejects(
      discoverOpenAICompatibleModels({
        endpoint: "https://api.example.com/v1",
        apiKey: "secret",
        capabilities: {
          ...OPENAI_COMPATIBLE_CAPABILITIES,
          modelDiscovery: false,
        },
      }),
      /Model discovery is not supported/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not serialize a streaming request when the profile disables it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch must not be called");
  };

  try {
    await assert.rejects(
      () =>
        streamOpenAICompatibleProvider(
          {
            ...providerExecution,
            input: {
              ...turnInput,
              target: {
                ...turnInput.target,
                capabilities: {
                  ...OPENAI_COMPATIBLE_CAPABILITIES,
                  streaming: false,
                },
              },
            },
          },
          "secret",
        ).next(),
      /Streaming is not supported/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
