import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderTurnStream, ProviderTurnTransport } from "../packages/contracts/src/inference.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import { isRateLimitedRun, rateLimitRetries, rateLimitRetryCount } from "../packages/core/src/experiment.ts";
import type { RepeatedExperimentPlanV3 } from "../packages/core/src/experiment.ts";
import type { ProviderTransportEvent, RunTrace, ToolCallId } from "../packages/core/src/run-kernel/index.ts";
import type { ToolBinding, ToolExecutor } from "../packages/core/src/tool-execution.ts";
import { createMockOnlyToolExecutor } from "../packages/runner/src/mock-only-tool-executor.ts";
import {
  DEFAULT_RATE_LIMIT_PAUSE_MS,
  MAX_RATE_LIMIT_PAUSE_MS,
  rateLimitPauseMs,
} from "../packages/runner/src/rate-limit-pause.ts";
import type { SchedulerClock } from "../packages/runner/src/scheduler-clock.ts";
import { ExperimentController } from "../packages/runner/src/experiment-controller.ts";
import type { ExperimentProgress } from "../packages/runner/src/experiment-controller.ts";

function plan(count: number): RepeatedExperimentPlanV3 {
  return {
    schemaVersion: 4,
    experimentId: "experiment_concurrent",
    kind: "repeated-request",
    createdAt: "2026-10-09T12:00:00.000Z",
    commonInput: {
      conversationId: "conversation_concurrent",
      conversationRevisionId: "revision_concurrent",
      target: {
        profileId: "profile_concurrent",
        protocol: "openai-compatible-chat-completions",
        endpoint: "https://provider.example.test/v1",
        model: "concurrent-model",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      messages: [{
        id: "message_concurrent-user",
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

/** A provider 429 as both transports deliver it: the response, then the failure. */
function rateLimited(headers: Record<string, string>): ProviderTransportEvent[] {
  return [
    { type: "request", request: { url: "https://provider.example.test/v1/chat/completions", method: "POST", headers: {} } },
    { type: "response_started", response: { status: 429, headers } },
    {
      type: "failed",
      error: { code: "provider_error", message: "Too many requests", retryable: true, providerStatus: 429 },
    },
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

/** Lets every pending callback and microtask run. */
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

function abortion(signal: AbortSignal | undefined) {
  return new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Time moves only when a test says so. */
function fakeClock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; resolve: () => void }> = [];
  const sleeps: number[] = [];
  const clock: SchedulerClock & { sleeps: number[]; advance(ms: number): void } = {
    sleeps,
    now: () => now,
    sleep(ms, signal) {
      sleeps.push(ms);
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

test("places cells in plan order when they finish in reverse", async () => {
  const started: string[] = [];
  const finished: string[] = [];
  const releases = new Map(["run_1", "run_2", "run_3"].map((runId) => [runId, deferred()]));
  const controller = new ExperimentController({
    plan: plan(3),
    concurrency: { maxInFlight: 3, connectionLimit: 3 },
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* (runId) {
      await releases.get(runId)!.promise;
      yield* completed(runId);
    }, started),
    async prepareCredential() { return { kind: "none" }; },
    onTerminalTrace(trace) { finished.push(trace.runId); },
  });

  const pending = controller.run();
  await until(() => started.length === 3, "three cells in flight");
  for (const runId of ["run_3", "run_2", "run_1"]) {
    releases.get(runId)!.resolve();
    await until(() => finished.includes(runId), `${runId} to finish`);
  }
  const result = await pending;

  assert.deepEqual(finished, ["run_3", "run_2", "run_1"]);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.cells.map(({ cellId }) => cellId), [
    "experiment-cell_1", "experiment-cell_2", "experiment-cell_3",
  ]);
  assert.deepEqual(result.cells.map((cell) => cell.status === "not-run" ? undefined : cell.startOrder), [1, 2, 3]);
  // The result records the limits it actually ran under.
  assert.equal(result.concurrency.maxInFlight, 3);
  assert.deepEqual(result.concurrency.connections.map(({ limit }) => limit), [3]);
});

test("never exceeds a connection's limit, and reaches it", async () => {
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  const result = await new ExperimentController({
    plan: plan(7),
    concurrency: { maxInFlight: 5, connectionLimit: 2 },
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* (runId) {
      active += 1;
      peak = Math.max(peak, active);
      await settle();
      await settle();
      active -= 1;
      yield* completed(runId);
    }, started),
    async prepareCredential() { return { kind: "none" }; },
  }).run();

  assert.equal(result.status, "completed");
  assert.equal(peak, 2);
  // Cells on one connection start in plan order as slots free up.
  assert.deepEqual(started, Array.from({ length: 7 }, (_, index) => `run_${index + 1}`));
  assert.equal(result.concurrency.maxInFlight, 5);
  assert.deepEqual(result.concurrency.connections.map(({ limit }) => limit), [2]);
});

test("with no setting, cells run one at a time exactly as before", async () => {
  let active = 0;
  let peak = 0;
  const result = await new ExperimentController({
    plan: plan(4),
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* (runId) {
      active += 1;
      peak = Math.max(peak, active);
      await settle();
      active -= 1;
      yield* completed(runId);
    }),
    async prepareCredential() { return { kind: "none" }; },
  }).run();

  assert.equal(peak, 1);
  assert.equal(result.concurrency.maxInFlight, 1);
  assert.deepEqual(result.concurrency.connections.map(({ limit }) => limit), [1]);
});

const weatherTool = {
  id: "tool_weather" as const,
  name: "get_weather",
  description: "Looks up weather.",
  inputSchema: { type: "object", properties: {} },
};

const forecastTool = {
  id: "tool_forecast" as const,
  name: "get_forecast",
  description: "Looks up a forecast.",
  inputSchema: { type: "object", properties: {} },
};

function toolPlan(count: number): RepeatedExperimentPlanV3 {
  const frozen = plan(count);
  frozen.commonInput.tools = [weatherTool, forecastTool];
  frozen.commonInput.target.capabilities = {
    ...frozen.commonInput.target.capabilities,
    tools: true,
  };
  return frozen;
}

/**
 * Odd runs call the weather tool and even runs the forecast tool, once each,
 * then answer. Counted per repetition, so each cell really continues.
 */
function toolCalling() {
  const turns = new Map<string, number>();
  return (runId: string): AsyncIterable<ProviderTransportEvent> => {
    const turn = (turns.get(runId) ?? 0) + 1;
    turns.set(runId, turn);
    const tool = Number(runId.slice("run_".length)) % 2 === 1 ? weatherTool : forecastTool;
    return (async function* () {
      if (turn > 1) {
        yield* completed("done");
        return;
      }
      yield {
        type: "tool_call_delta",
        toolCallId: `tool-call_${runId}-${turn}` as ToolCallId,
        index: 0,
        nameDelta: tool.name,
        argumentsDelta: "{}",
      };
      yield { type: "completed", finishReason: { normalized: "tool_calls" } };
    })();
  };
}

/** Runs four tool-calling cells at once and reports how many calls overlapped. */
async function peakToolOverlap(bindings: ToolBinding[]): Promise<number> {
  let active = 0;
  let peak = 0;
  const result = await new ExperimentController({
    plan: toolPlan(4),
    concurrency: { maxInFlight: 4, connectionLimit: 4 },
    transport: transportFor(toolCalling()),
    toolBindings: bindings,
    createExecutor: (binding): ToolExecutor => ({
      kind: binding.kind,
      async execute() {
        active += 1;
        peak = Math.max(peak, active);
        for (let tick = 0; tick < 5; tick += 1) await settle();
        active -= 1;
        return { status: "completed", content: [{ type: "text", text: "sunny" }], isError: false };
      },
    }),
    async prepareCredential() { return { kind: "none" }; },
  }).run();
  assert.deepEqual(result.cells.map(({ status }) => status), Array(4).fill("completed"));
  return peak;
}

function mcpBinding(toolId: ToolBinding["toolId"], serverId: string): ToolBinding {
  return {
    toolId,
    kind: "mcp",
    executorId: `mcp_${serverId}_${toolId}`,
    serverId,
    remoteToolName: toolId,
    discoveryFingerprint: "fingerprint",
  };
}

function commandBinding(toolId: ToolBinding["toolId"], executorId: string): ToolBinding {
  return { toolId, kind: "command", executorId, grantedAt: "2026-10-09T12:00:00.000Z" };
}

function mockBinding(toolId: ToolBinding["toolId"]): ToolBinding {
  return {
    toolId,
    kind: "mock",
    executorId: `mock_${toolId}`,
    result: { content: [{ type: "text", text: "sunny" }] },
  };
}

test("two tools on one MCP server never run at once", async () => {
  assert.equal(await peakToolOverlap([
    mcpBinding(weatherTool.id, "server_shared"),
    mcpBinding(forecastTool.id, "server_shared"),
  ]), 1);
});

test("two tools on one declared command never run at once", async () => {
  assert.equal(await peakToolOverlap([
    commandBinding(weatherTool.id, "command_shared"),
    commandBinding(forecastTool.id, "command_shared"),
  ]), 1);
});

test("calls to different MCP servers overlap", async () => {
  assert.equal(await peakToolOverlap([
    mcpBinding(weatherTool.id, "server_weather"),
    mcpBinding(forecastTool.id, "server_forecast"),
  ]), 2);
});

test("mock tool calls overlap", async () => {
  assert.ok(await peakToolOverlap([mockBinding(weatherTool.id), mockBinding(forecastTool.id)]) > 2);
});

test("a stop lets in-flight cells finish and starts no other", async () => {
  const started: string[] = [];
  const stopRecorded = deferred();
  const result = await new ExperimentController({
    plan: toolPlan(4),
    concurrency: { maxInFlight: 2, connectionLimit: 2 },
    transport: transportFor(toolCalling(), started),
    toolBindings: [mockBinding(weatherTool.id), mockBinding(forecastTool.id)],
    createExecutor: (binding): ToolExecutor => ({
      kind: binding.kind,
      async execute({ toolCallId }) {
        if (toolCallId.includes("run_1")) {
          return { status: "failed", failure: { kind: "unavailable", message: "The MCP server could not be reached." } };
        }
        // Cell 2 is still working when cell 1 finds the tool unavailable.
        await stopRecorded.promise;
        return { status: "completed", content: [{ type: "text", text: "sunny" }], isError: false };
      },
    }),
    async prepareCredential() { return { kind: "none" }; },
    onTerminalTrace(trace) {
      if (trace.runId === "run_1") stopRecorded.resolve();
    },
  }).run();

  assert.equal(result.status, "stopped");
  assert.deepEqual(result.stop, {
    reason: "tool_unavailable",
    cellId: "experiment-cell_1",
    toolId: weatherTool.id,
    startedCells: 2,
  });
  // Cell 2 started before the stop and kept its real outcome.
  assert.deepEqual(result.cells.map(({ status }) => status), ["failed", "completed", "not-run", "not-run"]);
  // Cell 2 continued past its tool call; cells 3 and 4 never reached a provider.
  assert.deepEqual(started, ["run_1", "run_2", "run_2"]);
});

test("cancellation aborts every in-flight cell", async () => {
  const started: string[] = [];
  const traces: RunTrace[] = [];
  const controller = new ExperimentController({
    plan: plan(4),
    concurrency: { maxInFlight: 3, connectionLimit: 3 },
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* (_runId, signal) {
      yield { type: "text_delta", text: "partial" };
      await abortion(signal);
    }, started),
    async prepareCredential() { return { kind: "none" }; },
    onTerminalTrace(trace) { traces.push(trace); },
  });

  const pending = controller.run();
  await until(() => started.length === 3, "three cells in flight");
  controller.cancel();
  const result = await pending;

  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.cells.map(({ status }) => status), ["cancelled", "cancelled", "cancelled", "not-run"]);
  assert.deepEqual(started, ["run_1", "run_2", "run_3"]);
  assert.deepEqual(traces.map(({ status }) => status.kind), ["cancelled", "cancelled", "cancelled"]);
});

test("a trace that cannot be saved aborts the cells in flight and waits for them before failing", async () => {
  const started: string[] = [];
  const order: string[] = [];
  let savedResults = 0;
  const controller = new ExperimentController({
    plan: plan(4),
    concurrency: { maxInFlight: 2, connectionLimit: 2 },
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* (runId, signal) {
      if (runId === "run_1") {
        yield* completed(runId);
        return;
      }
      yield { type: "text_delta", text: "partial" };
      await abortion(signal);
    }, started),
    async prepareCredential() { return { kind: "none" }; },
    async saveResult() { savedResults += 1; },
    async onTerminalTrace(trace) {
      await settle();
      order.push(`trace:${trace.runId}:${trace.status.kind}`);
      if (trace.status.kind === "cancelled") {
        order.push(`reason:${trace.status.reason}`);
      }
      throw new Error(`Trace disk full for ${trace.runId}`);
    },
  });

  await assert.rejects(
    async () => {
      try {
        await controller.run();
      } finally {
        order.push("rejected");
      }
    },
    /interrupted because terminal trace run_1 could not be saved: Trace disk full for run_1/,
  );
  // No new cell started after the failure.
  assert.deepEqual(started, ["run_1", "run_2"]);
  // Cell 2 was aborted and had settled before the caller heard of the failure.
  assert.deepEqual(order, [
    "trace:run_1:completed",
    "trace:run_2:cancelled",
    "reason:Stopped because another repetition's trace could not be saved.",
    "rejected",
  ]);
  assert.equal(savedResults, 0);
  assert.equal(controller.isRunning, false);
});

test("reads a rate-limit pause from retry-after-ms, then Retry-After, then the default", () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  assert.equal(rateLimitPauseMs({ "retry-after-ms": "1500", "retry-after": "9" }, now), 1500);
  assert.equal(rateLimitPauseMs({ "Retry-After": "3" }, now), 3000);
  assert.equal(rateLimitPauseMs({ "retry-after": "Fri, 09 Oct 2026 12:00:10 GMT" }, now), 10_000);
  assert.equal(rateLimitPauseMs({ "retry-after-ms": "soon", "retry-after": "2" }, now), 2000);
  assert.equal(rateLimitPauseMs({ "retry-after": "later" }, now), DEFAULT_RATE_LIMIT_PAUSE_MS);
  assert.equal(rateLimitPauseMs({}, now), DEFAULT_RATE_LIMIT_PAUSE_MS);
  assert.equal(rateLimitPauseMs(undefined, now), DEFAULT_RATE_LIMIT_PAUSE_MS);
  assert.equal(DEFAULT_RATE_LIMIT_PAUSE_MS, 5_000);
  // One header cannot stall a batch for an hour.
  assert.equal(rateLimitPauseMs({ "retry-after": "3600" }, now), MAX_RATE_LIMIT_PAUSE_MS);
  assert.equal(MAX_RATE_LIMIT_PAUSE_MS, 60_000);
  // A date already past needs no pause.
  assert.equal(rateLimitPauseMs({ "retry-after": "Fri, 09 Oct 2026 11:59:00 GMT" }, now), 0);
});

test("a 429 pauses new cells on its connection without interrupting cells in flight", async () => {
  const clock = fakeClock();
  const started: string[] = [];
  const releaseSecond = deferred();
  const controller = new ExperimentController({
    plan: plan(3),
    concurrency: { maxInFlight: 2, connectionLimit: 2 },
    clock,
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* (runId) {
      if (runId === "run_1") {
        yield* rateLimited({ "retry-after": "2" });
        return;
      }
      if (runId === "run_2") await releaseSecond.promise;
      yield* completed(runId);
    }, started),
    async prepareCredential() { return { kind: "none" }; },
  });

  const pending = controller.run();
  await until(() => started.length === 2, "two cells in flight");
  await until(() => clock.sleeps.length === 1, "the pause to begin");
  // Cell 2 was already running and is not interrupted; its slot frees up,
  // but the connection is paused.
  releaseSecond.resolve();
  for (let tick = 0; tick < 10; tick += 1) await settle();
  assert.deepEqual(started, ["run_1", "run_2"]);
  clock.advance(1_999);
  for (let tick = 0; tick < 10; tick += 1) await settle();
  assert.deepEqual(started, ["run_1", "run_2"]);
  clock.advance(1);
  const result = await pending;

  assert.deepEqual(clock.sleeps, [2_000]);
  assert.deepEqual(started, ["run_1", "run_2", "run_3"]);
  // Without retry, the rate-limited attempt still fails its own cell.
  assert.deepEqual(result.cells.map(({ status }) => status), ["failed", "completed", "completed"]);
});

test("cancellation ends a rate-limit pause at once", async () => {
  const clock = fakeClock();
  const started: string[] = [];
  const controller = new ExperimentController({
    plan: plan(2),
    clock,
    createExecutor: createMockOnlyToolExecutor,
    transport: transportFor(async function* (runId) {
      yield* rateLimited({ "retry-after": "30" });
      void runId;
    }, started),
    async prepareCredential() { return { kind: "none" }; },
  });

  const pending = controller.run();
  await until(() => clock.sleeps.length === 1, "the pause to begin");
  controller.cancel();
  const result = await pending;

  assert.deepEqual(started, ["run_1"]);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.cells.map(({ status }) => status), ["failed", "not-run"]);
});

