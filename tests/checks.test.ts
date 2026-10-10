import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckValidationError,
  checkOutcomeSummary,
  evaluateCheck,
  evaluateChecks,
  parseCheckDefinition,
  parseCheckDefinitions,
  runCheckSubject,
} from "../packages/core/src/checks.ts";
import type {
  CheckDefinition,
  CheckOutcome,
} from "../packages/core/src/checks.ts";
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
  RunId,
  RunState,
  RunTokenUsage,
} from "../packages/core/src/run-kernel/index.ts";
import { finalAssistantOutput } from "../packages/core/src/run-output.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, keyof RunEventMetadata>
    : never
  : never;

const runId = createEntityId("run", "checks");
const turnId = createEntityId("turn", "first");
const secondTurnId = createEntityId("turn", "second");
const exchangeId = createEntityId("exchange", "first");
const retryExchangeId = createEntityId("exchange", "retry");
const secondExchangeId = createEntityId("exchange", "second");
const toolCallId = createEntityId("tool-call", "lookup");

const turnInput: ProviderTurnInput = {
  target: {
    profileId: createEntityId("profile", "openai"),
    protocol: "openai-compatible-chat-completions",
    endpoint: "https://api.example.com/v1",
    model: "example-model",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  messages: [
    {
      id: createEntityId("message", "user"),
      role: "user",
      content: [{ type: "text", text: "Answer" }],
    },
  ],
  responseMode: "streaming",
  options: {},
  tools: [],
};

const resolvedInput: ResolvedRunInput = {
  runId,
  conversationId: createEntityId("conversation", "checks"),
  conversationRevisionId: createEntityId("revision", "checks"),
  ...turnInput,
  templateResolutions: [],
  resolvedAt: "2026-07-31T12:00:00.000Z",
};

const request = {
  url: "https://api.example.com/v1/chat/completions",
  method: "POST",
  headers: { authorization: "Bearer ••••••••" },
  body: '{"model":"example-model"}',
};

/**
 * Builds events with an explicit elapsed stamp so duration assertions are
 * exact. Checks only read the derived metric, so supplying the stamp directly
 * keeps these tests free of timers.
 */
function eventStream(id: RunId) {
  let sequence = 0;
  return function next(elapsedMs: number, payload: RunEventPayload): RunEvent {
    const current = sequence++;
    return {
      eventId: createEntityId("event", String(current)),
      runId: id,
      sequence: current,
      occurredAt: new Date(
        Date.parse("2026-07-31T12:00:00.000Z") + elapsedMs,
      ).toISOString(),
      elapsedMs,
      ...payload,
    } as RunEvent;
  };
}

function reduceAll(events: RunEvent[]): RunState {
  return events.reduce(reduceRunEvent, createRunState(runId));
}

interface CompletedRunOptions {
  /** Omit to model a turn that completed without emitting any text. */
  text?: string;
  usage?: RunTokenUsage;
  endedAtMs?: number;
}

function completedRun(options: CompletedRunOptions = {}): RunState {
  const { text, usage, endedAtMs = 1000 } = options;
  const next = eventStream(runId);
  return reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, { type: "turn.started", turnId, attempt: 1, exchangeId, input: turnInput }),
    next(10, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    ...(text === undefined
      ? []
      : [next(100, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text })]),
    ...(usage
      ? [next(900, { type: "usage.reported", turnId, attempt: 1, exchangeId, usage })]
      : []),
    next(900, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(endedAtMs, { type: "run.completed" }),
  ]);
}

function failedRun(): RunState {
  const next = eventStream(runId);
  return reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, { type: "turn.started", turnId, attempt: 1, exchangeId, input: turnInput }),
    next(10, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(50, {
      type: "run.failed",
      error: { code: "provider_error", message: "Bad request.", providerStatus: 400 },
    }),
  ]);
}

function cancelledRun(): RunState {
  const next = eventStream(runId);
  return reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, { type: "turn.started", turnId, attempt: 1, exchangeId, input: turnInput }),
    next(10, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(100, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Partial" }),
    next(150, { type: "run.cancelled", reason: "Stopped by the user." }),
  ]);
}

