import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderTurnStream, ProviderTurnTransport } from "../packages/contracts/src/inference.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import type { RepeatedExperimentPlanV1 } from "../packages/core/src/experiment.ts";
import type { ProviderTransportEvent, RunTrace } from "../packages/core/src/run-kernel/index.ts";
import { RepeatedExperimentController } from "../app/run/repeated-experiment-controller.client.ts";

function plan(count: number): RepeatedExperimentPlanV1 {
  return {
    schemaVersion: 1,
    experimentId: "experiment_controller",
    kind: "repeated-request",
    createdAt: "2026-07-30T12:00:00.000Z",
    commonInput: {
      conversationId: "conversation_controller",
      conversationRevisionId: "revision_controller",
      target: {
        profileId: "profile_controller",
        protocol: "openai-compatible-chat-completions",
        endpoint: "https://provider.example.test/v1",
        model: "controller-model",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      messages: [{
        id: "message_controller-user",
        role: "user",
        content: [{ type: "text", text: "Say hello" }],
      }],
      templateResolutions: [],
      responseMode: "streaming",
      options: {},
      tools: [],
      resolvedAt: "2026-07-30T12:00:00.000Z",
    },
    cells: Array.from({ length: count }, (_, index) => ({
      cellId: `experiment-cell_${index + 1}` as const,
      ordinal: index + 1,
      runId: `run_${index + 1}` as const,
    })),
  };
}

async function* events(records: readonly ProviderTransportEvent[]) {
  yield* records;
}

function completed(text: string): ProviderTransportEvent[] {
  return [
    { type: "text_delta", text },
    { type: "completed", finishReason: { normalized: "stop" } },
  ];
}

function transportFor(
  script: (runId: string, signal: AbortSignal | undefined) => AsyncIterable<ProviderTransportEvent>,
  started: string[] = [],
): ProviderTurnTransport {
  return {
    async discoverModels() { return { models: [] }; },
    async executeTurn({ execution }, signal): Promise<ProviderTurnStream> {
      started.push(execution.runId);
      return { status: 200, headers: new Headers(), events: script(execution.runId, signal) };
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}

test("runs two, five, and high-count schedules strictly one cell at a time", async () => {
  for (const count of [2, 5, 23]) {
    const started: string[] = [];
    const traces: RunTrace[] = [];
    let active = 0;
    let peak = 0;
    const transport = transportFor(async function* (runId) {
      active += 1;
      peak = Math.max(peak, active);
      yield* completed(`response ${runId}`);
      active -= 1;
    }, started);
    const controller = new RepeatedExperimentController({
      plan: plan(count),
      transport,
      async prepareCredential() { return { kind: "none" }; },
      onTerminalTrace(trace) { traces.push(trace); },
    });

    const result = await controller.run();
    assert.equal(result.status, "completed");
    assert.deepEqual(started, Array.from({ length: count }, (_, index) => `run_${index + 1}`));
    assert.equal(peak, 1);
    assert.deepEqual(result.cells.map(({ status }) => status), Array(count).fill("completed"));
    assert.deepEqual(traces.map((trace) => trace.runId), started);
    assert.ok(traces.every((trace) => trace.input.runId === trace.runId));
  }
});

test("finalizes a retryable failure and continues later cells", async () => {
  const started: string[] = [];
  const traces: RunTrace[] = [];
  const transport = transportFor((runId) => events(runId === "run_2"
    ? [{ type: "failed", error: { code: "provider_error", message: "Busy", retryable: true } }]
    : completed(runId)), started);
  const result = await new RepeatedExperimentController({
    plan: plan(3),
    transport,
    async prepareCredential() { return { kind: "none" }; },
    onTerminalTrace(trace) { traces.push(trace); },
  }).run();

  assert.deepEqual(started, ["run_1", "run_2", "run_3"]);
  assert.deepEqual(result.cells.map(({ status }) => status), ["completed", "failed", "completed"]);
  assert.equal(traces[1]?.status.kind, "failed");
  assert.equal(traces[1]?.status.error.message, "Busy");
  assert.equal(traces[1]?.turns[0]?.attempts.length, 1);
});

test("continues after credential failures before and after an earlier terminal cell", async () => {
  let credentialAttempt = 0;
  const started: string[] = [];
  const traces: RunTrace[] = [];
  const result = await new RepeatedExperimentController({
    plan: plan(3),
    transport: transportFor((runId) => events(completed(runId)), started),
    async prepareCredential() {
      credentialAttempt += 1;
      if (credentialAttempt === 1 || credentialAttempt === 3) throw new Error("Credential unavailable");
      return { kind: "none" };
    },
    onTerminalTrace(trace) { traces.push(trace); },
  }).run();

  assert.deepEqual(started, ["run_2"]);
  assert.deepEqual(result.cells.map(({ status }) => status), ["failed", "completed", "failed"]);
  assert.deepEqual(traces.map((trace) => trace.status.kind), ["failed", "completed", "failed"]);
});

test("cancels a streamed cell, preserves its ordinary trace, and marks later cells not run", async () => {
  const firstRecord = deferred();
  const started: string[] = [];
  const traces: RunTrace[] = [];
  const transport = transportFor(async function* (runId, signal) {
    assert.equal(runId, "run_1");
    firstRecord.resolve();
    yield { type: "text_delta", text: "partial" };
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }, started);
  const controller = new RepeatedExperimentController({
    plan: plan(3),
    transport,
    async prepareCredential() { return { kind: "none" }; },
    onTerminalTrace(trace) { traces.push(trace); },
  });

  const pending = controller.run();
  await firstRecord.promise;
  controller.cancel();
  const result = await pending;

  assert.deepEqual(started, ["run_1"]);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.cells.map(({ status }) => status), ["cancelled", "not-run", "not-run"]);
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.status.kind, "cancelled");
  assert.equal(traces[0]?.turns[0]?.attempts[0]?.text, "partial");
});

test("cancellation between cells does not start the next provider request", async () => {
  const traceStarted = deferred();
  const releaseTrace = deferred();
  const started: string[] = [];
  const controller = new RepeatedExperimentController({
    plan: plan(2),
    transport: transportFor((runId) => events(completed(runId)), started),
    async prepareCredential() { return { kind: "none" }; },
    async onTerminalTrace() {
      traceStarted.resolve();
      await releaseTrace.promise;
    },
  });

  const pending = controller.run();
  await traceStarted.promise;
  controller.cancel();
  releaseTrace.resolve();
  const result = await pending;

  assert.deepEqual(started, ["run_1"]);
  assert.deepEqual(result.cells.map(({ status }) => status), ["completed", "not-run"]);
});

test("does not call a provider before a durable plan save succeeds and saves the result after traces", async () => {
  let providerCalls = 0;
  const rejected = new RepeatedExperimentController({
    plan: plan(2),
    transport: transportFor(() => {
      providerCalls += 1;
      return events(completed("unexpected"));
    }),
    async prepareCredential() { return { kind: "none" }; },
    async savePlan() { throw new Error("Disk full"); },
  });
  await assert.rejects(() => rejected.run(), /Disk full/);
  assert.equal(providerCalls, 0);

  const order: string[] = [];
  const savedTraces: RunTrace[] = [];
  const result = await new RepeatedExperimentController({
    plan: plan(2),
    transport: transportFor((runId) => {
      order.push(`provider:${runId}`);
      return events(completed(runId));
    }),
    async prepareCredential() { return { kind: "none" }; },
    async savePlan() { order.push("plan"); },
    async onTerminalTrace(trace, cell) {
      order.push(`trace:${cell.runId}`);
      savedTraces.push(trace);
    },
    async saveResult(saved) {
      order.push("result");
      assert.deepEqual(saved.cells.map((cell) => cell.runId), savedTraces.map((trace) => trace.runId));
    },
  }).run();

  assert.equal(result.status, "completed");
  assert.deepEqual(order, [
    "plan", "provider:run_1", "trace:run_1",
    "provider:run_2", "trace:run_2", "result",
  ]);
});
