import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderTurnStream, ProviderTurnTransport } from "../packages/contracts/src/inference.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import type { RepeatedExperimentPlanV3 } from "../packages/core/src/experiment.ts";
import type { ProviderTransportEvent, RunTrace, ToolCallId } from "../packages/core/src/run-kernel/index.ts";
import type { ToolBinding } from "../packages/core/src/tool-execution.ts";
import { SequentialExperimentController } from "../app/run/sequential-experiment-controller.client.ts";
import { createExperimentWorkspacePersistence } from "../app/run/experiment-workspace-persistence.client.ts";
import type { ProjectWorkspaceHandle } from "../app/project-workspace.client.ts";

function plan(count: number): RepeatedExperimentPlanV3 {
  return {
    schemaVersion: 4,
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

const weatherTool = {
  id: "tool_weather" as const,
  name: "get_weather",
  description: "Looks up weather.",
  inputSchema: { type: "object", properties: {} },
};

/** A plan exposing one tool, which the provider will be asked to call. */
function toolPlan(count: number, turnCeiling?: number): RepeatedExperimentPlanV3 {
  const frozen = plan(count);
  frozen.commonInput.tools = [weatherTool];
  frozen.commonInput.target.capabilities = {
    ...frozen.commonInput.target.capabilities,
    tools: true,
  };
  if (turnCeiling !== undefined) frozen.turnCeiling = turnCeiling;
  return frozen;
}

const mockBinding: ToolBinding = {
  toolId: weatherTool.id,
  kind: "mock",
  executorId: "mock_sunny",
  label: "sunny default",
  result: { content: [{ type: "text", text: "sunny, 24C" }] },
};

/**
 * Asks for one tool call per turn, up to `calls`, then answers. Counted per
 * repetition: a shared counter would let cell 2 inherit cell 1's turns and
 * quietly stop exercising continuation at all.
 */
function toolCalling(calls: number) {
  const turns = new Map<string, number>();
  return (runId: string): AsyncIterable<ProviderTransportEvent> => {
    const turn = (turns.get(runId) ?? 0) + 1;
    turns.set(runId, turn);
    if (turn > calls) return events(completed("done"));
    return events([
      {
        type: "tool_call_delta",
        toolCallId: `tool-call_${runId}-${turn}` as ToolCallId,
        index: 0,
        nameDelta: weatherTool.name,
        argumentsDelta: '{"city":"Chicago"}',
      },
      { type: "completed", finishReason: { normalized: "tool_calls" } },
    ]);
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
    const controller = new SequentialExperimentController({
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
  const result = await new SequentialExperimentController({
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

test("refuses the whole batch when credential preflight fails", async () => {
  let credentialAttempt = 0;
  const started: string[] = [];
  const traces: RunTrace[] = [];
  await assert.rejects(() => new SequentialExperimentController({
    plan: plan(3),
    transport: transportFor((runId) => events(completed(runId)), started),
    async prepareCredential() {
      credentialAttempt += 1;
      if (credentialAttempt === 1 || credentialAttempt === 3) throw new Error("Credential unavailable");
      return { kind: "none" };
    },
    onTerminalTrace(trace) { traces.push(trace); },
  }).run(), /Credential unavailable/);

  assert.deepEqual(started, []);
  assert.deepEqual(traces, []);
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
  const controller = new SequentialExperimentController({
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
  const controller = new SequentialExperimentController({
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
  const rejected = new SequentialExperimentController({
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
  const result = await new SequentialExperimentController({
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

test("validates ad hoc plans before progress or provider work", async () => {
  const invalid = plan(2);
  invalid.cells[1]!.runId = invalid.cells[0]!.runId;
  let providerCalls = 0;
  const progress: unknown[] = [];
  const controller = new SequentialExperimentController({
    plan: invalid,
    transport: transportFor(() => {
      providerCalls += 1;
      return events(completed("unexpected"));
    }),
    async prepareCredential() { return { kind: "none" }; },
    onProgress(snapshot) { progress.push(snapshot); },
  });

  await assert.rejects(() => controller.run(), /repeats run/);
  assert.equal(providerCalls, 0);
  assert.deepEqual(progress, []);
});

test("emits immutable progress snapshots with finished terminal-cell counts", async () => {
  const snapshots: Array<{
    status: string;
    requested: number;
    finished: number;
    currentOrdinal?: number;
    states: Array<[string, string]>;
  }> = [];
  const result = await new SequentialExperimentController({
    plan: plan(2),
    transport: transportFor((runId) => events(completed(runId))),
    async prepareCredential() { return { kind: "none" }; },
    onProgress(progress) {
      snapshots.push({
        status: progress.status,
        requested: progress.requested,
        finished: progress.finished,
        ...(progress.currentOrdinal === undefined ? {} : { currentOrdinal: progress.currentOrdinal }),
        states: [...progress.states].map(([runId, state]) => [runId, state.status.kind]),
      });
    },
  }).run();

  assert.equal(result.status, "completed");
  assert.deepEqual(snapshots[0], {
    status: "running", requested: 2, finished: 0, states: [],
  });
  assert.ok(snapshots.some((snapshot) =>
    snapshot.status === "running"
    && snapshot.finished === 1
    && snapshot.currentOrdinal === 1
    && snapshot.states[0]?.[1] === "completed",
  ));
  assert.deepEqual(snapshots.at(-1), {
    status: "completed",
    requested: 2,
    finished: 2,
    states: [["run_1", "completed"], ["run_2", "completed"]],
  });
});

test("progress keeps the parsed schedule when the caller mutates its source plan", async () => {
  const sourcePlan = plan(2);
  const firstTraceStarted = deferred();
  const releaseFirstTrace = deferred();
  const requested: number[] = [];
  const controller = new SequentialExperimentController({
    plan: sourcePlan,
    transport: transportFor((runId) => events(completed(runId))),
    async prepareCredential() { return { kind: "none" }; },
    onProgress(progress) { requested.push(progress.requested); },
    async onTerminalTrace(_trace, cell) {
      if (cell.ordinal !== 1) return;
      sourcePlan.cells.pop();
      firstTraceStarted.resolve();
      await releaseFirstTrace.promise;
    },
  });

  const pending = controller.run();
  await firstTraceStarted.promise;
  releaseFirstTrace.resolve();
  await pending;

  assert.deepEqual(requested, Array(requested.length).fill(2));
});

test("a terminal-trace persistence failure deliberately interrupts the experiment", async () => {
  const started: string[] = [];
  let savedPlans = 0;
  let savedResults = 0;
  const controller = new SequentialExperimentController({
    plan: plan(3),
    transport: transportFor((runId) => events(completed(runId)), started),
    async prepareCredential() { return { kind: "none" }; },
    async savePlan() { savedPlans += 1; },
    async saveResult() { savedResults += 1; },
    async onTerminalTrace() { throw new Error("Trace disk full"); },
  });

  await assert.rejects(
    () => controller.run(),
    /interrupted because terminal trace run_1 could not be saved: Trace disk full/,
  );
  assert.deepEqual(started, ["run_1"]);
  assert.equal(savedPlans, 1);
  assert.equal(savedResults, 0);
});

test("a cancellation requested before run saves a cancelled no-provider result", async () => {
  let providerCalls = 0;
  const saved: string[] = [];
  const controller = new SequentialExperimentController({
    plan: plan(2),
    transport: transportFor(() => {
      providerCalls += 1;
      return events(completed("unexpected"));
    }),
    async prepareCredential() { return { kind: "none" }; },
    async savePlan() { saved.push("plan"); },
    async saveResult() { saved.push("result"); },
  });

  controller.cancel();
  const result = await controller.run();

  assert.equal(providerCalls, 0);
  assert.deepEqual(saved, ["plan", "result"]);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.cells.map((cell) => cell.status), ["not-run", "not-run"]);
});

test("serves a tool call and continues the repetition to a real answer", async () => {
  const started: string[] = [];
  const traces: RunTrace[] = [];
  const result = await new SequentialExperimentController({
    plan: toolPlan(2),
    transport: transportFor(toolCalling(1), started),
    toolBindings: [mockBinding],
    async prepareCredential() { return { kind: "none" }; },
    onTerminalTrace(trace) { traces.push(trace); },
  }).run();

  assert.deepEqual(result.cells.map(({ status }) => status), ["completed", "completed"]);
  // Two provider calls per repetition: the call, then the continuation.
  assert.deepEqual(started, ["run_1", "run_1", "run_2", "run_2"]);
  const trace = traces[0]!;
  assert.equal(trace.turns.length, 2);
  assert.equal(trace.turns[1]?.attempts[0]?.text, "done");
  // The result the model saw came from the executor, and says so.
  assert.equal(trace.toolResults[0]?.content[0]?.text, "sunny, 24C");
  assert.deepEqual(trace.toolResults[0]?.resolution, { kind: "mock", ruleId: "mock_sunny" });
  assert.equal(trace.toolExecutions[0]?.status, "completed");
  assert.deepEqual(trace.toolExecutions[0]?.executor, {
    kind: "mock",
    executorId: "mock_sunny",
    label: "sunny default",
  });
});

test("a repetition that keeps calling tools fails at its ceiling without stopping the batch", async () => {
  const started: string[] = [];
  const traces: RunTrace[] = [];
  // Cell 1 never stops asking; cell 2 asks once and then answers.
  const endless = toolCalling(99);
  const once = toolCalling(1);
  const result = await new SequentialExperimentController({
    plan: toolPlan(2, 3),
    transport: transportFor((runId) => {
      if (runId === "run_1") return endless(runId);
      return once(runId);
    }, started),
    toolBindings: [mockBinding],
    async prepareCredential() { return { kind: "none" }; },
    onTerminalTrace(trace) { traces.push(trace); },
  }).run();

  assert.deepEqual(result.cells.map(({ status }) => status), ["failed", "completed"]);
  // Three turns, not four: the ceiling is a bound on provider calls.
  assert.deepEqual(started, ["run_1", "run_1", "run_1", "run_2", "run_2"]);
  assert.equal(traces[0]?.turns.length, 3);
  assert.match(
    traces[0]?.status.kind === "failed" ? traces[0].status.error.message : "",
    /reached its 3-turn ceiling/,
  );
  assert.equal(traces[1]?.status.kind, "completed");
});

test("an executor failure fails only its own repetition, and never answers for the tool", async () => {
  const traces: RunTrace[] = [];
  const failing: ToolBinding = {
    ...mockBinding,
    result: { content: [{ type: "text", text: "unused" }] },
  };
  const result = await new SequentialExperimentController({
    plan: toolPlan(2),
    transport: transportFor(toolCalling(1)),
    toolBindings: [failing],
    createExecutor: () => ({
      kind: "mock",
      async execute() {
        throw new Error("the executor exploded");
      },
    }),
    async prepareCredential() { return { kind: "none" }; },
    onTerminalTrace(trace) { traces.push(trace); },
  }).run();

  assert.deepEqual(result.cells.map(({ status }) => status), ["failed", "failed"]);
  assert.match(
    traces[0]?.status.kind === "failed" ? traces[0].status.error.message : "",
    /get_weather could not be executed: the executor exploded/,
  );
  // A failure must never fabricate a result: the call stayed unanswered.
  assert.deepEqual(traces[0]?.toolResults, []);
  assert.equal(traces[0]?.toolExecutions[0]?.status, "failed");
});

test("refuses to start when an exposed tool has no binding on this device", async () => {
  let providerCalls = 0;
  const controller = new SequentialExperimentController({
    plan: toolPlan(2),
    transport: transportFor(() => {
      providerCalls += 1;
      return events(completed("unexpected"));
    }),
    async prepareCredential() { return { kind: "none" }; },
  });

  await assert.rejects(() => controller.run(), /No binding on this device can serve get_weather/);
  assert.equal(providerCalls, 0);
});

test("workspace persistence binds plans, terminal traces, and results to PR2 helpers", async () => {
  const artifacts = new Map<string, string>();
  const traces = new Map<string, string>();
  const workspace: ProjectWorkspaceHandle = {
    kind: "browser-directory",
    displayName: "Experiment test",
    displayPath: "Experiment test",
    storage: {
      async save() {},
      async saveTrace(_runId, fileName, contents) { traces.set(fileName, contents); },
      async listTraces() { return []; },
      async readTrace() { throw new Error("not used"); },
      async saveExperimentArtifact(fileName, contents) { artifacts.set(fileName, contents); },
      async listExperimentArtifacts() { return []; },
      async readExperimentArtifact() { throw new Error("not used"); },
      async readEvaluationBaselines() { return null; },
      async saveEvaluationBaselines() {},
    },
  };
  const frozenPlan = plan(2);
  const result = await new SequentialExperimentController({
    plan: frozenPlan,
    transport: transportFor((runId) => events(completed(runId))),
    async prepareCredential() { return { kind: "none" }; },
    ...createExperimentWorkspacePersistence(workspace, frozenPlan),
  }).run();

  assert.equal(result.status, "completed");
  assert.deepEqual([...artifacts.keys()].sort(), [
    "experiment_controller.plan.json",
    "experiment_controller.result.json",
  ]);
  assert.deepEqual([...traces.keys()].sort(), ["run_1.json", "run_2.json"]);
  assert.match(artifacts.get("experiment_controller.plan.json")!, /"kind": "repeated-request"/);
  assert.match(artifacts.get("experiment_controller.result.json")!, /"status": "completed"/);
});
