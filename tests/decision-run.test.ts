import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  DecisionExecution,
  DecisionInput,
  DecisionRun,
  DecisionTransportEvent,
  ResolvedDecisionRunInput,
} from "../packages/core/src/decision.ts";
import {
  applyDecisionEvent,
  beginDecisionAttempt,
  createDecisionRun,
  decisionRetryWaitMs,
  driveDecisionAttempt,
  finishDecisionAttemptStream,
  retryDecisionRun,
  stopDecisionRun,
} from "../packages/core/src/decision-run.ts";
import { decisionRunFromTrace, decisionRunTrace } from "../packages/core/src/decision-trace.ts";
import { DEFAULT_RATE_LIMIT_PAUSE_MS } from "../packages/core/src/rate-limit-pause.ts";
import { createEntityId } from "../packages/core/src/run-kernel/index.ts";
import type { JsonObject, RunError } from "../packages/core/src/run-kernel/index.ts";
import { parseSavedRunTraceJson, serializeDecisionRunTrace } from "../packages/core/src/run-trace.ts";
import { systemOneAdapter } from "../packages/core/src/system-one.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

interface WireFixture {
  request: JsonObject & DecisionInput & { model: string };
  response: { status: number; body: JsonObject };
}

const allTypes = JSON.parse(
  readFileSync(new URL("./fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8"),
) as WireFixture;
const rawBody = JSON.stringify(allTypes.response.body);
const runId = createEntityId("run", "decision-run");

function at(second: number): string {
  return new Date(Date.UTC(2026, 9, 24, 12, 0, second)).toISOString();
}

function runInput(): ResolvedDecisionRunInput {
  const { model, state, questions } = allTypes.request;
  return {
    runId,
    resolvedAt: at(0),
    target: {
      profileId: createEntityId("profile", "llamacpp"),
      protocol: "systemone",
      endpoint: "https://llm.example.test/v1",
      model,
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
    decision: { state, questions },
  };
}

const request = {
  url: "https://llm.example.test/v1/systemone",
  method: "POST",
  headers: { authorization: "Bearer ••••••••", "content-type": "application/json" },
  body: JSON.stringify(allTypes.request),
};

function successEvents(input = runInput()): DecisionTransportEvent[] {
  return [
    { type: "request", request },
    { type: "response_started", response: { status: 200, headers: { "content-type": "application/json" } } },
    { type: "frame", frame: { index: 0, raw: rawBody } },
    { type: "completed", result: systemOneAdapter.normalizeResponse(input, rawBody) },
  ];
}

const rateLimited: RunError = {
  code: "provider_error",
  message: "Too many requests.",
  retryable: true,
  providerStatus: 429,
};

function rateLimitedEvents(headers: Record<string, string>): DecisionTransportEvent[] {
  return [
    { type: "request", request },
    { type: "response_started", response: { status: 429, headers } },
    { type: "frame", frame: { index: 0, raw: '{"error":"slow down"}' } },
    { type: "failed", error: rateLimited },
  ];
}

function applyAll(run: DecisionRun, events: DecisionTransportEvent[], time: string): DecisionRun {
  return events.reduce((current, event) => applyDecisionEvent(current, event, time), run);
}

function begun(time = at(1)): { run: DecisionRun; execution: DecisionExecution } {
  return beginDecisionAttempt(createDecisionRun(runInput()), time);
}

/** A terminal run must be exactly what the D22 trace format accepts. */
function assertSavable(run: DecisionRun): void {
  const trace = decisionRunTrace(run);
  const reopened = parseSavedRunTraceJson(serializeDecisionRunTrace(trace));
  assert.equal(reopened.kind, "decision");
  assert.deepEqual(decisionRunFromTrace(trace), run);
}

test("a new run has no attempts until one begins", () => {
  const run = createDecisionRun(runInput());
  assert.deepEqual(run.status, { kind: "not_started" });
  assert.deepEqual(run.attempts, []);
  assert.equal(run.startedAt, undefined);
});

test("beginning attempt 1 records it, and its exchange, before anything is sent", () => {
  const { run, execution } = begun();
  const exchangeId = createEntityId("exchange", "decision-run-1");
  assert.deepEqual(run.status, { kind: "running", attempt: 1, exchangeId });
  assert.deepEqual(run.attempts, [{ attempt: 1, exchangeId, status: "running" }]);
  assert.deepEqual(run.exchanges[exchangeId], { exchangeId, attempt: 1, frames: [] });
  assert.equal(run.startedAt, at(1));
  assert.deepEqual(execution, {
    runId,
    attempt: 1,
    exchangeId,
    input: { target: run.input.target, decision: run.input.decision },
  });
});

test("a completed exchange completes the run with its evidence and saves", () => {
  const { run: started } = begun();
  const run = applyAll(started, successEvents(), at(2));
  const exchangeId = createEntityId("exchange", "decision-run-1");

  assert.deepEqual(run.status, { kind: "completed", completedAt: at(2) });
  assert.equal(run.endedAt, at(2));
  assert.equal(run.attempts[0]!.status, "completed");
  assert.equal(run.attempts[0]!.result!.answers.intent?.type, "choice");
  assert.deepEqual(run.exchanges[exchangeId]!.request, request);
  assert.equal(run.exchanges[exchangeId]!.response!.status, 200);
  assert.deepEqual(run.exchanges[exchangeId]!.frames, [{ index: 0, raw: rawBody }]);
  assertSavable(run);
});

test("a retryable failure pauses the run instead of ending it", () => {
  const { run: started } = begun();
  const run = applyAll(started, rateLimitedEvents({ "retry-after": "1" }), at(2));
  const exchangeId = createEntityId("exchange", "decision-run-1");

  assert.deepEqual(run.status, {
    kind: "paused",
    reason: "attempt_failed",
    attempt: 1,
    exchangeId,
    error: rateLimited,
  });
  assert.equal(run.endedAt, undefined);
  assert.deepEqual(run.attempts[0], { attempt: 1, exchangeId, status: "failed", error: rateLimited });
  assert.throws(() => decisionRunTrace(run), /Only a finished decision run can be saved/);
});

test("a non-retryable failure ends the run as failed and saves", () => {
  const error: RunError = { code: "provider_error", message: "bad request", retryable: false, providerStatus: 400 };
  const { run: started } = begun();
  const run = applyDecisionEvent(started, { type: "failed", error }, at(2));

  assert.deepEqual(run.status, { kind: "failed", failedAt: at(2), error });
  assert.equal(run.endedAt, at(2));
  assertSavable(run);
});

test("retry sends the same input as a new attempt and keeps the failed one", () => {
  const { run: started } = begun();
  const paused = applyAll(started, rateLimitedEvents({ "retry-after": "1" }), at(2));
  const { run: retried, execution } = retryDecisionRun(paused, at(4));
  const secondExchange = createEntityId("exchange", "decision-run-2");

  assert.deepEqual(retried.status, { kind: "running", attempt: 2, exchangeId: secondExchange });
  assert.equal(execution.attempt, 2);
  assert.equal(execution.exchangeId, secondExchange);
  assert.deepEqual(execution.input.decision, paused.input.decision);
  assert.equal(retried.startedAt, at(1));

  const run = applyAll(retried, successEvents(), at(5));
  assert.deepEqual(run.attempts.map(({ status }) => status), ["failed", "completed"]);
  assert.equal(Object.keys(run.exchanges).length, 2);
  assertSavable(run);
});

test("retry is refused unless the run is paused on a failed attempt", () => {
  const { run: running } = begun();
  assert.throws(() => retryDecisionRun(running, at(2)), /paused/);
  const completed = applyAll(running, successEvents(), at(2));
  assert.throws(() => retryDecisionRun(completed, at(3)), /paused/);
});

test("stopping in flight cancels the attempt and the run", () => {
  const { run: started } = begun();
  const sent = applyDecisionEvent(started, { type: "request", request }, at(2));
  const run = stopDecisionRun(sent, at(3));

  assert.deepEqual(run.status, { kind: "cancelled", cancelledAt: at(3), reason: "Stopped by user." });
  assert.equal(run.attempts[0]!.status, "cancelled");
  assert.equal(run.endedAt, at(3));
  assertSavable(run);
});

test("stopping before dispatch saves attempt 1 cancelled with no request evidence", () => {
  const { run: started } = begun();
  const run = stopDecisionRun(started, at(2));
  const exchangeId = createEntityId("exchange", "decision-run-1");

  assert.equal(run.status.kind, "cancelled");
  assert.deepEqual(run.exchanges[exchangeId], { exchangeId, attempt: 1, frames: [] });
  assertSavable(run);
});

test("stopping during a retry wait saves the run as failed with that attempt's error", () => {
  const { run: started } = begun();
  const paused = applyAll(started, rateLimitedEvents({ "retry-after": "1" }), at(2));
  const run = stopDecisionRun(paused, at(3));

  assert.deepEqual(run.status, { kind: "failed", failedAt: at(3), error: rateLimited });
  assert.equal(run.attempts[0]!.status, "failed");
  assertSavable(run);
});

test("stopping is idempotent on a finished or unstarted run", () => {
  const unstarted = createDecisionRun(runInput());
  assert.equal(stopDecisionRun(unstarted, at(1)), unstarted);
  const { run: started } = begun();
  const completed = applyAll(started, successEvents(), at(2));
  assert.equal(stopDecisionRun(completed, at(3)), completed);
});

test("a host's cancelled event cancels the run with its reason", () => {
  const { run: started } = begun();
  const run = applyDecisionEvent(started, { type: "cancelled", reason: "Native side stopped." }, at(2));
  assert.deepEqual(run.status, { kind: "cancelled", cancelledAt: at(2), reason: "Native side stopped." });
  assertSavable(run);
});

test("a stream that ends without an outcome fails the attempt as a protocol error", () => {
  const { run: started } = begun();
  const partial = applyAll(started, successEvents().slice(0, 3), at(2));
  const run = finishDecisionAttemptStream(partial, at(3));

  assert.equal(run.status.kind, "failed");
  assert.equal(run.attempts[0]!.error!.code, "protocol_error");
  assert.equal(run.attempts[0]!.error!.retryable, false);
  assertSavable(run);
  assert.equal(finishDecisionAttemptStream(run, at(4)), run);
});

test("a second frame fails the attempt rather than breaking the one-frame trace rule", () => {
  const { run: started } = begun();
  const events = successEvents();
  const run = applyAll(started, [events[0]!, events[1]!, events[2]!, events[2]!], at(2));

  assert.equal(run.status.kind, "failed");
  assert.match(run.attempts[0]!.error!.message, /more than one frame/);
  assert.equal(run.exchanges[run.attempts[0]!.exchangeId]!.frames.length, 1);
  assertSavable(run);
});

test("events are refused once the attempt has settled", () => {
  const { run: started } = begun();
  const completed = applyAll(started, successEvents(), at(2));
  assert.throws(
    () => applyDecisionEvent(completed, { type: "frame", frame: { index: 0, raw: "{}" } }, at(3)),
    /running/,
  );
});

test("the retry wait follows the 429's headers, from the batch rules", () => {
  const { run: started } = begun();
  const now = Date.parse(at(2));
  const paused = applyAll(started, rateLimitedEvents({ "Retry-After": "1" }), at(2));
  assert.equal(decisionRetryWaitMs(paused, now), 1_000);

  const unnamed = applyAll(begun().run, rateLimitedEvents({}), at(2));
  assert.equal(decisionRetryWaitMs(unnamed, now), DEFAULT_RATE_LIMIT_PAUSE_MS);
});

test("only a paused 429 has a retry wait", () => {
  const now = Date.parse(at(2));
  const serverError: RunError = { code: "provider_error", message: "down", retryable: true, providerStatus: 503 };
  const { run: started } = begun();
  const paused503 = applyAll(started, [
    { type: "response_started", response: { status: 503, headers: { "retry-after": "9" } } },
    { type: "failed", error: serverError },
  ], at(2));
  assert.equal(paused503.status.kind, "paused");
  assert.equal(decisionRetryWaitMs(paused503, now), undefined);

  const stopped = stopDecisionRun(applyAll(begun().run, rateLimitedEvents({ "retry-after": "1" }), at(2)), at(3));
  assert.equal(decisionRetryWaitMs(stopped, now), undefined);
});

async function* stream(events: DecisionTransportEvent[], beforeEach?: (index: number) => void) {
  for (const [index, event] of events.entries()) {
    beforeEach?.(index);
    yield event;
  }
}

test("the driver folds a host's events into the run and reports each change", async () => {
  const { run, execution } = begun();
  const seen: string[] = [];
  const outcome = await driveDecisionAttempt({
    run,
    execution,
    open: async (sent) => {
      assert.equal(sent, execution);
      return stream(successEvents());
    },
    signal: new AbortController().signal,
    now: () => at(2),
    onRunChange: (next) => seen.push(next.status.kind),
  });

  assert.equal(outcome.outcome, "settled");
  assert.equal(outcome.run.status.kind, "completed");
  assert.deepEqual(seen, ["running", "running", "running", "completed"]);
});

test("the driver fails an attempt whose stream ends early", async () => {
  const { run, execution } = begun();
  const outcome = await driveDecisionAttempt({
    run,
    execution,
    open: async () => stream(successEvents().slice(0, 2)),
    signal: new AbortController().signal,
    now: () => at(2),
  });
  assert.equal(outcome.run.status.kind, "failed");
  assert.equal(outcome.run.attempts[0]!.error!.code, "protocol_error");
});

test("the driver maps a thrown error by its status, as chat's driver does", async () => {
  const cases: Array<[unknown, string, RunError["code"]]> = [
    [Object.assign(new Error("Service unavailable"), { status: 503 }), "paused", "transport_error"],
    [Object.assign(new Error("Rate limited"), { status: 429 }), "paused", "transport_error"],
    [new Error("Network down"), "paused", "transport_error"],
    [Object.assign(new Error("Bad request"), { status: 400 }), "failed", "transport_error"],
    [new SyntaxError("Unexpected token"), "failed", "protocol_error"],
  ];
  for (const [thrown, kind, code] of cases) {
    const { run, execution } = begun();
    const outcome = await driveDecisionAttempt({
      run,
      execution,
      open: async () => { throw thrown; },
      signal: new AbortController().signal,
      now: () => at(2),
    });
    assert.equal(outcome.outcome, "settled");
    assert.equal(outcome.run.status.kind, kind, String(thrown));
    assert.equal(outcome.run.attempts[0]!.error!.code, code);
    assert.equal(outcome.run.attempts[0]!.error!.message, (thrown as Error).message);
  }
});

test("an aborted attempt is left to the caller's stop and applies nothing more", async () => {
  const { run, execution } = begun();
  const controller = new AbortController();
  const outcome = await driveDecisionAttempt({
    run,
    execution,
    open: async () => stream(successEvents(), (index) => {
      if (index === 2) controller.abort();
    }),
    signal: controller.signal,
    now: () => at(2),
  });

  assert.equal(outcome.outcome, "aborted");
  assert.equal(outcome.run.status.kind, "running");
  assert.deepEqual(outcome.run.exchanges[execution.exchangeId]!.frames, []);
});

test("an abort that rejects the open is aborted, not a failure", async () => {
  const { run, execution } = begun();
  const controller = new AbortController();
  controller.abort();
  const outcome = await driveDecisionAttempt({
    run,
    execution,
    open: async () => { throw new DOMException("aborted", "AbortError"); },
    signal: controller.signal,
    now: () => at(2),
  });
  assert.equal(outcome.outcome, "aborted");
  assert.equal(outcome.run, run);
});

test("a superseded attempt never reports a change, even a late completion", async () => {
  const { run, execution } = begun();
  let current = true;
  const seen: DecisionRun[] = [];
  const outcome = await driveDecisionAttempt({
    run,
    execution,
    open: async () => stream(successEvents(), (index) => {
      if (index === 1) current = false;
    }),
    signal: new AbortController().signal,
    isCurrent: () => current,
    now: () => at(2),
    onRunChange: (next) => seen.push(next),
  });

  assert.equal(outcome.outcome, "superseded");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.status.kind, "running");
});
