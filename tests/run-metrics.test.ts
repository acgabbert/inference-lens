import assert from "node:assert/strict";
import test from "node:test";

import {
  createEntityId,
  createRunState,
  reduceRunEvent,
} from "../packages/core/src/run-kernel/index.ts";
import type {
  ProviderTurnInput,
  ResolvedRunInput,
  RunEvent,
  RunEventMetadata,
  RunId,
  RunState,
} from "../packages/core/src/run-kernel/index.ts";
import {
  parseRunTraceJson,
  runStateFromTrace,
  serializeRunTrace,
} from "../packages/core/src/run-trace.ts";
import { createRunTrace } from "../packages/core/src/run-kernel/index.ts";
import { runMetrics } from "../packages/core/src/run-metrics.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, keyof RunEventMetadata>
    : never
  : never;

const runId = createEntityId("run", "metrics");
const turnId = createEntityId("turn", "first");
const secondTurnId = createEntityId("turn", "second");
const exchangeId = createEntityId("exchange", "first");
const secondExchangeId = createEntityId("exchange", "second");

const turnInput: ProviderTurnInput = {
  target: {
    profileId: createEntityId("profile", "openai"),
    protocol: "openai-compatible-chat-completions",
    endpoint: "https://api.example.com/v1",
    model: "example-model",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  messages: [
    {
      id: createEntityId("message", "user"),
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    },
  ],
  responseMode: "streaming",
  options: {},
  tools: [],
};

const resolvedInput: ResolvedRunInput = {
  runId,
  conversationId: createEntityId("conversation", "metrics"),
  conversationRevisionId: createEntityId("revision", "metrics"),
  ...turnInput,
  templateResolutions: [],
  resolvedAt: "2026-07-25T12:00:00.000Z",
};

/**
 * Builds events with an explicit elapsed stamp so every timing assertion is
 * exact. The production factory derives elapsedMs from a clock; metrics only
 * read the stamp, so supplying it directly keeps these tests free of timers.
 */
function eventStream(id: RunId) {
  let sequence = 0;
  return function next(elapsedMs: number, payload: RunEventPayload): RunEvent {
    const current = sequence++;
    return {
      eventId: createEntityId("event", String(current)),
      runId: id,
      sequence: current,
      occurredAt: new Date(
        Date.parse("2026-07-25T12:00:00.000Z") + elapsedMs,
      ).toISOString(),
      elapsedMs,
      ...payload,
    } as RunEvent;
  };
}

function reduceAll(events: RunEvent[]): RunState {
  return events.reduce(reduceRunEvent, createRunState(runId));
}

const request = {
  url: "https://api.example.com/v1/chat/completions",
  method: "POST",
  headers: { authorization: "Bearer ••••••••" },
  body: '{"model":"example-model"}',
};

const response = {
  status: 200,
  headers: { "content-type": "text/event-stream" },
};

test("derives latency, duration, and throughput for a completed turn", () => {
  const next = eventStream(runId);
  const state = reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(400, {
      type: "exchange.response_started",
      turnId,
      attempt: 1,
      exchangeId,
      response,
    }),
    next(600, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Hel" }),
    next(700, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "lo" }),
    next(1600, {
      type: "usage.reported",
      turnId,
      attempt: 1,
      exchangeId,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    }),
    next(1600, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(1650, { type: "run.completed" }),
  ]);

  const metrics = runMetrics(state);
  const attempt = metrics.attempts[0];

  assert.equal(attempt?.requestedAtMs, 100);
  assert.equal(attempt?.firstByteAtMs, 400);
  assert.equal(attempt?.firstOutputAtMs, 600);
  assert.equal(attempt?.firstTextAtMs, 600);
  assert.equal(attempt?.endedAtMs, 1600);
  // Latencies are relative to the request, not to run start.
  assert.equal(attempt?.ttfbMs, 300);
  assert.equal(attempt?.ttfoMs, 500);
  assert.equal(attempt?.durationMs, 1500);
  // 20 output tokens over the 1000 ms generation phase, excluding the wait.
  assert.equal(attempt?.outputTokensPerSecond, 20);
  assert.equal(attempt?.status, "completed");

  assert.equal(metrics.statusKind, "completed");
  assert.equal(metrics.totalDurationMs, 1650);
  assert.equal(metrics.ttfoMs, 500);
  assert.equal(metrics.outputTokensPerSecond, 20);
  assert.deepEqual(metrics.usage, {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  });
  assert.equal(metrics.turnCount, 1);
  assert.equal(metrics.attemptCount, 1);
  assert.equal(metrics.retryCount, 0);
  assert.equal(metrics.eventCount, 9);
});