/** Both cells of a two-cell plan in flight at once, so the second never waits on the first's pause. */
const BOTH_AT_ONCE = { maxInFlight: 2, connectionLimit: 2 };

/**
 * Answers each attempt of run 1 from `attempts`, by its attempt number and
 * turn; run 2, which plans need beside it, always answers at once. `log` records
 * run 1's attempts as "run:turn:attempt".
 */
function attemptTransport(
  attempts: (runId: string, attempt: number, turn: number) => ProviderTransportEvent[],
  log: string[] = [],
): ProviderTurnTransport {
  const turns = new Map<string, number>();
  return {
    async discoverModels() { return { models: [] }; },
    async executeTurn({ execution }): Promise<ProviderTurnStream> {
      if (execution.attempt === 1) turns.set(execution.runId, (turns.get(execution.runId) ?? 0) + 1);
      const turn = turns.get(execution.runId)!;
      const events = execution.runId === "run_1" ? attempts(execution.runId, execution.attempt, turn) : completed("other");
      if (execution.runId === "run_1") log.push(`${execution.runId}:${turn}:${execution.attempt}`);
      return { status: 200, headers: new Headers(), events: (async function* () { yield* events; })() };
    },
  };
}

test("with retries allowed, a 429 waits as its header asks and retries the same turn", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const traces: RunTrace[] = [];
  const controller = new ExperimentController({
    plan: plan(2),
    concurrency: BOTH_AT_ONCE,
    clock,
    retryPolicy: rateLimitRetries(),
    createExecutor: createMockOnlyToolExecutor,
    transport: attemptTransport((_runId, attempt) =>
      attempt === 1 ? rateLimited({ "retry-after": "2" }) : completed("hello"), log),
    async prepareCredential() { return { kind: "none" }; },
    onTerminalTrace(trace) { if (trace.runId === "run_1") traces.push(trace); },
  });

  const pending = controller.run();
  await until(() => clock.sleeps.length > 0, "the retry wait to begin");
  for (let tick = 0; tick < 10; tick += 1) await settle();
  // Nothing is retried before the wait ends.
  assert.deepEqual(log, ["run_1:1:1"]);
  clock.advance(2_000);
  const result = await pending;

  assert.deepEqual(log, ["run_1:1:1", "run_1:1:2"]);
  assert.ok(clock.sleeps.every((ms) => ms === 2_000));
  assert.deepEqual(result.retryPolicy, { rateLimited: { maxRetries: 2 } });
  assert.deepEqual(result.cells.map(({ status }) => status), ["completed", "completed"]);
  const attempts = traces[0]!.events.filter(({ type }) => type === "turn.attempt_started" || type === "turn.started");
  assert.equal(attempts.length, 2);
});

