import assert from "node:assert/strict";
import test from "node:test";

import { preserveRunFailure } from "../app/run-failure.client.ts";
import type { InferenceRequest } from "../packages/core/src/types.ts";
import {
  createSingleTurnRunExecution,
  createRunEventFactory,
  createRunState,
  reduceRunEvent,
} from "../packages/core/src/run-kernel/index.ts";

const request: InferenceRequest = {
  provider: "openai-compatible",
  endpoint: "https://api.example.test/v1",
  model: "example-model",
  messages: [{ role: "user", content: "Hello" }],
};

const identity = {
  conversationId: "conversation_failure" as const,
  conversationRevisionId: "revision_failure" as const,
};

test("preserves accumulated output when recording a client failure", () => {
  const execution = createSingleTurnRunExecution(request, identity);
  const factory = createRunEventFactory(execution.runId);
  let state = createRunState(execution.runId);
  for (const event of [
    factory.create({ type: "run.started", input: execution.input }),
    factory.create({
      type: "turn.started",
      turnId: execution.turnId,
      attempt: execution.attempt,
      exchangeId: execution.exchangeId,
      input: execution.turnInput,
    }),
    factory.create({
      type: "assistant.text_delta",
      turnId: execution.turnId,
      attempt: execution.attempt,
      exchangeId: execution.exchangeId,
      text: "Streamed output",
    }),
  ]) {
    state = reduceRunEvent(state, event);
  }

  const failed = preserveRunFailure(
    state,
    request,
    identity,
    "Projection failed.",
    "2026-07-24T13:19:42.678Z",
  );

  assert.equal(failed.runId, state.runId);
  assert.equal(failed.turns[0]?.attempts[0]?.text, "Streamed output");
  assert.equal(failed.status.kind, "failed");
  assert.equal(failed.events.at(-1)?.type, "run.failed");
  assert.equal(failed.events.length, state.events.length + 1);
});

test("keeps an already-terminal run authoritative", () => {
  const execution = createSingleTurnRunExecution(request, identity);
  const factory = createRunEventFactory(execution.runId);
  let state = createRunState(execution.runId);
  for (const event of [
    factory.create({ type: "run.started", input: execution.input }),
    factory.create({
      type: "turn.started",
      turnId: execution.turnId,
      attempt: execution.attempt,
      exchangeId: execution.exchangeId,
      input: execution.turnInput,
    }),
    factory.create({
      type: "assistant.completed",
      turnId: execution.turnId,
      attempt: execution.attempt,
      exchangeId: execution.exchangeId,
      finishReason: { normalized: "stop" },
    }),
    factory.create({ type: "run.completed" }),
  ]) {
    state = reduceRunEvent(state, event);
  }

  assert.equal(
    preserveRunFailure(state, request, identity, "Late transport error."),
    state,
  );
});
