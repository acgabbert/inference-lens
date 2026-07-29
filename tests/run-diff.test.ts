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
import {
  diffAttempts,
  diffCandidates,
} from "../packages/core/src/run-diff.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, keyof RunEventMetadata>
    : never
  : never;

function buildRetryState(): RunState {
  const runId = createEntityId("run", "diff");
  const turnId = createEntityId("turn", "diff");
  const firstExchange = createEntityId("exchange", "diff-first");
  const secondExchange = createEntityId("exchange", "diff-second");
  const turnInput: ProviderTurnInput = {
    target: {
      profileId: createEntityId("profile", "diff"),
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://api.example.com/v1",
      model: "diff-model",
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
    messages: [
      {
        id: createEntityId("message", "diff"),
        role: "user",
        content: [{ type: "text", text: "Compare me" }],
      },
    ],
    responseMode: "streaming",
    options: {},
    tools: [],
  };
  const input: ResolvedRunInput = {
    ...turnInput,
    runId,
    conversationId: createEntityId("conversation", "diff"),
    conversationRevisionId: createEntityId("revision", "diff"),
    templateResolutions: [],
    resolvedAt: "2026-07-29T12:00:00.000Z",
  };
  let sequence = 0;
  const event = (elapsedMs: number, payload: RunEventPayload): RunEvent => ({
    eventId: createEntityId("event", `diff-${sequence}`),
    runId,
    sequence: sequence++,
    occurredAt: new Date(Date.parse(input.resolvedAt) + elapsedMs).toISOString(),
    elapsedMs,
    ...payload,
  }) as RunEvent;
  const request = (body: string) => ({
    url: "https://api.example.com/v1/chat/completions",
    method: "POST",
    headers: {},
    body,
  });
  return [
    event(0, { type: "run.started", input }),
    event(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId: firstExchange,
      input: turnInput,
    }),
    event(10, {
      type: "exchange.requested",
      turnId,
      attempt: 1,
      exchangeId: firstExchange,
      request: request('{"b":2,"a":1}'),
    }),
    event(20, {
      type: "assistant.text_delta",
      turnId,
      attempt: 1,
      exchangeId: firstExchange,
      text: "partial",
    }),
    event(30, {
      type: "turn.attempt_failed",
      turnId,
      attempt: 1,
      exchangeId: firstExchange,
      error: {
        code: "provider_error",
        message: "try again",
        retryable: true,
        providerStatus: 503,
      },
    }),
    event(40, {
      type: "turn.attempt_started",
      turnId,
      attempt: 2,
      exchangeId: secondExchange,
    }),
    event(50, {
      type: "exchange.requested",
      turnId,
      attempt: 2,
      exchangeId: secondExchange,
      request: request('{"a":1,"b":2}'),
    }),
    event(60, {
      type: "assistant.text_delta",
      turnId,
      attempt: 2,
      exchangeId: secondExchange,
      text: "complete",
    }),
    event(70, {
      type: "usage.reported",
      turnId,
      attempt: 2,
      exchangeId: secondExchange,
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    }),
    event(70, {
      type: "assistant.completed",
      turnId,
      attempt: 2,
      exchangeId: secondExchange,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    event(80, { type: "run.completed" }),
  ].reduce(reduceRunEvent, createRunState(runId));
}

test("projects retry candidates and canonical request comparison", () => {
  const state = buildRetryState();
  const candidates = diffCandidates(state, "This run");
  assert.deepEqual(
    candidates.map(({ turnIndex, attempt, status }) => [
      turnIndex,
      attempt,
      status,
    ]),
    [
      [1, 1, "failed"],
      [1, 2, "completed"],
    ],
  );

  const diff = diffAttempts(
    { state, candidate: candidates[0]! },
    { state, candidate: candidates[1]! },
  );
  assert.equal(diff.sameRun, true);
  assert.equal(diff.sameTurn, true);
  const request = diff.sections.find(({ id }) => id === "request");
  assert.equal(request?.status, "identical");
  assert.equal(request?.normalized, true);
  assert.equal(request?.diff?.addedCount, 0);
  assert.equal(
    diff.sections.find(({ id }) => id === "output")?.status,
    "changed",
  );
  assert.equal(
    diff.scalars.find(({ id }) => id === "finishReason")?.changed,
    true,
  );
  assert.equal(
    diff.scalars.find(({ id }) => id === "error")?.left?.kind,
    "text",
  );
  assert.equal(
    diff.scalars.find(({ id }) => id === "error")?.right,
    undefined,
  );
});

test("reports missing evidence as absent instead of an empty identical diff", () => {
  const state = buildRetryState();
  const candidates = diffCandidates(state, "This run");
  const diff = diffAttempts(
    { state, candidate: candidates[0]! },
    { state, candidate: candidates[1]! },
  );
  assert.equal(
    diff.sections.find(({ id }) => id === "reasoning")?.status,
    "absent",
  );
  assert.equal(
    diff.sections.find(({ id }) => id === "toolCalls")?.diff,
    undefined,
  );
});

test("treats a captured empty request body as evidence, not absence", () => {
  const state = buildRetryState();
  const candidates = diffCandidates(state, "This run");
  state.exchanges[candidates[0]!.exchangeId]!.request!.body = "";
  state.exchanges[candidates[1]!.exchangeId]!.request!.body = "";
  const diff = diffAttempts(
    { state, candidate: candidates[0]! },
    { state, candidate: candidates[1]! },
  );
  const request = diff.sections.find(({ id }) => id === "request");
  assert.equal(request?.status, "identical");
  assert.equal(request?.normalized, false);
});