test("sums usage across the turns of a tool run", () => {
  const next = eventStream(runId);
  const toolCallId = createEntityId("tool-call", "weather");
  const state = reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(50, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(100, {
      type: "assistant.tool_call_delta",
      turnId,
      attempt: 1,
      exchangeId,
      toolCallId,
      index: 0,
      nameDelta: "get_weather",
      argumentsDelta: '{"city":"Chicago"}',
    }),
    next(200, {
      type: "usage.reported",
      turnId,
      attempt: 1,
      exchangeId,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
    next(200, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "tool_calls", raw: "tool_calls" },
    }),
    next(3000, {
      type: "tool.result_supplied",
      turnId,
      result: {
        id: createEntityId("tool-result", "weather"),
        toolCallId,
        content: [{ type: "text", text: "72°F" }],
        resolution: { kind: "manual" },
      },
    }),
    next(3100, {
      type: "turn.started",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      input: turnInput,
    }),
    next(3150, {
      type: "exchange.requested",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      request,
    }),
    next(3300, {
      type: "assistant.text_delta",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      text: "It is 72°F.",
    }),
    next(3800, {
      type: "usage.reported",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      usage: { inputTokens: 30, outputTokens: 7, totalTokens: 37 },
    }),
    next(3800, {
      type: "assistant.completed",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(3850, { type: "run.completed" }),
  ]);

  const metrics = runMetrics(state);

  assert.equal(metrics.turnCount, 2);
  assert.equal(metrics.attemptCount, 2);
  assert.equal(metrics.retryCount, 0);
  // Turns are labelled by position; the opaque IDs never reach the UI.
  assert.deepEqual(
    metrics.attempts.map(({ turnIndex, attempt }) => [turnIndex, attempt]),
    [
      [1, 1],
      [2, 1],
    ],
  );
  assert.deepEqual(metrics.usage, {
    inputTokens: 40,
    outputTokens: 12,
    totalTokens: 52,
  });
  assert.equal(metrics.attempts[0]?.firstToolCallAtMs, 100);
  assert.equal(metrics.attempts[0]?.ttfoMs, 50);
  assert.equal(metrics.attempts[0]?.outputTokensPerSecond, 50);
  // The 2.8 s spent waiting on the tool result is not charged to the model.
  assert.equal(metrics.outputTokensPerSecond, 20);
  // Tool-call deltas are model output, so the first turn owns run TTFO.
  assert.equal(metrics.ttfoMs, 50);
});

test("measures a retried attempt from its own request and keeps its tokens", () => {
  const next = eventStream(runId);
  const state = reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(200, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Par" }),
    next(250, {
      type: "usage.reported",
      turnId,
      attempt: 1,
      exchangeId,
      usage: { outputTokens: 3, totalTokens: 3 },
    }),
    next(300, {
      type: "turn.attempt_failed",
      turnId,
      attempt: 1,
      exchangeId,
      error: {
        code: "provider_error",
        message: "Service unavailable",
        retryable: true,
        providerStatus: 503,
      },
    }),
    next(1000, {
      type: "turn.attempt_started",
      turnId,
      attempt: 2,
      exchangeId: secondExchangeId,
    }),
    next(1100, {
      type: "exchange.requested",
      turnId,
      attempt: 2,
      exchangeId: secondExchangeId,
      request,
    }),
    next(1200, {
      type: "assistant.text_delta",
      turnId,
      attempt: 2,
      exchangeId: secondExchangeId,
      text: "Recovered",
    }),
    next(2100, {
      type: "usage.reported",
      turnId,
      attempt: 2,
      exchangeId: secondExchangeId,
      usage: { outputTokens: 9, totalTokens: 9 },
    }),
    next(2100, {
      type: "assistant.completed",
      turnId,
      attempt: 2,
      exchangeId: secondExchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(2150, { type: "run.completed" }),
  ]);

  const metrics = runMetrics(state);

  assert.equal(metrics.turnCount, 1);
  assert.equal(metrics.attemptCount, 2);
  assert.equal(metrics.retryCount, 1);
  // The retry waited 100 ms for its own first output; it does not inherit the
  // 1.1 s that elapsed since run start.
  assert.equal(metrics.attempts[0]?.ttfoMs, 100);
  assert.equal(metrics.attempts[1]?.ttfoMs, 100);
  assert.equal(metrics.attempts[0]?.status, "failed");
  assert.equal(metrics.attempts[1]?.status, "completed");
  // Both attempts belong to the same, first turn.
  assert.deepEqual(
    metrics.attempts.map(({ turnIndex, attempt }) => [turnIndex, attempt]),
    [
      [1, 1],
      [1, 2],
    ],
  );
  // Tokens billed for the failed attempt still count toward the run total.
  assert.deepEqual(metrics.usage, { outputTokens: 12, totalTokens: 12 });
});

test("reports partial metrics for a run still streaming", () => {
  const next = eventStream(runId);
  const state = reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(400, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Par" }),
  ]);

  const metrics = runMetrics(state);
  const attempt = metrics.attempts[0];

  assert.equal(metrics.statusKind, "running");
  assert.equal(metrics.totalDurationMs, 400);
  assert.equal(metrics.ttfoMs, 300);
  assert.equal(attempt?.status, "streaming");
  assert.equal(attempt?.endedAtMs, undefined);
  assert.equal(attempt?.durationMs, undefined);
  assert.equal(attempt?.firstByteAtMs, undefined);
  assert.equal(attempt?.ttfbMs, undefined);
  // No usage and no completion: a rate cannot be measured, so none is claimed.
  assert.equal(attempt?.outputTokensPerSecond, undefined);
  assert.equal(metrics.outputTokensPerSecond, undefined);
  assert.deepEqual(metrics.usage, {});
});

test("closes an active attempt when the run fails terminally", () => {
  const next = eventStream(runId);
  const state = reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(300, {
      type: "run.failed",
      error: {
        code: "transport_error",
        message: "Connection closed",
        retryable: false,
      },
    }),
  ]);

  const [attempt] = runMetrics(state).attempts;

  assert.equal(attempt?.status, "failed");
  assert.equal(attempt?.endedAtMs, 300);
  assert.equal(attempt?.durationMs, 200);
});