/** A retried turn: the failed attempt's partial text must never be the answer. */
function retriedRun(
  usage: { first?: RunTokenUsage; retry?: RunTokenUsage } = {},
): RunState {
  const next = eventStream(runId);
  return reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, { type: "turn.started", turnId, attempt: 1, exchangeId, input: turnInput }),
    next(10, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(20, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "Half" }),
    ...(usage.first
      ? [
          next(25, {
            type: "usage.reported",
            turnId,
            attempt: 1,
            exchangeId,
            usage: usage.first,
          }),
        ]
      : []),
    next(30, {
      type: "turn.attempt_failed",
      turnId,
      attempt: 1,
      exchangeId,
      error: { code: "transport_error", message: "Connection reset.", retryable: true },
    }),
    next(40, { type: "turn.attempt_started", turnId, attempt: 2, exchangeId: retryExchangeId }),
    next(50, {
      type: "exchange.requested",
      turnId,
      attempt: 2,
      exchangeId: retryExchangeId,
      request,
    }),
    next(60, {
      type: "assistant.text_delta",
      turnId,
      attempt: 2,
      exchangeId: retryExchangeId,
      text: "Whole answer",
    }),
    ...(usage.retry
      ? [
          next(190, {
            type: "usage.reported",
            turnId,
            attempt: 2,
            exchangeId: retryExchangeId,
            usage: usage.retry,
          }),
        ]
      : []),
    next(200, {
      type: "assistant.completed",
      turnId,
      attempt: 2,
      exchangeId: retryExchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(220, { type: "run.completed" }),
  ]);
}

/** A tool turn followed by the answering turn. */
function multiTurnRun(): RunState {
  const next = eventStream(runId);
  return reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, { type: "turn.started", turnId, attempt: 1, exchangeId, input: turnInput }),
    next(10, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(20, {
      type: "assistant.text_delta",
      turnId,
      attempt: 1,
      exchangeId,
      text: "Looking that up",
    }),
    next(30, {
      type: "assistant.tool_call_delta",
      turnId,
      attempt: 1,
      exchangeId,
      toolCallId,
      index: 0,
      nameDelta: "lookup",
      argumentsDelta: '{"city":"Oslo"}',
    }),
    next(40, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "tool_calls", raw: "tool_calls" },
    }),
    next(50, {
      type: "tool.result_supplied",
      turnId,
      result: {
        id: createEntityId("tool-result", "lookup"),
        toolCallId,
        content: [{ type: "text", text: "4 degrees" }],
        resolution: { kind: "manual" },
      },
    }),
    next(60, {
      type: "turn.started",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      input: turnInput,
    }),
    next(70, {
      type: "exchange.requested",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      request,
    }),
    next(80, {
      type: "assistant.text_delta",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      text: "It is 4 degrees in Oslo.",
    }),
    next(90, {
      type: "assistant.completed",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(100, { type: "run.completed" }),
  ]);
}

/**
 * One turn making three calls — two to the same tool, one with malformed
 * (non-JSON-object) arguments — followed by an answering turn.
 */
function multiCallRun(): RunState {
  const next = eventStream(runId);
  const callA = createEntityId("tool-call", "lookup-a");
  const callB = createEntityId("tool-call", "lookup-b");
  const callC = createEntityId("tool-call", "notify");
  return reduceAll([
    next(0, { type: "run.started", input: resolvedInput }),
    next(0, { type: "turn.started", turnId, attempt: 1, exchangeId, input: turnInput }),
    next(10, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request }),
    next(20, {
      type: "assistant.tool_call_delta",
      turnId,
      attempt: 1,
      exchangeId,
      toolCallId: callA,
      index: 0,
      nameDelta: "lookup",
      argumentsDelta: '{"city":"Oslo"}',
    }),
    next(21, {
      type: "assistant.tool_call_delta",
      turnId,
      attempt: 1,
      exchangeId,
      toolCallId: callB,
      index: 1,
      nameDelta: "lookup",
      argumentsDelta: "not json",
    }),
    next(22, {
      type: "assistant.tool_call_delta",
      turnId,
      attempt: 1,
      exchangeId,
      toolCallId: callC,
      index: 2,
      nameDelta: "notify",
      argumentsDelta: '{"city":"Oslo","urgent":true}',
    }),
    next(30, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "tool_calls", raw: "tool_calls" },
    }),
    ...[callA, callB, callC].map((id, index) =>
      next(40 + index, {
        type: "tool.result_supplied" as const,
        turnId,
        result: {
          id: createEntityId("tool-result", `result-${index}`),
          toolCallId: id,
          content: [{ type: "text" as const, text: "ok" }],
          resolution: { kind: "manual" as const },
        },
      }),
    ),
    next(60, {
      type: "turn.started",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      input: turnInput,
    }),
    next(70, {
      type: "exchange.requested",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      request,
    }),
    next(80, {
      type: "assistant.text_delta",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      text: "Done.",
    }),
    next(90, {
      type: "assistant.completed",
      turnId: secondTurnId,
      attempt: 1,
      exchangeId: secondExchangeId,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next(100, { type: "run.completed" }),
  ]);
}

