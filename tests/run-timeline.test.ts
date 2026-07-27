import assert from "node:assert/strict";
import test from "node:test";

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
  RunId,
  RunState,
} from "../packages/core/src/run-kernel/index.ts";
import {
  parseRunTraceJson,
  runStateFromTrace,
  serializeRunTrace,
} from "../packages/core/src/run-trace.ts";
import { runMetrics } from "../packages/core/src/run-metrics.ts";
import { runTimeline } from "../packages/core/src/run-timeline.ts";
import type {
  RunTimeline,
  TimelineAttemptRow,
  TimelineGapRow,
} from "../packages/core/src/run-timeline.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, keyof RunEventMetadata>
    : never
  : never;

const runId = createEntityId("run", "timeline");
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
  options: {},
  tools: [],
};

const resolvedInput: ResolvedRunInput = {
  runId,
  conversationId: createEntityId("conversation", "timeline"),
  conversationRevisionId: createEntityId("revision", "timeline"),
  ...turnInput,
  templateResolutions: [],
  resolvedAt: "2026-07-25T12:00:00.000Z",
};

/** Explicit elapsed stamps keep every geometry assertion exact and timer-free. */
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

function timelineOf(events: RunEvent[]): RunTimeline {
  return runTimeline(runMetrics(reduceAll(events)));
}

function attemptRows(timeline: RunTimeline): TimelineAttemptRow[] {
  return timeline.rows.filter(
    (row): row is TimelineAttemptRow => row.kind === "attempt",
  );
}

function gapRows(timeline: RunTimeline): TimelineGapRow[] {
  return timeline.rows.filter(
    (row): row is TimelineGapRow => row.kind === "gap",
  );
}