test("a turn is retried at most twice; the third 429 fails the repetition as rate limited", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const states: Array<ExperimentProgress["states"]> = [];
  const controller = new ExperimentController({
    plan: plan(2),
    concurrency: BOTH_AT_ONCE,
    clock,
    retryPolicy: rateLimitRetries(),
    createExecutor: createMockOnlyToolExecutor,
    transport: attemptTransport(() => rateLimited({}), log),
    async prepareCredential() { return { kind: "none" }; },
    onProgress(progress) { states.push(progress.states); },
  });

  const pending = controller.run();
  for (let retry = 1; retry <= 2; retry += 1) {
    await until(() => log.length === retry, `attempt ${retry}`);
    await settle();
    clock.advance(DEFAULT_RATE_LIMIT_PAUSE_MS);
  }
  const result = await pending;

  assert.deepEqual(log, ["run_1:1:1", "run_1:1:2", "run_1:1:3"]);
  assert.deepEqual(result.cells.map(({ status }) => status), ["failed", "completed"]);
  const final = states.at(-1)!.get("run_1")!;
  assert.equal(isRateLimitedRun(final), true);
  assert.equal(rateLimitRetryCount(final), 2);
});

test("each provider turn has its own retry budget", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const frozen = toolPlan(2);
  const controller = new ExperimentController({
    plan: frozen,
    concurrency: BOTH_AT_ONCE,
    clock,
    retryPolicy: rateLimitRetries(),
    toolBindings: [mockBinding(weatherTool.id), mockBinding(forecastTool.id)],
    createExecutor: createMockOnlyToolExecutor,
    transport: attemptTransport((runId, attempt, turn) => {
      if (attempt <= 2) return rateLimited({ "retry-after-ms": "10" });
      if (turn === 2) return completed("done");
      return [
        { type: "tool_call_delta", toolCallId: `tool-call_${runId}-1` as ToolCallId, index: 0, nameDelta: weatherTool.name, argumentsDelta: "{}" },
        { type: "completed", finishReason: { normalized: "tool_calls" } },
      ];
    }, log),
    async prepareCredential() { return { kind: "none" }; },
  });

  const pending = controller.run();
  for (const expected of [1, 2, 4, 5]) {
    await until(() => log.length === expected, `attempt ${expected}`);
    await settle();
    clock.advance(10);
  }
  const result = await pending;

  assert.deepEqual(log, ["run_1:1:1", "run_1:1:2", "run_1:1:3", "run_1:2:1", "run_1:2:2", "run_1:2:3"]);
  assert.deepEqual(result.cells.map(({ status }) => status), ["completed", "completed"]);
});