/** A terminal run whose evidence contains no completed assistant attempt. */
function completedWithoutOutput(): RunState {
  return {
    runId,
    input: resolvedInput,
    status: { kind: "completed", completedAt: "2026-07-31T12:00:01.000Z" },
    events: [],
    turns: [],
    exchanges: {},
    toolExecutions: [],
    toolResults: [],
    lastSequence: 0,
    startedAt: "2026-07-31T12:00:00.000Z",
    endedAt: "2026-07-31T12:00:01.000Z",
  };
}

/** Omit distributes over the union so each kind keeps its own parameters. */
type UnnamedCheck = CheckDefinition extends infer Definition
  ? Definition extends CheckDefinition
    ? Omit<Definition, "checkId">
    : never
  : never;

function outcomeFor(state: RunState, definition: UnnamedCheck): CheckOutcome {
  return evaluateCheck(
    { checkId: createEntityId("check", "one"), ...definition } as CheckDefinition,
    runCheckSubject(state),
  );
}

function evidenceOf(outcome: CheckOutcome): unknown {
  return outcome.status === "not-evaluated" ? undefined : outcome.evidence;
}

test("projects one canonical answer across retries and turns", () => {
  assert.equal(finalAssistantOutput(retriedRun()), "Whole answer");
  assert.equal(finalAssistantOutput(multiTurnRun()), "It is 4 degrees in Oslo.");
  assert.equal(finalAssistantOutput(completedRun({ text: "Hi" })), "Hi");
  assert.equal(finalAssistantOutput(completedWithoutOutput()), undefined);

  // An empty answer is a real answer; a missing one is not.
  assert.equal(finalAssistantOutput(completedRun()), "");
});

test("separates run failure from assertion failure", () => {
  const definition = { kind: "contains", value: "hello" } as const;

  const failed = outcomeFor(failedRun(), definition);
  assert.equal(failed.status, "not-evaluated");
  assert.match(
    failed.status === "not-evaluated" ? failed.reason : "",
    /run failed \(provider_error\)/,
  );

  const cancelled = outcomeFor(cancelledRun(), definition);
  assert.equal(cancelled.status, "not-evaluated");
  assert.match(
    cancelled.status === "not-evaluated" ? cancelled.reason : "",
    /cancelled/,
  );

  // A cancelled run streamed real text and elapsed real time; neither may be
  // reported as a satisfied assertion.
  assert.equal(
    outcomeFor(cancelledRun(), { kind: "contains", value: "Partial" }).status,
    "not-evaluated",
  );
  assert.equal(
    outcomeFor(cancelledRun(), { kind: "max-duration-ms", limit: 5000 }).status,
    "not-evaluated",
  );
});

test("reports a completed run with no assistant output as undecidable", () => {
  const state = completedWithoutOutput();
  for (const definition of [
    { kind: "exact-match", value: "" },
    { kind: "contains", value: "a" },
    { kind: "regex", syntax: "re2", pattern: "a" },
    { kind: "valid-json" },
    { kind: "max-output-characters", limit: 10 },
  ] as const) {
    const result = outcomeFor(state, definition);
    assert.equal(result.status, "not-evaluated", definition.kind);
    assert.match(
      result.status === "not-evaluated" ? result.reason : "",
      /no final assistant output/,
    );
  }
});

test("evaluates an empty answer instead of treating it as missing", () => {
  const state = completedRun();
  assert.equal(outcomeFor(state, { kind: "exact-match", value: "" }).status, "passed");
  assert.equal(outcomeFor(state, { kind: "contains", value: "x" }).status, "failed");
  assert.equal(
    outcomeFor(state, { kind: "max-output-characters", limit: 0 }).status,
    "passed",
  );
  assert.deepEqual(
    evidenceOf(outcomeFor(state, { kind: "max-output-characters", limit: 0 })),
    { characters: 0, limit: 0 },
  );
});

test("compares text strictly unless the definition says otherwise", () => {
  const state = completedRun({ text: "  Yes  " });

  assert.equal(outcomeFor(state, { kind: "exact-match", value: "Yes" }).status, "failed");
  assert.equal(
    outcomeFor(state, { kind: "exact-match", value: "Yes", trimWhitespace: true }).status,
    "passed",
  );
  assert.equal(
    outcomeFor(state, {
      kind: "exact-match",
      value: "yes",
      trimWhitespace: true,
    }).status,
    "failed",
  );
  assert.equal(
    outcomeFor(state, {
      kind: "exact-match",
      value: "yes",
      trimWhitespace: true,
      caseSensitive: false,
    }).status,
    "passed",
  );
});

