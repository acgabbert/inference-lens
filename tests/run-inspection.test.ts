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
  RunState,
} from "../packages/core/src/run-kernel/index.ts";
import { runInspectionSummary } from "../packages/core/src/run-inspection.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, keyof RunEventMetadata>
    : never
  : never;

const runId = createEntityId("run", "inspection");
const turnId = createEntityId("turn", "inspection");
const exchangeId = createEntityId("exchange", "inspection");
const turnInput: ProviderTurnInput = {
  target: {
    profileId: createEntityId("profile", "fixture"),
    protocol: "openai-compatible-chat-completions",
    endpoint: "https://fixture.example/v1",
    model: "fixture-model",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  messages: [
    {
      id: createEntityId("message", "fixture"),
      role: "user",
      content: [{ type: "text", text: "Fixture request" }],
    },
  ],
  responseMode: "streaming",
  options: {},
  tools: [],
};
const input: ResolvedRunInput = {
  ...turnInput,
  runId,
  conversationId: createEntityId("conversation", "inspection"),
  conversationRevisionId: createEntityId("revision", "inspection"),
  templateResolutions: [],
  resolvedAt: "2026-07-30T12:00:00.000Z",
};

function events() {
  let sequence = 0;
  return (elapsedMs: number, payload: RunEventPayload): RunEvent =>
    ({
      eventId: createEntityId("event", `inspection-${sequence}`),
      runId,
      sequence: sequence++,
      occurredAt: new Date(
        Date.parse("2026-07-30T12:00:00.000Z") + elapsedMs,
      ).toISOString(),
      elapsedMs,
      ...payload,
    }) as RunEvent;
}

function reduceAll(runEvents: RunEvent[]): RunState {
  return runEvents.reduce(reduceRunEvent, createRunState(runId));
}

function baseEvents(next: ReturnType<typeof events>): RunEvent[] {
  return [
    next(0, { type: "run.started", input }),
    next(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    next(100, {
      type: "exchange.requested",
      turnId,
      attempt: 1,
      exchangeId,
      request: {
        url: "https://fixture.example/v1/chat/completions",
        method: "POST",
        headers: {},
        body: "{}",
      },
    }),
    next(600, {
      type: "assistant.text_delta",
      turnId,
      attempt: 1,
      exchangeId,
      text: "Fixture output",
    }),
  ];
}

test("returns no compact summary before a run starts", () => {
  assert.equal(runInspectionSummary(null), null);
  assert.equal(runInspectionSummary(createRunState(runId)), null);
});

test("distinguishes tool continuation from a retryable pause", () => {
  const initial = createRunState(runId);
  assert.equal(
    runInspectionSummary({
      ...initial,
      status: { kind: "paused", reason: "tool_results_ready" },
    })?.status,
    "ready_to_continue",
  );
  assert.equal(
    runInspectionSummary({
      ...initial,
      status: {
        kind: "paused",
        reason: "attempt_failed",
        turnId,
        attempt: 1,
        exchangeId,
        error: { code: "provider_error", message: "Try again." },
      },
    })?.status,
    "retry_available",
  );
});

test("projects the predictable active-run summary without placeholders", () => {
  const next = events();
  const summary = runInspectionSummary(reduceAll(baseEvents(next)));

  assert.deepEqual(summary, {
    phase: "active",
    status: "running",
    totalDurationMs: 600,
    ttfoMs: 500,
    totalTokens: undefined,
    outputTokensPerSecond: undefined,
  });
});

test("projects duration, first output, tokens, and rate for a terminal run", () => {
  const next = events();
  const state = reduceAll([
    ...baseEvents(next),
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

  assert.deepEqual(runInspectionSummary(state), {
    phase: "terminal",
    status: "completed",
    totalDurationMs: 1650,
    ttfoMs: 500,
    totalTokens: 30,
    outputTokensPerSecond: 20,
  });
});
