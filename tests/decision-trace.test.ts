import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  DecisionAttempt,
  DecisionExchangeTrace,
  DecisionInput,
  DecisionRun,
  ResolvedDecisionRunInput,
} from "../packages/core/src/decision.ts";
import {
  decisionRunFromTrace,
  decisionRunTrace,
} from "../packages/core/src/decision-trace.ts";
import type { DecisionRunTrace } from "../packages/core/src/decision-trace.ts";
import { loadRunHistoryFiles } from "../packages/core/src/run-history.ts";
import { createEntityId } from "../packages/core/src/run-kernel/index.ts";
import type { ExchangeId, JsonObject, RunError } from "../packages/core/src/run-kernel/index.ts";
import {
  parseRunTraceFile,
  parseSavedRunTrace,
  parseSavedRunTraceJson,
  RunTraceValidationError,
  serializeDecisionRunTrace,
} from "../packages/core/src/run-trace.ts";
import { systemOneAdapter } from "../packages/core/src/system-one.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

interface WireFixture {
  request: JsonObject & DecisionInput & { model: string };
  response: { status: number; body: JsonObject };
}

function fixture(name: string): WireFixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/system-one/${name}.json`, import.meta.url), "utf8"),
  ) as WireFixture;
}

const allTypes = fixture("llamacpp-all-types");
const runId = createEntityId("run", "decision-trace");
const startedAt = "2026-10-24T12:00:00.000Z";
const endedAt = "2026-10-24T12:00:01.250Z";

function runInput(request = allTypes.request): ResolvedDecisionRunInput {
  const { model, state, questions } = request;
  return {
    runId,
    resolvedAt: startedAt,
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

function exchangeId(attempt: number): ExchangeId {
  return createEntityId("exchange", `decision-trace_${attempt}`);
}

function exchange(attempt: number, status: number, raw: string): DecisionExchangeTrace {
  return {
    exchangeId: exchangeId(attempt),
    attempt,
    request: {
      url: "https://llm.example.test/v1/systemone",
      method: "POST",
      headers: { authorization: "Bearer ••••••••", "content-type": "application/json" },
      body: JSON.stringify(allTypes.request),
    },
    response: { status, headers: { "content-type": "application/json" } },
    frames: [{ index: 0, raw }],
  };
}

const rateLimited: RunError = {
  code: "provider_error",
  message: "slow down",
  providerStatus: 429,
  retryable: true,
};

function completedAttempt(attempt: number, input = runInput()): DecisionAttempt {
  return {
    attempt,
    exchangeId: exchangeId(attempt),
    status: "completed",
    result: systemOneAdapter.normalizeResponse(input, JSON.stringify(allTypes.response.body)),
  };
}

function failedAttempt(attempt: number): DecisionAttempt {
  return { attempt, exchangeId: exchangeId(attempt), status: "failed", error: rateLimited };
}

function completedTrace(): DecisionRunTrace {
  return {
    schemaVersion: 8,
    kind: "decision",
    runId,
    input: runInput(),
    status: { kind: "completed", completedAt: endedAt },
    attempts: [completedAttempt(1)],
    exchanges: {
      [exchangeId(1)]: exchange(1, 200, JSON.stringify(allTypes.response.body)),
    },
    startedAt,
    endedAt,
  };
}

/** A 429, then a retry of the same input that completed. */
function retriedTrace(): DecisionRunTrace {
  const trace = completedTrace();
  return {
    ...trace,
    attempts: [failedAttempt(1), completedAttempt(2)],
    exchanges: {
      [exchangeId(1)]: exchange(1, 429, "slow down"),
      [exchangeId(2)]: exchange(2, 200, JSON.stringify(allTypes.response.body)),
    },
  };
}

function roundTrip(trace: DecisionRunTrace): DecisionRunTrace {
  const saved = parseSavedRunTraceJson(serializeDecisionRunTrace(trace));
  assert.equal(saved.kind, "decision");
  return saved.trace as DecisionRunTrace;
}

test("a completed decision run saves as schema 8 and reopens as stored", () => {
  const trace = completedTrace();
  const serialized = serializeDecisionRunTrace(trace);
  assert.match(serialized, /"schemaVersion": 8/);
  assert.match(serialized, /"kind": "decision"/);
  assert.deepEqual(roundTrip(trace), trace);
  // Deterministic: writing what was read writes the same bytes.
  assert.equal(serializeDecisionRunTrace(roundTrip(trace)), serialized);
});

test("authored question, option, and answer order survives saving", () => {
  const serialized = serializeDecisionRunTrace(completedTrace());
  const reopened = parseSavedRunTraceJson(serialized).trace as DecisionRunTrace;
  const authored = Object.keys(allTypes.request.questions);
  // The fixture's authored order is not alphabetical, so sorting would show.
  assert.notDeepEqual(authored, [...authored].sort());
  assert.deepEqual(Object.keys(reopened.input.decision.questions), authored);
  assert.deepEqual(Object.keys(reopened.attempts[0]!.result!.answers), authored);
  const intent = allTypes.request.questions.intent!;
  assert.ok(intent.type === "choice");
  const reopenedIntent = reopened.input.decision.questions.intent!;
  assert.ok(reopenedIntent.type === "choice");
  assert.deepEqual(Object.keys(reopenedIntent.criteria), Object.keys(intent.criteria));
});

test("a caller-chosen __proto__ question id survives saving", () => {
  const questions = JSON.parse(
    `{"__proto__": {"type": "noul", "instructions": "Is this a test?"}}`,
  ) as DecisionInput["questions"];
  const input = runInput({ ...allTypes.request, questions });
  const result = systemOneAdapter.normalizeResponse(
    input,
    `{"answers": {"__proto__": {"type": "noul", "noul": 0.75}}}`,
  );
  const trace: DecisionRunTrace = {
    ...completedTrace(),
    input,
    attempts: [{ attempt: 1, exchangeId: exchangeId(1), status: "completed", result }],
  };
  const reopened = roundTrip(trace);
  assert.ok(Object.hasOwn(reopened.input.decision.questions, "__proto__"));
  assert.ok(Object.hasOwn(reopened.attempts[0]!.result!.answers, "__proto__"));
  assert.deepEqual(Object.values(reopened.attempts[0]!.result!.answers), [
    { type: "noul", noul: 0.75 },
  ]);
});

test("retried, stopped-while-waiting, and cancelled runs reopen as stored", () => {
  const retried = retriedTrace();
  assert.deepEqual(roundTrip(retried), retried);

  // Stop during a 429 wait: failed with that attempt's error (D23).
  const stopped: DecisionRunTrace = {
    ...completedTrace(),
    status: { kind: "failed", failedAt: endedAt, error: rateLimited },
    attempts: [failedAttempt(1)],
    exchanges: { [exchangeId(1)]: exchange(1, 429, "slow down") },
  };
  assert.deepEqual(roundTrip(stopped), stopped);

  // Stopped before dispatch: attempt 1 exists, its exchange has no evidence.
  const cancelled: DecisionRunTrace = {
    ...completedTrace(),
    status: { kind: "cancelled", cancelledAt: endedAt, reason: "Stopped by user." },
    attempts: [{ attempt: 1, exchangeId: exchangeId(1), status: "cancelled" }],
    exchanges: { [exchangeId(1)]: { exchangeId: exchangeId(1), attempt: 1, frames: [] } },
  };
  assert.deepEqual(roundTrip(cancelled), cancelled);
});

test("a terminal decision run converts to a trace and back", () => {
  const trace = retriedTrace();
  const run = decisionRunFromTrace(trace);
  assert.equal(run.kind, "decision");
  assert.deepEqual(run.status, trace.status);
  assert.deepEqual(run.attempts, trace.attempts);
  assert.deepEqual(decisionRunTrace(run), trace);

  const running: DecisionRun = {
    ...run,
    status: { kind: "running", attempt: 2, exchangeId: exchangeId(2) },
  };
  assert.throws(() => decisionRunTrace(running), /only a finished decision run/i);
});

type Mutation = (trace: DecisionRunTrace & Record<string, unknown>) => unknown;

function rejects(name: string, mutate: Mutation, pattern: RegExp, base = retriedTrace) {
  test(`a decision trace with ${name} is rejected`, () => {
    const trace = structuredClone(base()) as DecisionRunTrace & Record<string, unknown>;
    mutate(trace);
    assert.throws(
      () => parseSavedRunTrace(trace),
      (error: unknown) => error instanceof RunTraceValidationError && pattern.test(error.message),
    );
  });
}

rejects("attempt numbers that skip", (trace) => {
  trace.attempts[1]!.attempt = 3;
  trace.exchanges[exchangeId(2)]!.attempt = 3;
}, /attempts\.1.*attempt 2/);
rejects("an attempt whose exchange is missing", (trace) => {
  delete trace.exchanges[exchangeId(2)];
}, /attempts\.1.*exchange/);
rejects("two attempts sharing an exchange", (trace) => {
  trace.attempts[1]!.exchangeId = exchangeId(1);
}, /attempts\.1.*exchange/);
rejects("an exchange no attempt made", (trace) => {
  const extra = createEntityId("exchange", "stray");
  trace.exchanges[extra] = { exchangeId: extra, attempt: 3, frames: [] };
}, /exchanges.*stray/);
rejects("an exchange stored under another id", (trace) => {
  trace.exchanges[exchangeId(2)]!.exchangeId = exchangeId(1);
}, /exchanges.*exchangeId/);
rejects("an exchange for another attempt", (trace) => {
  trace.exchanges[exchangeId(2)]!.attempt = 1;
}, /exchanges.*attempt/);
rejects("an exchange with two frames", (trace) => {
  trace.exchanges[exchangeId(2)]!.frames.push({ index: 1, raw: "{}" });
}, /exchanges.*frames/);
rejects("a completed attempt that is not the last", (trace) => {
  trace.attempts.reverse();
  trace.attempts[0]!.attempt = 1;
  trace.attempts[1]!.attempt = 2;
}, /attempts\.0/);
rejects("a status that disagrees with the last attempt", (trace) => {
  trace.status = { kind: "failed", failedAt: endedAt, error: rateLimited };
}, /status/);
rejects("a failed status whose error is not the last attempt's", (trace) => {
  trace.attempts = [trace.attempts[0]!];
  delete trace.exchanges[exchangeId(2)];
  trace.status = {
    kind: "failed",
    failedAt: endedAt,
    error: { ...rateLimited, message: "something else" },
  };
}, /status\.error/);
rejects("a completed attempt without a result", (trace) => {
  delete trace.attempts[1]!.result;
}, /attempts\.1.*result/);
rejects("an answer missing for an asked question", (trace) => {
  delete trace.attempts[1]!.result!.answers.intent;
}, /attempts\.1\.result\.answers.*intent/);
rejects("an answer for a question that was not asked", (trace) => {
  trace.attempts[1]!.result!.answers.tone = { type: "noul", noul: 0.5 };
}, /attempts\.1\.result\.answers.*tone/);
rejects("an answer of another type than its question", (trace) => {
  trace.attempts[1]!.result!.answers.intent = { type: "noul", noul: 0.5 };
}, /attempts\.1\.result\.answers\.intent/);
rejects("a failed attempt without an error", (trace) => {
  delete trace.attempts[0]!.error;
}, /attempts\.0.*error/);
rejects("a running attempt", (trace) => {
  trace.attempts[1]!.status = "running" as DecisionAttempt["status"];
}, /attempts\.1\.status/);
rejects("no attempts", (trace) => {
  trace.attempts = [];
  trace.exchanges = {};
}, /attempts/);
rejects("a status time other than its end time", (trace) => {
  trace.status = { kind: "completed", completedAt: startedAt };
}, /status.*endedAt/);
rejects("an input for another run", (trace) => {
  trace.input.runId = createEntityId("run", "other");
}, /input\.runId/);
rejects("an input that is not a decision request", (trace) => {
  trace.input.decision.questions = {};
}, /input\.decision/);
rejects("an unknown root field", (trace) => {
  trace.events = [];
}, /events|unrecognized/i);
rejects("a schema version below 8", (trace) => {
  trace.schemaVersion = 7 as 8;
}, /schemaVersion/);
rejects("an unknown kind", (trace) => {
  trace.kind = "evaluation" as "decision";
}, /kind/);

test("the chat-only parser refuses a decision trace in words a person can act on", () => {
  assert.throws(
    () => parseRunTraceFile(completedTrace()),
    (error: unknown) =>
      error instanceof RunTraceValidationError &&
      /decision run/i.test(error.message) &&
      !/Invalid run trace at/.test(error.message),
  );
});

test("history lists a decision run with its kind, model, question count, and status", () => {
  const trace = retriedTrace();
  const { items, failures } = loadRunHistoryFiles([
    { fileName: `${runId}.json`, contents: serializeDecisionRunTrace(trace) },
  ]);
  assert.deepEqual(failures, []);
  assert.deepEqual(items, [
    {
      fileName: `${runId}.json`,
      summary: {
        kind: "decision",
        runId,
        startedAt,
        endedAt,
        status: "completed",
        model: allTypes.request.model,
        protocol: "systemone",
        questionCount: Object.keys(allTypes.request.questions).length,
        attemptCount: 2,
        durationMs: 1_250,
      },
    },
  ]);
});