test("reports measurement evidence and never copies the answer", () => {
  const state = completedRun({ text: "Total: 42 units" });

  const contains = outcomeFor(state, { kind: "contains", value: "42" });
  assert.equal(contains.status, "passed");
  assert.deepEqual(contains.evidence, {
    found: true,
    characters: 15,
    expectedCharacters: 2,
    index: 7,
  });

  const missing = outcomeFor(state, { kind: "contains", value: "43" });
  assert.equal(missing.status, "failed");
  assert.deepEqual(missing.evidence, {
    found: false,
    characters: 15,
    expectedCharacters: 2,
  });
  assert.equal(
    missing.status === "failed" ? missing.message : "",
    "Final assistant output did not contain the expected text.",
  );

  const exact = outcomeFor(state, { kind: "exact-match", value: "Total: 43 units" });
  assert.equal(exact.status, "failed");
  assert.deepEqual(evidenceOf(exact), {
    equal: false,
    characters: 15,
    expectedCharacters: 15,
    firstDifferenceIndex: 8,
  });

  const serialized = JSON.stringify([contains, missing, exact]);
  assert.ok(!serialized.includes("Total"), serialized);
  assert.ok(!serialized.includes("units"), serialized);
});

test("counts astral characters and positions once", () => {
  const state = completedRun({ text: "👋 hello 🌍" });

  assert.deepEqual(
    evidenceOf(outcomeFor(state, { kind: "max-output-characters", limit: 9 })),
    { characters: 9, limit: 9 },
  );
  assert.deepEqual(
    evidenceOf(outcomeFor(state, { kind: "contains", value: "🌍" })),
    { found: true, characters: 9, expectedCharacters: 1, index: 8 },
  );
  assert.deepEqual(
    evidenceOf(outcomeFor(state, { kind: "regex", syntax: "re2", pattern: "hello" })),
    { matched: true, characters: 9, index: 2, matchedCharacters: 5 },
  );
});

test("asserts the opposite predicate when a check is negated", () => {
  const state = completedRun({ text: "no comment" });

  const absent = outcomeFor(state, { kind: "contains", value: "error", negate: true });
  assert.equal(absent.status, "passed");

  const present = outcomeFor(state, { kind: "contains", value: "comment", negate: true });
  assert.equal(present.status, "failed");
  assert.equal(
    present.status === "failed" ? present.message : "",
    "Final assistant output contained text it must not contain.",
  );

  assert.equal(
    outcomeFor(state, { kind: "regex", syntax: "re2", pattern: "^ERROR", negate: true }).status,
    "passed",
  );
  assert.equal(
    outcomeFor(state, { kind: "exact-match", value: "no comment", negate: true }).status,
    "failed",
  );
  assert.equal(outcomeFor(state, { kind: "valid-json", negate: true }).status, "passed");
});

test("evaluates Safe regex with bounded, stateless flags", () => {
  const state = completedRun({ text: "Line one\nLine two" });

  assert.equal(
    outcomeFor(state, { kind: "regex", syntax: "re2", pattern: "^line", flags: "im" }).status,
    "passed",
  );
  assert.equal(outcomeFor(state, { kind: "regex", syntax: "re2", pattern: "^line" }).status, "failed");
  assert.equal(
    outcomeFor(state, { kind: "regex", syntax: "re2", pattern: "one.Line", flags: "s" }).status,
    "passed",
  );

  // A definition that never went through the parser must not throw at
  // evaluation time; it is simply undecidable.
  const invalid = outcomeFor(state, { kind: "regex", syntax: "re2", pattern: "(unclosed" });
  assert.equal(invalid.status, "not-evaluated");
  assert.match(
    invalid.status === "not-evaluated" ? invalid.reason : "",
    /valid RE2-compatible Safe regex syntax/,
  );
  assert.equal(
    outcomeFor(state, { kind: "regex", syntax: "re2", pattern: "Line", flags: "g" }).status,
    "not-evaluated",
  );
});

test("requires strict JSON and the requested top-level shape", () => {
  const object = completedRun({ text: '{"answer": 42}' });
  const array = completedRun({ text: "[1, 2, 3]" });
  const fenced = completedRun({ text: '```json\n{"answer": 42}\n```' });
  const scalar = completedRun({ text: "42" });

  assert.equal(outcomeFor(object, { kind: "valid-json" }).status, "passed");
  assert.deepEqual(evidenceOf(outcomeFor(object, { kind: "valid-json" })), {
    valid: true,
    characters: 14,
    topLevel: "object",
  });
  assert.equal(
    outcomeFor(object, { kind: "valid-json", topLevel: "array" }).status,
    "failed",
  );
  assert.equal(
    outcomeFor(array, { kind: "valid-json", topLevel: "array" }).status,
    "passed",
  );
  assert.equal(
    outcomeFor(scalar, { kind: "valid-json", topLevel: "object" }).status,
    "failed",
  );
  assert.equal(outcomeFor(scalar, { kind: "valid-json" }).status, "passed");

  // Markdown fences are not unwrapped in v1; the answer is checked as written.
  const malformed = outcomeFor(fenced, { kind: "valid-json" });
  assert.equal(malformed.status, "failed");
  assert.deepEqual(malformed.evidence, { valid: false, characters: 26 });
  assert.ok(!JSON.stringify(malformed).includes("answer"));
});

