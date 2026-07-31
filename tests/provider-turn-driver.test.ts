import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderTurnTransport, ProviderTurnStream } from "../packages/contracts/src/inference.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import { createEntityId, RunCoordinator } from "../packages/core/src/run-kernel/index.ts";
import type { ProviderTransportEvent, ResolvedRunInput } from "../packages/core/src/run-kernel/index.ts";
import { driveProviderTurn } from "../app/run/provider-turn-driver.client.ts";

const input: ResolvedRunInput = {
  runId: createEntityId("run", "driver"),
  conversationId: createEntityId("conversation", "driver"),
  conversationRevisionId: createEntityId("revision", "driver"),
  target: {
    profileId: createEntityId("profile", "driver"),
    protocol: "openai-compatible-chat-completions",
    endpoint: "https://provider.example.test/v1",
    model: "driver-model",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  messages: [{
    id: createEntityId("message", "driver-user"),
    role: "user",
    content: [{ type: "text", text: "Hello" }],
  }],
  templateResolutions: [],
  responseMode: "streaming",
  options: {},
  tools: [],
  resolvedAt: "2026-07-30T00:00:00.000Z",
};

async function* eventStream(events: readonly ProviderTransportEvent[]) {
  yield* events;
}

function scriptedTransport(events: readonly ProviderTransportEvent[]): ProviderTurnTransport {
  return {
    async discoverModels() { return { models: [] }; },
    async executeTurn(): Promise<ProviderTurnStream> {
      return {
        status: 200,
        headers: new Headers({ "x-test": "provider-turn-driver" }),
        events: eventStream(events),
      };
    },
  };
}

function driverOptions(coordinator: RunCoordinator, execution: ReturnType<RunCoordinator["start"]>["execution"], transport: ProviderTurnTransport, signal = new AbortController().signal) {
  return {
    coordinator,
    execution,
    transport,
    signal,
    async prepareCredential() { return { kind: "none" as const }; },
  };
}

test("forwards provider events, finishes the stream, and exposes diagnostic hooks", async () => {
  const coordinator = new RunCoordinator(input);
  const command = coordinator.start();
  const diagnosticEvents: string[] = [];
  const states: string[] = [];

  const outcome = await driveProviderTurn({
    ...driverOptions(coordinator, command.execution, scriptedTransport([
      { type: "text_delta", text: "Hello back" },
      { type: "completed", finishReason: { normalized: "stop" } },
    ])),
    onStateChange: (state) => states.push(state.status.kind),
    diagnostics: {
      onResponseReceived: ({ status, headers }) => diagnosticEvents.push(`response:${status}:${headers.get("x-test")}`),
      onTransportEvent: (event) => diagnosticEvents.push(event.type),
    },
  });

  assert.equal(outcome, "settled");
  assert.equal(coordinator.state.status.kind, "completed");
  assert.deepEqual(states, ["running", "running", "completed"]);
  assert.deepEqual(diagnosticEvents, [
    "response:200:provider-turn-driver",
    "text_delta",
    "completed",
  ]);
});

test("leaves retry policy with the caller while preserving failed-attempt evidence", async () => {
  const coordinator = new RunCoordinator(input);
  const first = coordinator.start();
  await driveProviderTurn({
    ...driverOptions(coordinator, first.execution, scriptedTransport([{
      type: "failed",
      error: { code: "provider_error", message: "Busy", retryable: true },
    }])),
  });

  assert.deepEqual(coordinator.state.status, {
    kind: "paused",
    reason: "attempt_failed",
    turnId: first.execution.turnId,
    attempt: 1,
    exchangeId: first.execution.exchangeId,
    error: { code: "provider_error", message: "Busy", retryable: true },
  });

  const retry = coordinator.retry();
  await driveProviderTurn({
    ...driverOptions(coordinator, retry.execution, scriptedTransport([
      { type: "text_delta", text: "Recovered" },
      { type: "completed", finishReason: { normalized: "stop" } },
    ])),
  });
  assert.equal(coordinator.state.status.kind, "completed");
  assert.equal(coordinator.state.turns[0]?.attempts.length, 2);
  assert.equal(coordinator.state.turns[0]?.attempts[0]?.text, "");
  assert.equal(coordinator.state.turns[0]?.attempts[1]?.text, "Recovered");
});

test("settles a tool turn without deciding how its result is supplied", async () => {
  const toolInput: ResolvedRunInput = {
    ...input,
    target: {
      ...input.target,
      capabilities: { ...input.target.capabilities, tools: true },
    },
    tools: [{
      id: createEntityId("tool", "weather"),
      name: "weather",
      inputSchema: { type: "object" },
    }],
  };
  const coordinator = new RunCoordinator(toolInput);
  const first = coordinator.start();
  const callId = createEntityId("tool-call", "weather");
  await driveProviderTurn({
    ...driverOptions(coordinator, first.execution, scriptedTransport([
      { type: "tool_call_delta", toolCallId: callId, index: 0, nameDelta: "weather", argumentsDelta: "{}" },
      { type: "completed", finishReason: { normalized: "tool_calls" } },
    ])),
  });
  assert.equal(coordinator.state.status.kind, "awaiting_tool_results");

  coordinator.supplyToolResults([{
    id: createEntityId("tool-result", "weather"),
    toolCallId: callId,
    content: [{ type: "text", text: "72°F" }],
    resolution: { kind: "manual" },
  }]);
  const continuation = coordinator.continue();
  await driveProviderTurn({
    ...driverOptions(coordinator, continuation.execution, scriptedTransport([
      { type: "text_delta", text: "It is 72°F." },
      { type: "completed", finishReason: { normalized: "stop" } },
    ])),
  });
  assert.equal(coordinator.state.status.kind, "completed");
  assert.equal(coordinator.state.turns.length, 2);
});

test("reports an aborted transport without changing coordinator terminal policy", async () => {
  const coordinator = new RunCoordinator(input);
  const command = coordinator.start();
  const controller = new AbortController();
  const transport: ProviderTurnTransport = {
    async discoverModels() { return { models: [] }; },
    async executeTurn(_request, signal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      throw new Error("unreachable");
    },
  };

  const pending = driveProviderTurn({
    ...driverOptions(coordinator, command.execution, transport, controller.signal),
  });
  await Promise.resolve();
  controller.abort();

  assert.equal(await pending, "aborted");
  assert.equal(coordinator.state.status.kind, "running");
});

test("does not let a superseded request mutate its coordinator", async () => {
  const coordinator = new RunCoordinator(input);
  const command = coordinator.start();
  const diagnostics: string[] = [];

  const outcome = await driveProviderTurn({
    ...driverOptions(coordinator, command.execution, scriptedTransport([
      { type: "text_delta", text: "Stale output" },
      { type: "completed", finishReason: { normalized: "stop" } },
    ])),
    isCurrent: () => false,
    diagnostics: { onTransportEvent: (event) => diagnostics.push(event.type) },
  });

  assert.equal(outcome, "superseded");
  assert.equal(coordinator.state.status.kind, "running");
  assert.deepEqual(diagnostics, ["text_delta", "completed"]);
});
