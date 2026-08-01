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

/** A terminal run whose evidence contains no completed assistant attempt. */
function completedWithoutOutput(): RunState {
  return {
    runId,
    input: resolvedInput,
    status: { kind: "completed", completedAt: "2026-07-31T12:00:01.000Z" },
    events: [],
    turns: [],
    exchanges: {},
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
    { kind: "regex", pattern: "a" },
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
    evidenceOf(outcomeFor(state, { kind: "regex", pattern: "hello" })),
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
    outcomeFor(state, { kind: "regex", pattern: "^ERROR", negate: true }).status,
    "passed",
  );
  assert.equal(
    outcomeFor(state, { kind: "exact-match", value: "no comment", negate: true }).status,
    "failed",
  );
  assert.equal(outcomeFor(state, { kind: "valid-json", negate: true }).status, "passed");
});

test("evaluates regular expressions without stateful flags", () => {
  const state = completedRun({ text: "Line one\nLine two" });

  assert.equal(
    outcomeFor(state, { kind: "regex", pattern: "^line", flags: "im" }).status,
    "passed",
  );
  assert.equal(outcomeFor(state, { kind: "regex", pattern: "^line" }).status, "failed");
  assert.equal(
    outcomeFor(state, { kind: "regex", pattern: "one.Line", flags: "s" }).status,
    "passed",
  );

  // A definition that never went through the parser must not throw at
  // evaluation time; it is simply undecidable.
  const invalid = outcomeFor(state, { kind: "regex", pattern: "(unclosed" });
  assert.equal(invalid.status, "not-evaluated");
  assert.match(
    invalid.status === "not-evaluated" ? invalid.reason : "",
    /supported regular expression/,
  );
  assert.equal(
    outcomeFor(state, { kind: "regex", pattern: "Line", flags: "g" }).status,
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
    () => parseCheckDefinition({ checkId: "check_one", kind: "regex", pattern: "(unclosed" }),
    /supported regular expression/,
  );
  assert.throws(
    () =>
      parseCheckDefinition({
        checkId: "check_one",
        kind: "regex",
        pattern: "a",
        flags: "gi",
      }),
    /flags must be a unique subset/,
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