test("treats every maximum as inclusive at its exact edge", () => {
  const state = completedRun({
    text: "12345",
    usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    endedAtMs: 1000,
  });

  assert.equal(outcomeFor(state, { kind: "max-output-characters", limit: 5 }).status, "passed");
  assert.equal(outcomeFor(state, { kind: "max-output-characters", limit: 4 }).status, "failed");
  assert.equal(outcomeFor(state, { kind: "max-duration-ms", limit: 1000 }).status, "passed");
  assert.equal(outcomeFor(state, { kind: "max-duration-ms", limit: 999 }).status, "failed");
  assert.equal(outcomeFor(state, { kind: "max-total-tokens", limit: 10 }).status, "passed");
  assert.equal(outcomeFor(state, { kind: "max-total-tokens", limit: 9 }).status, "failed");

  const failure = outcomeFor(state, { kind: "max-duration-ms", limit: 999 });
  assert.equal(
    failure.status === "failed" ? failure.message : "",
    "The run took 1000 ms; the maximum is 999 ms.",
  );
});

test("keeps unreported usage missing instead of scoring it as zero", () => {
  const state = completedRun({ text: "answer" });
  const outcome = outcomeFor(state, { kind: "max-total-tokens", limit: 0 });

  assert.equal(outcome.status, "not-evaluated");
  assert.match(
    outcome.status === "not-evaluated" ? outcome.reason : "",
    /did not report total tokens/,
  );
});

test("does not score a maximum token check from partial attempt usage", () => {
  const state = retriedRun({ first: { totalTokens: 100 } });
  const subject = runCheckSubject(state);
  const outcome = outcomeFor(state, { kind: "max-total-tokens", limit: 100 });

  assert.deepEqual(subject.totalTokenCoverage, {
    reportedAttempts: 1,
    totalAttempts: 2,
  });
  assert.equal(subject.reportedTotalTokens, undefined);
  assert.equal(outcome.status, "not-evaluated");
  assert.match(
    outcome.status === "not-evaluated" ? outcome.reason : "",
    /1 of 2 attempts/,
  );
});

test("scores a maximum token check when every provider attempt reports usage", () => {
  const state = retriedRun({
    first: { totalTokens: 40 },
    retry: { totalTokens: 60 },
  });

  assert.equal(
    outcomeFor(state, { kind: "max-total-tokens", limit: 100 }).status,
    "passed",
  );
  assert.equal(
    outcomeFor(state, { kind: "max-total-tokens", limit: 99 }).status,
    "failed",
  );
});

test("projects the retried turn's completed answer and the whole run's duration", () => {
  const state = retriedRun();
  const subject = runCheckSubject(state);

  assert.equal(subject.output, "Whole answer");
  assert.equal(subject.totalDurationMs, 220);
  assert.equal(subject.reportedTotalTokens, undefined);
});

test("evaluates a list once and retains authored order", () => {
  const state = completedRun({
    text: '{"ok": true}',
    usage: { totalTokens: 12 },
  });
  const definitions: CheckDefinition[] = [
    { checkId: createEntityId("check", "json"), kind: "valid-json", topLevel: "object" },
    { checkId: createEntityId("check", "length"), kind: "max-output-characters", limit: 4 },
    { checkId: createEntityId("check", "tokens"), kind: "max-total-tokens", limit: 12 },
  ];

  const results = evaluateChecks(state, definitions);
  assert.deepEqual(
    results.map(({ checkId, kind, outcome }) => [checkId, kind, outcome.status]),
    [
      ["check_json", "valid-json", "passed"],
      ["check_length", "max-output-characters", "failed"],
      ["check_tokens", "max-total-tokens", "passed"],
    ],
  );
  assert.deepEqual(checkOutcomeSummary(results), {
    total: 3,
    passed: 2,
    failed: 1,
    notEvaluated: 0,
  });

  const failedResults = evaluateChecks(failedRun(), definitions);
  assert.deepEqual(checkOutcomeSummary(failedResults), {
    total: 3,
    passed: 0,
    failed: 0,
    notEvaluated: 3,
  });
});