test("closes and labels an active attempt when the run is cancelled", () => {
  const next = eventStream(runId);
  const state = reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(250, { type: "run.cancelled", reason: "Stopped by user" }),
  ]);

  const [attempt] = runMetrics(state).attempts;

  assert.equal(attempt?.status, "cancelled");
  assert.equal(attempt?.endedAtMs, 250);
  assert.equal(attempt?.durationMs, 150);
});

test("reports no rate when the output span has no measurable length", () => {
  const next = eventStream(runId);
  const state = reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(500, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Hi" }),
    next(500, {
      type: "usage.reported",
      turnId,
      attempt: 1,
      exchangeId,
      usage: { outputTokens: 2, totalTokens: 2 },
    }),
    next(500, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(500, { type: "run.completed" }),
  ]);

  const metrics = runMetrics(state);

  assert.equal(metrics.attempts[0]?.outputTokensPerSecond, undefined);
  assert.equal(metrics.outputTokensPerSecond, undefined);
  assert.equal(metrics.attempts[0]?.durationMs, 400);
});

test("produces identical metrics for a run and its imported trace", () => {
  const next = eventStream(runId);
  const state = reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(400, {
      type: "exchange.response_started",
      turnId,
      attempt: 1,
      exchangeId,
      response,
    }),
    next(600, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Hello" }),
    next(1600, {
      type: "usage.reported",
      turnId,
      attempt: 1,
      exchangeId,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    }),
    next(1600, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(1650, { type: "run.completed" }),
  ]);

  const imported = runStateFromTrace(
    parseRunTraceJson(serializeRunTrace(createRunTrace(state))),
  );

  assert.deepEqual(runMetrics(imported), runMetrics(state));
});
