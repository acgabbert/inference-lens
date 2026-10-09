import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderTurnStream, ProviderTurnTransport } from "../packages/contracts/src/inference.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import type { RepeatedExperimentPlanV3 } from "../packages/core/src/experiment.ts";
import type { ProviderTransportEvent } from "../packages/core/src/run-kernel/index.ts";
import { createMockOnlyToolExecutor } from "../packages/runner/src/mock-only-tool-executor.ts";
import type { SchedulerClock } from "../packages/runner/src/scheduler-clock.ts";
import { ExperimentController } from "../packages/runner/src/experiment-controller.ts";
import type { ExperimentProgress } from "../packages/runner/src/experiment-controller.ts";

const ENDPOINT = "https://provider.example.test/v1";

function plan(count: number): RepeatedExperimentPlanV3 {
  return {
    schemaVersion: 4,
    experimentId: "experiment_progress",
    kind: "repeated-request",
    createdAt: "2026-10-09T12:00:00.000Z",
    commonInput: {
      conversationId: "conversation_progress",
      conversationRevisionId: "revision_progress",
      target: {
        profileId: "profile_progress",
        protocol: "openai-compatible-chat-completions",
        endpoint: ENDPOINT,
        model: "progress-model",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      messages: [{
        id: "message_progress-user",
        role: "user",
        content: [{ type: "text", text: "Say hello" }],
      }],
      templateResolutions: [],
      responseMode: "streaming",
      options: {},
      tools: [],
      resolvedAt: "2026-10-09T12:00:00.000Z",
    },
    cells: Array.from({ length: count }, (_, index) => ({
      cellId: `experiment-cell_${index + 1}` as const,
      ordinal: index + 1,
      runId: `run_${index + 1}` as const,
    })),
  };
}

function completed(text: string): ProviderTransportEvent[] {
  return [
    { type: "text_delta", text },
    { type: "completed", finishReason: { normalized: "stop" } },
  ];
}

function rateLimited(headers: Record<string, string>): ProviderTransportEvent[] {
  return [
    { type: "request", request: { url: `${ENDPOINT}/chat/completions`, method: "POST", headers: {} } },
    { type: "response_started", response: { status: 429, headers } },
    {
      type: "failed",
      error: { code: "provider_error", message: "Too many requests", retryable: true, providerStatus: 429 },
    },
  ];
}

function transportFor(
  script: (runId: string) => AsyncIterable<ProviderTransportEvent>,
  started: string[] = [],
): ProviderTurnTransport {
  return {
    async discoverModels() { return { models: [] }; },
    async executeTurn({ execution }): Promise<ProviderTurnStream> {
      started.push(execution.runId);
      return { status: 200, headers: new Headers(), events: script(execution.runId) };
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function settle() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(condition: () => boolean, what: string) {
  for (let tick = 0; tick < 200; tick += 1) {
    if (condition()) return;
    await settle();
  }
  assert.fail(`Timed out waiting for ${what}.`);
}

function fakeClock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; resolve: () => void }> = [];
  const clock: SchedulerClock & { advance(ms: number): void } = {
    now: () => now,
    sleep(ms, signal) {
      return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        timers.push({ at: now + ms, resolve });
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    advance(ms) {
      now += ms;
      for (const timer of timers.filter(({ at }) => at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.resolve();
      }
    },
  };
  return clock;
}

const last = (emitted: ExperimentProgress[]) => emitted[emitted.length - 1]!;

test("progress reports every running ordinal, not one current ordinal", async () => {
  const releases = new Map([1, 2, 3].map((ordinal) => [`run_${ordinal}`, deferred()]));
  const started: string[] = [];
  const emitted: ExperimentProgress[] = [];
  const pending = new ExperimentController({
    plan: plan(3),
    concurrency: { maxInFlight: 2, connectionLimit: 2 },
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* (runId) {
      await releases.get(runId)!.promise;
      yield* completed(runId);
    }, started),
    async prepareCredential() { return { kind: "none" }; },
    onProgress: (progress) => emitted.push(progress),
  }).run();

  await until(() => started.length === 2, "two cells in flight");
  assert.deepEqual(last(emitted).runningOrdinals, [1, 2]);

  // A cell leaves the running set when its run is terminal, before its slot
  // frees, so the screen never shows a finished repetition as running.
  releases.get("run_1")!.resolve();
  await until(() => started.length === 3, "the third cell to start");
  assert.ok(emitted.some(({ runningOrdinals }) => runningOrdinals.join() === "2"));
  assert.deepEqual(last(emitted).runningOrdinals, [2, 3]);

  releases.get("run_3")!.resolve();
  await until(() => last(emitted).runningOrdinals.join() === "2", "cell 3 to finish");
  releases.get("run_2")!.resolve();
  const result = await pending;

  assert.equal(result.status, "completed");
  assert.equal(last(emitted).status, "completed");
  assert.deepEqual(last(emitted).runningOrdinals, []);
  assert.ok(!emitted.some((progress) => "currentOrdinal" in progress));
});

test("at the default limit the running set never holds more than one ordinal", async () => {
  const emitted: ExperimentProgress[] = [];
  await new ExperimentController({
    plan: plan(3),
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* (runId) {
      await settle();
      yield* completed(runId);
    }),
    async prepareCredential() { return { kind: "none" }; },
    onProgress: (progress) => emitted.push(progress),
  }).run();

  assert.ok(emitted.every(({ runningOrdinals }) => runningOrdinals.length <= 1));
  assert.deepEqual(
    [...new Set(emitted.flatMap(({ runningOrdinals }) => runningOrdinals))],
    [1, 2, 3],
  );
});

test("progress reports when a paused connection may start cells again, and when it resumes", async () => {
  const clock = fakeClock();
  const started: string[] = [];
  const emitted: ExperimentProgress[] = [];
  const pending = new ExperimentController({
    plan: plan(2),
    clock,
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* (runId) {
      if (runId === "run_1") {
        yield* rateLimited({ "retry-after": "2" });
        return;
      }
      yield* completed(runId);
    }, started),
    async prepareCredential() { return { kind: "none" }; },
    onProgress: (progress) => emitted.push(progress),
  }).run();

  await until(() => last(emitted)?.pausedConnections?.length === 1, "the pause to be reported");
  assert.deepEqual(last(emitted).pausedConnections, [
    { profileId: "profile_progress", endpoint: ENDPOINT, until: 1_000_000 + 2_000 },
  ]);
  assert.deepEqual(started, ["run_1"]);

  clock.advance(2_000);
  const result = await pending;

  assert.deepEqual(started, ["run_1", "run_2"]);
  assert.equal(result.status, "completed");
  // The resumption is reported before the next cell starts.
  const resumed = emitted.findIndex(
    (progress, index) => index > 0 && progress.pausedConnections.length === 0 &&
      emitted[index - 1]!.pausedConnections.length === 1,
  );
  assert.ok(resumed > 0, "a progress emission reports the pause ending");
  assert.deepEqual(emitted[resumed]!.runningOrdinals, []);
  assert.deepEqual(last(emitted).pausedConnections, []);
});

test("cancellation clears a reported pause", async () => {
  const clock = fakeClock();
  const emitted: ExperimentProgress[] = [];
  const controller = new ExperimentController({
    plan: plan(2),
    clock,
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* () {
      yield* rateLimited({ "retry-after": "30" });
    }),
    async prepareCredential() { return { kind: "none" }; },
    onProgress: (progress) => emitted.push(progress),
  });
  const pending = controller.run();
  await until(() => last(emitted)?.pausedConnections?.length === 1, "the pause to be reported");
  controller.cancel();
  const result = await pending;

  assert.equal(result.status, "cancelled");
  assert.deepEqual(last(emitted).pausedConnections, []);
  assert.deepEqual(last(emitted).runningOrdinals, []);
});