test("rejects unknown fields, unusable patterns, and repeated identities", () => {
  assert.deepEqual(
    parseCheckDefinition({
      checkId: "check_one",
      kind: "contains",
      value: "hello",
      caseSensitive: false,
    }),
    { checkId: "check_one", kind: "contains", value: "hello", caseSensitive: false },
  );

  assert.throws(
    () => parseCheckDefinition({ checkId: "check_one", kind: "contains", value: "a", extra: 1 }),
    CheckValidationError,
  );
  assert.throws(
    () => parseCheckDefinition({ checkId: "one", kind: "contains", value: "a" }),
    /safe check identifier/,
  );
  assert.throws(
    () => parseCheckDefinition({ checkId: "check_one", kind: "sentiment", value: "a" }),
    CheckValidationError,
  );
  assert.throws(
    () => parseCheckDefinition({ checkId: "check_one", kind: "regex", syntax: "re2", pattern: "(unclosed" }),
    /valid RE2-compatible Safe regex syntax/,
  );
  assert.throws(
    () =>
      parseCheckDefinition({
        checkId: "check_one",
        kind: "regex",
        syntax: "re2",
        pattern: "a",
        flags: "gi",
      }),
    /Safe regex flags must be a unique subset/,
  );
  assert.throws(
    () =>
      parseCheckDefinition({
        checkId: "check_one",
        kind: "max-total-tokens",
        limit: 10,
        negate: true,
      }),
    CheckValidationError,
  );
  assert.throws(
    () =>
      parseCheckDefinition({
        checkId: "check_one",
        kind: "contains",
        value: "a",
        limit: 3,
      }),
    CheckValidationError,
  );
  assert.throws(
    () =>
      parseCheckDefinitions([
        { checkId: "check_one", kind: "contains", value: "a" },
        { checkId: "check_one", kind: "valid-json" },
      ]),
    /repeat check_one/,
  );
});

test("matches called-tool and did-not-call-tool against any turn of the run", () => {
  const state = multiTurnRun();

  assert.equal(outcomeFor(state, { kind: "called-tool", toolName: "lookup" }).status, "passed");
  assert.equal(outcomeFor(state, { kind: "called-tool", toolName: "unused" }).status, "failed");
  assert.equal(outcomeFor(state, { kind: "did-not-call-tool", toolName: "lookup" }).status, "failed");
  assert.equal(outcomeFor(state, { kind: "did-not-call-tool", toolName: "unused" }).status, "passed");

  // A completed run with zero calls decides both directions; neither is undecidable.
  const noCalls = completedRun({ text: "Hi" });
  assert.equal(outcomeFor(noCalls, { kind: "called-tool", toolName: "lookup" }).status, "failed");
  assert.equal(outcomeFor(noCalls, { kind: "did-not-call-tool", toolName: "lookup" }).status, "passed");
});

test("counts repeated tool calls against a comparator", () => {
  const state = multiCallRun();

  assert.equal(
    outcomeFor(state, { kind: "tool-call-count", toolName: "lookup", count: 2, comparator: "exact" }).status,
    "passed",
  );
  assert.equal(
    outcomeFor(state, { kind: "tool-call-count", toolName: "lookup", count: 1, comparator: "at-least" }).status,
    "passed",
  );
  assert.equal(
    outcomeFor(state, { kind: "tool-call-count", toolName: "lookup", count: 1, comparator: "at-most" }).status,
    "failed",
  );
  // Omitted toolName counts every call in the run, not only one tool's.
  assert.equal(
    outcomeFor(state, { kind: "tool-call-count", count: 3, comparator: "exact" }).status,
    "passed",
  );

  const noCalls = completedRun({ text: "Hi" });
  assert.equal(
    outcomeFor(noCalls, { kind: "tool-call-count", count: 0, comparator: "exact" }).status,
    "passed",
  );
});

test("matches tool-call arguments by JSON subset, never by exact equality", () => {
  const state = multiCallRun();

  assert.equal(
    outcomeFor(state, { kind: "tool-call-arguments", toolName: "notify", argumentsSubset: { city: "Oslo" } }).status,
    "passed",
  );
  assert.equal(
    outcomeFor(state, { kind: "tool-call-arguments", toolName: "notify", argumentsSubset: { city: "Bergen" } }).status,
    "failed",
  );
  // A call with malformed (non-JSON-object) arguments can never satisfy an
  // arguments check, even when another call to the same tool would.
  assert.equal(
    outcomeFor(state, { kind: "tool-call-arguments", toolName: "lookup", argumentsSubset: { city: "Oslo" } }).status,
    "passed",
  );
  assert.equal(
    outcomeFor(state, { kind: "tool-call-arguments", toolName: "unused", argumentsSubset: {} }).status,
    "failed",
  );
});

