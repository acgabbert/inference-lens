import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRunHistoryFiles,
  summarizeRunTrace,
} from "../packages/core/src/run-history.ts";
import {
  createEntityId,
  createRunState,
  createRunTrace,
  reduceRunEvent,
} from "../packages/core/src/run-kernel/index.ts";
import type {
  ProviderTurnInput,
  ResolvedRunInput,
  RunEvent,
  RunEventMetadata,
  RunState,
  RunTrace,
} from "../packages/core/src/run-kernel/index.ts";
import { serializeRunTrace } from "../packages/core/src/run-trace.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, keyof RunEventMetadata>
    : never
  : never;

const request = {
  url: "https://api.example.com/v1/chat/completions",
  method: "POST",
  headers: { authorization: "Bearer ••••••••" },
};

/**
 * Traces differ per test in run ID, model, and start instant, because those
 * are what the list projection sorts and labels on. Everything else follows
 * the fixture idiom the metrics tests use: explicit elapsed stamps, so no
 * assertion here depends on a clock.
 */
function traceFixture(spec: {
  suffix: string;
  model?: string;
  startedAt?: string;
  userMessages?: number;
}) {
  const runId = createEntityId("run", spec.suffix);
  const startedAt = spec.startedAt ?? "2026-07-25T12:00:00.000Z";
  const target = {
    profileId: createEntityId("profile", "history"),
    protocol: "openai-compatible-chat-completions" as const,
    endpoint: "https://api.example.com/v1",
    model: spec.model ?? "example-model",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  };
  const messages = Array.from(
    { length: spec.userMessages ?? 1 },
    (_unused, index) => ({
      id: createEntityId("message", `${spec.suffix}-${index}`),
      role: "user" as const,
      content: [{ type: "text" as const, text: `Hello ${index}` }],
    }),
  );
  const turnInput: ProviderTurnInput = {
    target,
    messages,
    options: {},
    tools: [],
  };
  const resolvedInput: ResolvedRunInput = {
    runId,
    conversationId: createEntityId("conversation", spec.suffix),
    conversationRevisionId: createEntityId("revision", spec.suffix),
    ...turnInput,
    templateResolutions: [],
    resolvedAt: startedAt,
  };

  let sequence = 0;
  function next(elapsedMs: number, payload: RunEventPayload): RunEvent {
    const current = sequence++;
    return {
      eventId: createEntityId("event", `${spec.suffix}-${current}`),
      runId,
      sequence: current,
      occurredAt: new Date(Date.parse(startedAt) + elapsedMs).toISOString(),
      elapsedMs,
      ...payload,
    } as RunEvent;
  }

  function reduceAll(events: RunEvent[]): RunState {
    return events.reduce(reduceRunEvent, createRunState(runId));
  }

  return {
    startedAt,
    turnInput,
    resolvedInput,
    next,
    reduceAll,
    turn: (name: string) => createEntityId("turn", `${spec.suffix}-${name}`),
    exchange: (name: string) =>
      createEntityId("exchange", `${spec.suffix}-${name}`),
    toolCall: (name: string) =>
      createEntityId("tool-call", `${spec.suffix}-${name}`),
    toolResult: (name: string) =>
      createEntityId("tool-result", `${spec.suffix}-${name}`),
  };
}

/** A one-turn, one-attempt run that completes: the ordinary history entry. */
function completedTrace(spec: {
  suffix: string;
  model?: string;
  startedAt?: string;
}): RunTrace {
  const fixture = traceFixture(spec);
  const turnId = fixture.turn("only");
  const exchangeId = fixture.exchange("only");
  return createRunTrace(
    fixture.reduceAll([
      fixture.next(0, { type: "run.started", input: fixture.resolvedInput }),
      fixture.next(0, {
        type: "turn.started",
        turnId,
        attempt: 1,
        exchangeId,
        input: fixture.turnInput,
      }),
      fixture.next(50, {
        type: "exchange.requested",
        turnId,
        attempt: 1,
        exchangeId,
        request,
      }),
      fixture.next(100, {
        type: "assistant.text_delta",
        turnId,
        attempt: 1,
        exchangeId,
        text: "Hello",
      }),
      fixture.next(500, {
        type: "usage.reported",
        turnId,
        attempt: 1,
        exchangeId,
        usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
      }),
      fixture.next(500, {
        type: "assistant.completed",
        turnId,
        attempt: 1,
        exchangeId,
        finishReason: { normalized: "stop" },
      }),
      fixture.next(550, { type: "run.completed" }),
    ]),
  );
}

