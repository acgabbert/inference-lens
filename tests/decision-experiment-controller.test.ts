import assert from "node:assert/strict";
import test from "node:test";

import type { CredentialSelection, DecisionStream, DecisionTransport, ProviderTurnTransport } from "../packages/contracts/src/inference.ts";
import type { DecisionRun, DecisionTransportEvent, ResolvedDecisionTarget } from "../packages/core/src/decision.ts";
import { decisionRunFromTrace } from "../packages/core/src/decision-trace.ts";
import type { DecisionRunTrace } from "../packages/core/src/decision-trace.ts";
import {
  evaluationParsedExperimentAggregate,
  parseExperimentPlanJson,
  parseExperimentResultJson,
  rateLimitRetries,
} from "../packages/core/src/experiment.ts";
import type { ExperimentPlan, RepeatedExperimentPlan } from "../packages/core/src/experiment.ts";
import type { RunId } from "../packages/core/src/run-kernel/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import { createMockOnlyToolExecutor } from "../packages/runner/src/mock-only-tool-executor.ts";
import type { SchedulerClock } from "../packages/runner/src/scheduler-clock.ts";
import { ExperimentController } from "../packages/runner/src/experiment-controller.ts";
import type { ExperimentProgress } from "../packages/runner/src/experiment-controller.ts";
import { decisionAnswers, decisionPlan } from "./fixtures/decision-evaluation.ts";

const plan = decisionPlan();
const NONE: CredentialSelection = { kind: "none" };

function success(choice = "refund", severity = 1.5): DecisionTransportEvent[] {
  const answers = decisionAnswers(choice, severity);
  return [
    { type: "request", request: { url: "http://127.0.0.1/v1/systemone", method: "POST", headers: {} } },
    { type: "response_started", response: { status: 200, headers: { "content-type": "application/json" } } },
    { type: "frame", frame: { index: 0, raw: JSON.stringify({ answers }) } },
    { type: "completed", result: { answers, usage: { inputTokens: 120, outputTokens: 0, totalTokens: 120 } } },
  ];
}

function failure(status: number, headers: Record<string, string> = {}): DecisionTransportEvent[] {
  return [
    { type: "request", request: { url: "http://127.0.0.1/v1/systemone", method: "POST", headers: {} } },
    { type: "response_started", response: { status, headers } },
    { type: "frame", frame: { index: 0, raw: "{\"error\":\"nope\"}" } },
    { type: "failed", error: { code: "provider_error", message: `HTTP ${status}`, retryable: status === 429 || status >= 500, providerStatus: status } },
  ];
}

/** Scripts each attempt by run and attempt number. */
function decisionTransport(
  script: (runId: RunId, attempt: number, signal: AbortSignal | undefined) => AsyncIterable<DecisionTransportEvent> | DecisionTransportEvent[],
  sent: Array<{ runId: RunId; attempt: number; target: ResolvedDecisionTarget }> = [],
): DecisionTransport {
  return {
    async executeDecision({ execution }, signal): Promise<DecisionStream> {
      sent.push({ runId: execution.runId, attempt: execution.attempt, target: execution.input.target });
      const events = script(execution.runId, execution.attempt, signal);
      return { status: 200, headers: new Headers(), events: Array.isArray(events) ? toAsync(events) : events };
    },
  };
}