test("only a 429 is retried: a retryable 503 still fails its repetition", async () => {
  const log: string[] = [];
  const result = await new ExperimentController({
    plan: plan(2),
    concurrency: BOTH_AT_ONCE,
    clock: fakeClock(),
    retryPolicy: rateLimitRetries(),
    createExecutor: createMockOnlyToolExecutor,
    transport: attemptTransport(() => [{
      type: "failed",
      error: { code: "provider_error", message: "Unavailable", retryable: true, providerStatus: 503 },
    }], log),
    async prepareCredential() { return { kind: "none" }; },
  }).run();

  assert.deepEqual(log, ["run_1:1:1"]);
  assert.deepEqual(result.cells.map(({ status }) => status), ["failed", "completed"]);
});

test("with retries off, a 429 is not retried and the result says so", async () => {
  const log: string[] = [];
  const result = await new ExperimentController({
    plan: plan(2),
    concurrency: BOTH_AT_ONCE,
    clock: fakeClock(),
    createExecutor: createMockOnlyToolExecutor,
    transport: attemptTransport(() => rateLimited({}), log),
    async prepareCredential() { return { kind: "none" }; },
  }).run();

  assert.deepEqual(log, ["run_1:1:1"]);
  assert.deepEqual(result.retryPolicy, { rateLimited: { maxRetries: 0 } });
});

test("cancellation during a retry wait cancels the repetition without another attempt", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const controller = new ExperimentController({
    plan: plan(2),
    concurrency: BOTH_AT_ONCE,
    clock,
    retryPolicy: rateLimitRetries(),
    createExecutor: createMockOnlyToolExecutor,
    transport: attemptTransport(() => rateLimited({ "retry-after": "30" }), log),
    async prepareCredential() { return { kind: "none" }; },
  });

  const pending = controller.run();
  await until(() => clock.sleeps.length > 0, "the retry wait to begin");
  await settle();
  controller.cancel();
  const result = await pending;

  assert.deepEqual(log, ["run_1:1:1"]);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.cells.map(({ status }) => status), ["cancelled", "completed"]);
});