test("derives a compact history summary from canonical trace evidence", () => {
  const trace = completedTrace({
    suffix: "history-summary",
    model: "example-model",
    startedAt: "2026-07-25T12:00:00.000Z",
  });

  assert.deepEqual(summarizeRunTrace(trace), {
    runId: createEntityId("run", "history-summary"),
    startedAt: "2026-07-25T12:00:00.000Z",
    endedAt: "2026-07-25T12:00:00.550Z",
    status: "completed",
    model: "example-model",
    durationMs: 550,
    usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    turnCount: 1,
    attemptCount: 1,
    retryCount: 0,
    messageCount: 1,
  });
});

test("counts the attempts a failed run burned before giving up", () => {
  const fixture = traceFixture({ suffix: "history-failed" });
  const turnId = fixture.turn("only");
  const first = fixture.exchange("first");
  const second = fixture.exchange("second");
  const error = {
    code: "provider_error" as const,
    message: "Service unavailable",
    retryable: true,
    providerStatus: 503,
  };
  const trace = createRunTrace(
    fixture.reduceAll([
      fixture.next(0, { type: "run.started", input: fixture.resolvedInput }),
      fixture.next(0, {
        type: "turn.started",
        turnId,
        attempt: 1,
        exchangeId: first,
        input: fixture.turnInput,
      }),
      fixture.next(50, {
        type: "exchange.requested",
        turnId,
        attempt: 1,
        exchangeId: first,
        request,
      }),
      fixture.next(300, {
        type: "turn.attempt_failed",
        turnId,
        attempt: 1,
        exchangeId: first,
        error,
      }),
      fixture.next(1000, {
        type: "turn.attempt_started",
        turnId,
        attempt: 2,
        exchangeId: second,
      }),
      fixture.next(1050, {
        type: "exchange.requested",
        turnId,
        attempt: 2,
        exchangeId: second,
        request,
      }),
      fixture.next(1100, {
        type: "usage.reported",
        turnId,
        attempt: 2,
        exchangeId: second,
        usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 },
      }),
      fixture.next(1300, {
        type: "turn.attempt_failed",
        turnId,
        attempt: 2,
        exchangeId: second,
        error,
      }),
      fixture.next(1350, { type: "run.failed", error }),
    ]),
  );

  const summary = summarizeRunTrace(trace);

  assert.equal(summary.status, "failed");
  assert.equal(summary.turnCount, 1);
  assert.equal(summary.attemptCount, 2);
  assert.equal(summary.retryCount, 1);
  assert.equal(summary.durationMs, 1350);
  // Tokens a later-failed attempt reported were still billed, so they show.
  assert.deepEqual(summary.usage, {
    inputTokens: 4,
    outputTokens: 0,
    totalTokens: 4,
  });
});