/** Phase and duration of each segment, the shape the bars are drawn from. */
function phases(row: TimelineAttemptRow): [string, number][] {
  return row.segments.map(({ phase, durationMs }) => [phase, durationMs]);
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

test("slices a completed attempt into consecutive phases", () => {
  const next = eventStream(runId);
  const timeline = timelineOf([
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
    next(600, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Hi" }),
    next(1600, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(1650, { type: "run.completed" }),
  ]);

  const [row] = attemptRows(timeline);

  assert.equal(timeline.axisEndMs, 1650);
  assert.equal(row?.startMs, 100);
  assert.equal(row?.endMs, 1600);
  assert.equal(row?.durationMs, 1500);
  assert.equal(row?.openEnded, false);
  assert.deepEqual(phases(row!), [
    ["wait", 300],
    ["prelude", 200],
    ["generation", 1000],
  ]);
});

test("shows a reasoning phase before the first answer token", () => {
  const next = eventStream(runId);
  const timeline = timelineOf([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(200, {
      type: "exchange.response_started",
      turnId,
      attempt: 1,
      exchangeId,
      response,
    }),
    next(300, {
      type: "assistant.reasoning_delta",
      turnId,
      attempt: 1,
      exchangeId,
      reasoning: "Thinking",
    }),
    next(900, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Hi" }),
    next(1000, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(1000, { type: "run.completed" }),
  ]);

  assert.deepEqual(phases(attemptRows(timeline)[0]!), [
    ["wait", 100],
    ["prelude", 100],
    ["reasoning", 600],
    ["generation", 100],
  ]);
});

test("surfaces the pause between turns as a tool-result gap", () => {
  const next = eventStream(runId);
  const toolCallId = createEntityId("tool-call", "lookup");
  const timeline = timelineOf([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(200, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Calling" }),
    next(300, {
      type: "assistant.tool_call_delta",
      turnId,
      attempt: 1,
      exchangeId,
      toolCallId,
      index: 0,
      nameDelta: "lookup",
      argumentsDelta: "{}",
    }),
    next(500, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "tool_calls", raw: "tool_calls" },
    }),
    // The user takes 40 s to supply a tool result. No attempt accounts for it.
    next(40_500, {
      type: "tool.result_supplied",
      turnId,
      result: {
        id: createEntityId("tool-result", "lookup"),
        toolCallId,
        content: [{ type: "text", text: "42" }],
        resolution: { kind: "manual" },
      },
    }),
    next(40_600, {
      type: "turn.started",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      input: turnInput,
    }),
    next(40_700, {
      type: "exchange.requested",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      request,
    }),
    next(40_800, {
      type: "assistant.text_delta",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      text: "Done",
    }),
    next(41_000, {
      type: "assistant.completed",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(41_000, { type: "run.completed" }),
  ]);

  const [gap] = gapRows(timeline);
  const [toolAttempt] = attemptRows(timeline);

  assert.equal(gapRows(timeline).length, 1);
  assert.equal(gap?.reason, "tool_results");
  assert.equal(gap?.turnId, secondTurnId);
  assert.equal(gap?.startMs, 500);
  assert.equal(gap?.endMs, 40_700);
  assert.equal(gap?.durationMs, 40_200);
  // The gap is ordered between the two attempts it separates.
  assert.deepEqual(
    timeline.rows.map((row) => row.kind),
    ["attempt", "gap", "attempt"],
  );
  assert.deepEqual(phases(toolAttempt!), [
    ["wait", 100],
    ["generation", 100],
    ["tooling", 200],
  ]);
});

test("shows tool-only output as tool calling rather than stream prelude", () => {
  const next = eventStream(runId);
  const toolCallId = createEntityId("tool-call", "lookup-only");
  const timeline = timelineOf([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(200, {
      type: "exchange.response_started",
      turnId,
      attempt: 1,
      exchangeId,
      response,
    }),
    next(300, {
      type: "assistant.tool_call_delta",
      turnId,
      attempt: 1,
      exchangeId,
      toolCallId,
      index: 0,
      nameDelta: "lookup",
    }),
    next(700, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "tool_calls", raw: "tool_calls" },
    }),
  ]);

  assert.deepEqual(phases(attemptRows(timeline)[0]!), [
    ["wait", 100],
    ["prelude", 100],
    ["tooling", 400],
  ]);
});

test("terminal failure closes the active timeline row", () => {
  const next = eventStream(runId);
  const timeline = timelineOf([
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

  const [row] = attemptRows(timeline);

  assert.equal(row?.status, "failed");
  assert.equal(row?.openEnded, false);
  assert.equal(row?.endMs, 300);
  assert.equal(row?.durationMs, 200);
});

test("separates a failed attempt from its retry with a retry gap", () => {
  const next = eventStream(runId);
  const timeline = timelineOf([
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
      type: "assistant.completed",
      turnId,
      attempt: 2,
      exchangeId: secondExchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(2150, { type: "run.completed" }),
  ]);

  const [failed, recovered] = attemptRows(timeline);
  const [gap] = gapRows(timeline);

  assert.equal(gap?.reason, "retry");
  assert.equal(gap?.durationMs, 800);
  assert.equal(failed?.status, "failed");
  // The failed attempt never produced a token, so it has no generation phase.
  assert.deepEqual(phases(failed!), [["wait", 200]]);
  assert.deepEqual(phases(recovered!), [
    ["wait", 100],
    ["generation", 900],
  ]);
});

test("draws a streaming attempt to the axis end without claiming a duration", () => {
  const next = eventStream(runId);
  const timeline = timelineOf([
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

  const [row] = attemptRows(timeline);

  assert.equal(row?.openEnded, true);
  assert.equal(row?.endMs, 400);
  // Geometry reaches the axis end; the reported duration stays absent.
  assert.equal(row?.durationMs, undefined);
  // Generation began at the axis end, so it has no length to draw yet.
  assert.deepEqual(phases(row!), [["wait", 300]]);
});

test("draws nothing for an attempt that produced no stamps", () => {
  const next = eventStream(runId);
  const timeline = timelineOf([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
  ]);

  const [row] = attemptRows(timeline);

  assert.deepEqual(row?.segments, []);
  assert.equal(row?.durationMs, undefined);
  assert.equal(timeline.axisEndMs, 0);
});

test("keeps every segment inside the axis and ordered without overlap", () => {
  const next = eventStream(runId);
  const timeline = timelineOf([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(150, {
      type: "exchange.response_started",
      turnId,
      attempt: 1,
      exchangeId,
      response,
    }),
    next(150, {
      type: "assistant.reasoning_delta",
      turnId,
      attempt: 1,
      exchangeId,
      reasoning: "Thinking",
    }),
    next(150, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Hi" }),
    next(900, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(950, { type: "run.completed" }),
  ]);

  for (const row of timeline.rows) {
    if (row.kind === "gap") continue;
    let previousEnd = 0;
    for (const segment of row.segments) {
      assert.ok(segment.durationMs > 0, "zero-length segments are not emitted");
      assert.ok(segment.startMs >= previousEnd, "segments must not overlap");
      assert.ok(segment.endMs <= timeline.axisEndMs, "segments stay on the axis");
      previousEnd = segment.endMs;
    }
  }

  // Landmarks sharing a millisecond collapse instead of inverting the order.
  assert.deepEqual(phases(attemptRows(timeline)[0]!), [
    ["wait", 50],
    ["generation", 750],
  ]);
});

test("produces an identical timeline for a run and its imported trace", () => {
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

  assert.deepEqual(
    runTimeline(runMetrics(imported)),
    runTimeline(runMetrics(state)),
  );
});