async function* toAsync(events: readonly DecisionTransportEvent[]): AsyncIterable<DecisionTransportEvent> {
  for (const event of events) yield event;
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

test("a decision plan runs every cell, saving decision traces, and scores as run", async () => {
  const sent: Array<{ runId: RunId; attempt: number; target: ResolvedDecisionTarget }> = [];
  const prepared: ResolvedDecisionTarget[] = [];
  const traces: DecisionRunTrace[] = [];
  const saved: { plan?: string; result?: string } = {};
  const emitted: ExperimentProgress<DecisionRun>[] = [];
  const controller = new ExperimentController<DecisionRun>({
    plan,
    decisionTransport: decisionTransport(() => success(), sent),
    async prepareCredential(target) { prepared.push(target); return NONE; },
    async savePlan(_plan, serialized) { saved.plan = serialized; },
    async saveResult(_result, serialized) { saved.result = serialized; },
    onTerminalTrace(trace) { traces.push(trace); },
    onProgress(progress) { emitted.push(progress); },
  });
  const result = await controller.run();

  assert.equal(result.status, "completed");
  assert.deepEqual(result.cells.map(({ status }) => status), plan.cells.map(() => "completed"));
  // Each request is the case's frozen request, sent to the configuration's target.
  assert.deepEqual(sent.map(({ runId }) => runId), plan.cells.map(({ runId }) => runId));
  assert.deepEqual(sent.map(({ target }) => target.model), [
    "local-decision", "local-decision", "big-decision", "big-decision",
    "local-decision", "local-decision", "big-decision", "big-decision",
  ]);
  // One credential per connection, prepared before anything is sent.
  assert.deepEqual(prepared.map(({ model }) => model), ["local-decision", "big-decision"]);

  assert.equal(traces.length, plan.cells.length);
  assert.ok(traces.every((trace) => trace.kind === "decision" && trace.status.kind === "completed"));
  assert.deepEqual(traces[0]!.input.decision, plan.suite.cases[0]!.input.decision);

  const savedPlan = parseExperimentPlanJson(saved.plan!);
  assert.equal(savedPlan.kind, "decision-evaluation");
  assert.deepEqual(parseExperimentResultJson(saved.result!, savedPlan), result);

  const final = emitted.at(-1)!;
  assert.equal(final.status, "completed");
  assert.equal(final.finished, plan.cells.length);
  assert.ok([...final.states.values()].every((run) => run.kind === "decision" && run.status.kind === "completed"));
  const aggregate = evaluationParsedExperimentAggregate(plan, result, final.states);
  assert.deepEqual(aggregate.variants.map(({ passed }) => passed), [true, true]);
});

test("a decision 429 pauses its connection and is retried through the policy's wait", async () => {
  const clock = fakeClock();
  const sent: Array<{ runId: RunId; attempt: number; target: ResolvedDecisionTarget }> = [];
  const first = plan.cells[0]!.runId;
  const traces = new Map<RunId, DecisionRunTrace>();
  const emitted: ExperimentProgress<DecisionRun>[] = [];
  const pending = new ExperimentController<DecisionRun>({
    plan,
    decisionTransport: decisionTransport((runId, attempt) =>
      runId === first && attempt === 1 ? failure(429, { "retry-after": "3" }) : success(), sent),
    async prepareCredential() { return NONE; },
    retryPolicy: rateLimitRetries(),
    clock,
    onTerminalTrace(trace) { traces.set(trace.runId, trace); },
    onProgress(progress) { emitted.push(progress); },
  }).run();

  await until(() => clock.sleeps.length >= 2, "the pause and the retry wait");
  assert.deepEqual(clock.sleeps, [3_000, 3_000]);
  const paused = emitted.at(-1)!;
  assert.deepEqual(paused.pausedConnections.map(({ profileId }) => profileId), [plan.suite.variants[0]!.target.profileId]);
  assert.equal(paused.states.get(first)!.status.kind, "paused");
  clock.advance(3_000);
  const result = await pending;

  assert.equal(result.status, "completed");
  const retried = traces.get(first)!;
  assert.deepEqual(retried.attempts.map(({ status }) => status), ["failed", "completed"]);
  assert.deepEqual(sent.filter(({ runId }) => runId === first).map(({ attempt }) => attempt), [1, 2]);
  const states = new Map([...traces].map(([runId, trace]) => [runId, decisionRunFromTrace(trace)]));
  const [base] = evaluationParsedExperimentAggregate(plan, result, states).variants;
  assert.equal(base!.retriedAfterRateLimit, 1);
  assert.equal(base!.passed, true);
});

test("without retries a decision 429 fails its repetition as rate-limited, and the batch goes on", async () => {
  const clock = fakeClock();
  const first = plan.cells[0]!.runId;
  const finalStates: { value?: ReadonlyMap<RunId, DecisionRun> } = {};
  const pending = new ExperimentController<DecisionRun>({
    plan,
    decisionTransport: decisionTransport((runId) => runId === first ? failure(429, { "retry-after": "1" }) : success()),
    async prepareCredential() { return NONE; },
    clock,
    onProgress(progress) { finalStates.value = progress.states; },
  }).run();
  await until(() => clock.sleeps.length >= 1, "the pause");
  clock.advance(1_000);
  const result = await pending;

  assert.equal(result.status, "completed");
  assert.equal(result.cells[0]!.status, "failed");
  assert.deepEqual(result.cells.slice(1).map(({ status }) => status), plan.cells.slice(1).map(() => "completed"));
  const run = finalStates.value!.get(first)!;
  assert.equal(run.status.kind, "failed");
  assert.equal(run.attempts.length, 1);
  const [base] = evaluationParsedExperimentAggregate(plan, result, finalStates.value).variants;
  assert.equal(base!.cases[0]!.repetitions[0]!.classification, "rate-limited");
});

test("a retryable decision failure other than 429 fails its repetition rather than waiting for a person", async () => {
  const first = plan.cells[0]!.runId;
  let states: ReadonlyMap<RunId, DecisionRun> = new Map();
  const result = await new ExperimentController<DecisionRun>({
    plan,
    decisionTransport: decisionTransport((runId) => runId === first ? failure(503) : success()),
    async prepareCredential() { return NONE; },
    onProgress(progress) { states = progress.states; },
  }).run();
  assert.equal(result.cells[0]!.status, "failed");
  const run = states.get(first)!;
  assert.equal(run.status.kind, "failed");
  assert.equal(run.status.kind === "failed" && run.status.error.providerStatus, 503);
});

test("cancelling a decision batch cancels the cell in flight and starts no other", async () => {
  const sent: Array<{ runId: RunId; attempt: number; target: ResolvedDecisionTarget }> = [];
  const traces: DecisionRunTrace[] = [];
  const controller = new ExperimentController<DecisionRun>({
    plan,
    decisionTransport: decisionTransport((_runId, _attempt, signal) => (async function* () {
      yield success()[0]!;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new DOMException("Aborted", "AbortError");
    })(), sent),
    async prepareCredential() { return NONE; },
    onTerminalTrace(trace) { traces.push(trace); },
  });
  const pending = controller.run();
  await until(() => sent.length === 1, "the first request");
  controller.cancel();
  const result = await pending;

  assert.equal(result.status, "cancelled");
  assert.equal(result.cells[0]!.status, "cancelled");
  assert.ok(result.cells.slice(1).every(({ status }) => status === "not-run"));
  assert.equal(traces.length, 1);
  assert.equal(traces[0]!.status.kind, "cancelled");
  assert.equal(traces[0]!.status.kind === "cancelled" && traces[0]!.status.reason, "Stopped by user.");
});

test("each plan kind needs its own transport", async () => {
  const chatTransport: ProviderTurnTransport = {
    async discoverModels() { return { models: [] }; },
    async executeTurn() { throw new Error("unreachable"); },
  };
  await assert.rejects(
    () => new ExperimentController({
      plan: plan as unknown as RepeatedExperimentPlan,
      transport: chatTransport,
      createExecutor: createMockOnlyToolExecutor,
      async prepareCredential() { return NONE; },
    }).run(),
    /A decision evaluation runs through a decision transport/,
  );
  const chatPlan: ExperimentPlan = {
    schemaVersion: 6,
    experimentId: "experiment_chat",
    kind: "repeated-request",
    createdAt: "2026-10-24T12:00:00.000Z",
    commonInput: {
      conversationId: "conversation_chat",
      conversationRevisionId: "revision_chat",
      target: {
        profileId: "profile_chat",
        protocol: "openai-compatible-chat-completions",
        endpoint: "https://provider.example.test/v1",
        model: "chat-model",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      messages: [{ id: "message_chat", role: "user", content: [{ type: "text", text: "Hi" }] }],
      templateResolutions: [],
      responseMode: "buffered",
      options: {},
      tools: [],
      resolvedAt: "2026-10-24T12:00:00.000Z",
    },
    cells: [
      { cellId: "experiment-cell_1", ordinal: 1, runId: "run_1" },
      { cellId: "experiment-cell_2", ordinal: 2, runId: "run_2" },
    ],
  };
  await assert.rejects(
    () => new ExperimentController<DecisionRun>({
      plan: chatPlan as unknown as typeof plan,
      decisionTransport: decisionTransport(() => success()),
      async prepareCredential() { return NONE; },
    }).run(),
    /A chat experiment runs through a provider turn transport/,
  );
});