test("tool-call checks never return not-evaluated for a completed run", () => {
  const state = completedRun({ text: "Hi" });
  for (const definition of [
    { kind: "called-tool", toolName: "lookup" },
    { kind: "did-not-call-tool", toolName: "lookup" },
    { kind: "tool-call-count", count: 0, comparator: "exact" },
    { kind: "tool-call-arguments", toolName: "lookup", argumentsSubset: {} },
  ] as const) {
    assert.notEqual(outcomeFor(state, definition).status, "not-evaluated", definition.kind);
  }

  // Run failure/cancellation is still undecidable, same as every other kind.
  assert.equal(
    outcomeFor(failedRun(), { kind: "called-tool", toolName: "lookup" }).status,
    "not-evaluated",
  );
});

/**
 * One tool-calling turn per entry, each followed by its results, then an
 * answering turn. Calls inside one entry share a turn, the way a provider's
 * parallel calls do.
 */
function toolTurnsRun(turns: ReadonlyArray<ReadonlyArray<{ name: string; arguments: string }>>): RunState {
  const next = eventStream(runId);
  const events: RunEvent[] = [next(0, { type: "run.started", input: resolvedInput })];
  let clock = 0;
  const turn = (index: number) => ({
    turnId: createEntityId("turn", `sequence-${index}`),
    exchangeId: createEntityId("exchange", `sequence-${index}`),
  });
  turns.forEach((calls, turnIndex) => {
    const { turnId: id, exchangeId: exchange } = turn(turnIndex);
    events.push(
      next((clock += 10), { type: "turn.started", turnId: id, attempt: 1, exchangeId: exchange, input: turnInput }),
      next((clock += 10), { type: "exchange.requested", turnId: id, attempt: 1, exchangeId: exchange, request }),
    );
    const callIds = calls.map((_, callIndex) => createEntityId("tool-call", `sequence-${turnIndex}-${callIndex}`));
    calls.forEach((call, callIndex) => {
      events.push(next((clock += 1), {
        type: "assistant.tool_call_delta",
        turnId: id,
        attempt: 1,
        exchangeId: exchange,
        toolCallId: callIds[callIndex]!,
        index: callIndex,
        nameDelta: call.name,
        argumentsDelta: call.arguments,
      }));
    });
    events.push(next((clock += 10), {
      type: "assistant.completed",
      turnId: id,
      attempt: 1,
      exchangeId: exchange,
      finishReason: { normalized: "tool_calls", raw: "tool_calls" },
    }));
    callIds.forEach((toolCallId, callIndex) => {
      events.push(next((clock += 1), {
        type: "tool.result_supplied",
        turnId: id,
        result: {
          id: createEntityId("tool-result", `sequence-${turnIndex}-${callIndex}`),
          toolCallId,
          content: [{ type: "text", text: "ok" }],
          resolution: { kind: "manual" },
        },
      }));
    });
  });
  const { turnId: last, exchangeId: lastExchange } = turn(turns.length);
  events.push(
    next((clock += 10), { type: "turn.started", turnId: last, attempt: 1, exchangeId: lastExchange, input: turnInput }),
    next((clock += 10), { type: "exchange.requested", turnId: last, attempt: 1, exchangeId: lastExchange, request }),
    next((clock += 10), { type: "assistant.text_delta", turnId: last, attempt: 1, exchangeId: lastExchange, text: "Done." }),
    next((clock += 10), {
      type: "assistant.completed",
      turnId: last,
      attempt: 1,
      exchangeId: lastExchange,
      finishReason: { normalized: "stop", raw: "stop" },
    }),
    next((clock += 10), { type: "run.completed" }),
  );
  return reduceAll(events);
}

test("projects the turn each tool call was made in", () => {
  const state = toolTurnsRun([
    [{ name: "search", arguments: "{}" }, { name: "lookup", arguments: "{}" }],
    [{ name: "book", arguments: "{}" }],
  ]);
  assert.deepEqual(
    runCheckSubject(state).toolCalls?.map(({ name, turnIndex }) => ({ name, turnIndex })),
    [
      { name: "search", turnIndex: 0 },
      { name: "lookup", turnIndex: 0 },
      { name: "book", turnIndex: 1 },
    ],
  );
});