test("reports a cancelled run as cancelled rather than as a failure", () => {
  const fixture = traceFixture({ suffix: "history-cancelled" });
  const turnId = fixture.turn("only");
  const exchangeId = fixture.exchange("only");
  const trace = createRunTrace(
    fixture.reduceAll([
      fixture.next(0, { type: "run.started", input: fixture.resolvedInput }),
      fixture.next(0, {
        type: "turn.started",
        turnId,
        attempt: 1,
        exchangeId,
        input: fixture.turnInput,
      }),
      fixture.next(50, {
        type: "exchange.requested",
        turnId,
        attempt: 1,
        exchangeId,
        request,
      }),
      fixture.next(200, {
        type: "assistant.text_delta",
        turnId,
        attempt: 1,
        exchangeId,
        text: "Partial",
      }),
      fixture.next(400, { type: "run.cancelled", reason: "User stopped" }),
    ]),
  );

  const summary = summarizeRunTrace(trace);

  assert.equal(summary.status, "cancelled");
  assert.equal(summary.durationMs, 400);
  // Nothing reported usage before the stop; absence must not become zero.
  assert.deepEqual(summary.usage, {});
});

test("counts every turn and every resolved input message of a tool run", () => {
  const fixture = traceFixture({ suffix: "history-tools", userMessages: 3 });
  const firstTurn = fixture.turn("first");
  const secondTurn = fixture.turn("second");
  const firstExchange = fixture.exchange("first");
  const secondExchange = fixture.exchange("second");
  const toolCallId = fixture.toolCall("weather");
  const trace = createRunTrace(
    fixture.reduceAll([
      fixture.next(0, { type: "run.started", input: fixture.resolvedInput }),
      fixture.next(0, {
        type: "turn.started",
        turnId: firstTurn,
        attempt: 1,
        exchangeId: firstExchange,
        input: fixture.turnInput,
      }),
      fixture.next(50, {
        type: "exchange.requested",
        turnId: firstTurn,
        attempt: 1,
        exchangeId: firstExchange,
        request,
      }),
      fixture.next(100, {
        type: "assistant.tool_call_delta",
        turnId: firstTurn,
        attempt: 1,
        exchangeId: firstExchange,
        toolCallId,
        index: 0,
        nameDelta: "get_weather",
        argumentsDelta: "{}",
      }),
      fixture.next(150, {
        type: "usage.reported",
        turnId: firstTurn,
        attempt: 1,
        exchangeId: firstExchange,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
      fixture.next(200, {
        type: "assistant.completed",
        turnId: firstTurn,
        attempt: 1,
        exchangeId: firstExchange,
        finishReason: { normalized: "tool_calls" },
      }),
      fixture.next(3000, {
        type: "tool.result_supplied",
        turnId: firstTurn,
        result: {
          id: fixture.toolResult("weather"),
          toolCallId,
          content: [{ type: "text", text: "72°F" }],
          resolution: { kind: "manual" },
        },
      }),
      fixture.next(3100, {
        type: "turn.started",
        turnId: secondTurn,
        attempt: 1,
        exchangeId: secondExchange,
        input: fixture.turnInput,
      }),
      fixture.next(3150, {
        type: "exchange.requested",
        turnId: secondTurn,
        attempt: 1,
        exchangeId: secondExchange,
        request,
      }),
      fixture.next(3300, {
        type: "assistant.text_delta",
        turnId: secondTurn,
        attempt: 1,
        exchangeId: secondExchange,
        text: "It is 72°F.",
      }),
      fixture.next(3800, {
        type: "usage.reported",
        turnId: secondTurn,
        attempt: 1,
        exchangeId: secondExchange,
        usage: { inputTokens: 30, outputTokens: 7, totalTokens: 37 },
      }),
      fixture.next(3800, {
        type: "assistant.completed",
        turnId: secondTurn,
        attempt: 1,
        exchangeId: secondExchange,
        finishReason: { normalized: "stop" },
      }),
      fixture.next(3850, { type: "run.completed" }),
    ]),
  );

  const summary = summarizeRunTrace(trace);

  assert.equal(summary.turnCount, 2);
  assert.equal(summary.attemptCount, 2);
  assert.equal(summary.retryCount, 0);
  // The messages the run resolved with, not the transcript it produced.
  assert.equal(summary.messageCount, 3);
  assert.deepEqual(summary.usage, {
    inputTokens: 40,
    outputTokens: 12,
    totalTokens: 52,
  });
});

test("summarizes a serialized artifact exactly as it summarizes the trace", () => {
  const trace = completedTrace({ suffix: "history-roundtrip" });
  const result = loadRunHistoryFiles([
    {
      fileName: "run_history-roundtrip.json",
      contents: serializeRunTrace(trace),
    },
  ]);

  assert.deepEqual(result.items[0]?.summary, summarizeRunTrace(trace));
});

test("loads newest traces first and skips invalid artifacts independently", () => {
  const older = completedTrace({
    suffix: "history-older",
    model: "older-model",
    startedAt: "2026-07-24T12:00:00.000Z",
  });
  const newer = completedTrace({
    suffix: "history-newer",
    model: "newer-model",
    startedAt: "2026-07-25T12:00:00.000Z",
  });
  const result = loadRunHistoryFiles([
    { fileName: "older.json", contents: serializeRunTrace(older) },
    { fileName: "broken.json", contents: "{not json" },
    { fileName: "newer.json", contents: serializeRunTrace(newer) },
  ]);

  assert.deepEqual(
    result.items.map(({ summary }) => summary.model),
    ["newer-model", "older-model"],
  );
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.fileName, "broken.json");
  assert.match(result.failures[0]?.message ?? "", /not valid JSON/);
});

test("a parseable but inconsistent artifact is reported, not thrown", () => {
  const trace = completedTrace({ suffix: "history-torn" });
  const tampered = JSON.parse(serializeRunTrace(trace)) as {
    events: unknown[];
  };
  // Punching a hole in the sequence is what a truncated write looks like.
  tampered.events.splice(2, 1);
  const healthy = completedTrace({ suffix: "history-healthy" });

  const result = loadRunHistoryFiles([
    { fileName: "torn.json", contents: JSON.stringify(tampered) },
    { fileName: "healthy.json", contents: serializeRunTrace(healthy) },
  ]);

  assert.deepEqual(
    result.items.map(({ fileName }) => fileName),
    ["healthy.json"],
  );
  assert.equal(result.failures[0]?.fileName, "torn.json");
  assert.match(result.failures[0]?.message ?? "", /sequence is not contiguous/);
});

test("orders runs that share a start instant by file name", () => {
  const startedAt = "2026-07-25T12:00:00.000Z";
  const files = ["run_b", "run_a", "run_c"].map((suffix) => ({
    fileName: `${suffix}.json`,
    contents: serializeRunTrace(completedTrace({ suffix, startedAt })),
  }));

  const forward = loadRunHistoryFiles(files);
  const reversed = loadRunHistoryFiles([...files].reverse());

  assert.deepEqual(
    forward.items.map(({ fileName }) => fileName),
    ["run_c.json", "run_b.json", "run_a.json"],
  );
  // The order the filesystem happened to enumerate must not reach the list.
  assert.deepEqual(reversed.items, forward.items);
});

test("a listed entry carries its summary and not the trace it came from", () => {
  const trace = completedTrace({ suffix: "history-compact" });
  const result = loadRunHistoryFiles([
    { fileName: "run_history-compact.json", contents: serializeRunTrace(trace) },
  ]);

  // Traces are re-read on demand: retaining them here would hold every event
  // and every raw SSE line the project has recorded to render a few lines.
  assert.deepEqual(Object.keys(result.items[0] ?? {}).sort(), [
    "fileName",
    "summary",
  ]);
});

test("an entry keeps the file name it was found under, not one derived from its run ID", () => {
  const trace = completedTrace({ suffix: "history-renamed" });
  const result = loadRunHistoryFiles([
    { fileName: "renamed-by-hand.json", contents: serializeRunTrace(trace) },
  ]);

  assert.equal(result.items[0]?.fileName, "renamed-by-hand.json");
  assert.equal(
    result.items[0]?.summary.runId,
    createEntityId("run", "history-renamed"),
  );
});