test("a tool-call sequence requires each step in a later turn than the step before it", () => {
  const steps = [{ toolName: "search" }, { toolName: "book" }];
  const ordered = toolTurnsRun([
    [{ name: "search", arguments: '{"city":"Oslo"}' }],
    [{ name: "log", arguments: "{}" }],
    [{ name: "book", arguments: '{"city":"Oslo"}' }],
  ]);
  const passed = outcomeFor(ordered, { kind: "tool-call-sequence", steps });
  assert.equal(passed.status, "passed");
  assert.deepEqual(evidenceOf(passed), { steps: 2, matchedSteps: 2, matchedTurns: [0, 2] });

  // Emitted in emission order but in the same turn: the second call could not
  // have depended on the first one's result, so it is not "after" it.
  const parallel = toolTurnsRun([
    [{ name: "search", arguments: "{}" }, { name: "book", arguments: "{}" }],
  ]);
  const sameTurn = outcomeFor(parallel, { kind: "tool-call-sequence", steps });
  assert.equal(sameTurn.status, "failed");
  assert.deepEqual(evidenceOf(sameTurn), { steps: 2, matchedSteps: 1, matchedTurns: [0], firstUnmatchedStep: 2 });
  assert.equal(
    sameTurn.status === "failed" && sameTurn.message,
    'Step 2 (tool "book") was called, but not in a turn after step 1.',
  );

  const reversed = toolTurnsRun([
    [{ name: "book", arguments: "{}" }],
    [{ name: "search", arguments: "{}" }],
  ]);
  const backwards = outcomeFor(reversed, { kind: "tool-call-sequence", steps });
  assert.equal(backwards.status, "failed");
  assert.deepEqual(evidenceOf(backwards), { steps: 2, matchedSteps: 1, matchedTurns: [1], firstUnmatchedStep: 2 });

  const missing = outcomeFor(ordered, { kind: "tool-call-sequence", steps: [{ toolName: "cancel" }, { toolName: "book" }] });
  assert.equal(missing.status, "failed");
  assert.equal(missing.status === "failed" && missing.message, 'Step 1 (tool "cancel") was not called.');
  assert.deepEqual(evidenceOf(missing), { steps: 2, matchedSteps: 0, matchedTurns: [], firstUnmatchedStep: 1 });
});

test("a tool-call sequence matches each step at its earliest possible turn", () => {
  // Matching the first search at turn 2 would leave no later book; the
  // earliest-turn match at turn 0 is always at least as good.
  const state = toolTurnsRun([
    [{ name: "search", arguments: "{}" }],
    [{ name: "book", arguments: "{}" }],
    [{ name: "search", arguments: "{}" }],
  ]);
  assert.equal(
    outcomeFor(state, { kind: "tool-call-sequence", steps: [{ toolName: "search" }, { toolName: "book" }] }).status,
    "passed",
  );
  // A repeated step needs a second, later call.
  const twice = outcomeFor(state, {
    kind: "tool-call-sequence",
    steps: [{ toolName: "search" }, { toolName: "book" }, { toolName: "search" }],
  });
  assert.deepEqual(evidenceOf(twice), { steps: 3, matchedSteps: 3, matchedTurns: [0, 1, 2] });
});

test("a tool-call sequence step can require an arguments subset", () => {
  const state = toolTurnsRun([
    [{ name: "search", arguments: '{"city":"Bergen"}' }],
    [{ name: "search", arguments: '{"city":"Oslo","days":2}' }],
    [{ name: "book", arguments: '{"city":"Bergen"}' }],
    [{ name: "book", arguments: "not json" }],
  ]);
  const matching = outcomeFor(state, {
    kind: "tool-call-sequence",
    steps: [
      { toolName: "search", argumentsSubset: { city: "Oslo" } },
      { toolName: "book", argumentsSubset: { city: "Bergen" } },
    ],
  });
  assert.deepEqual(evidenceOf(matching), { steps: 2, matchedSteps: 2, matchedTurns: [1, 2] });

  const unmatched = outcomeFor(state, {
    kind: "tool-call-sequence",
    steps: [
      { toolName: "search", argumentsSubset: { city: "Oslo" } },
      { toolName: "book", argumentsSubset: { city: "Oslo" } },
    ],
  });
  assert.equal(unmatched.status, "failed");
  assert.equal(
    unmatched.status === "failed" && unmatched.message,
    'Step 2 (tool "book") was not called with arguments matching the expected subset.',
  );
});

test("a tool-call sequence is decidable for any completed run and parsed strictly", () => {
  assert.equal(
    outcomeFor(completedRun({ text: "Hi" }), { kind: "tool-call-sequence", steps: [{ toolName: "search" }] }).status,
    "failed",
  );
  assert.equal(
    outcomeFor(failedRun(), { kind: "tool-call-sequence", steps: [{ toolName: "search" }] }).status,
    "not-evaluated",
  );

  const valid = { checkId: "check_sequence", kind: "tool-call-sequence", steps: [{ toolName: "a" }, { toolName: "b", argumentsSubset: { x: 1 } }] };
  assert.deepEqual(parseCheckDefinition(valid), valid);
  assert.throws(() => parseCheckDefinition({ ...valid, steps: [] }), CheckValidationError);
  assert.throws(() => parseCheckDefinition({ ...valid, negate: true }), CheckValidationError);
  assert.throws(() => parseCheckDefinition({ ...valid, steps: [{ toolName: "a", extra: 1 }] }), CheckValidationError);
});
