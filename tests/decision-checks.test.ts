import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_CHECK_KINDS,
  CHECK_KINDS,
  CHECK_SCHEMA_VERSION,
  CheckValidationError,
  DECISION_CHECK_KINDS,
  SHARED_CHECK_KINDS,
  authoredCheckDefinitionSchema,
  checkVocabularyIssue,
  decisionCheckSubject,
  evaluateCheck,
  parseCheckDefinition,
} from "../packages/core/src/checks.ts";
import type { CheckDefinition, CheckOutcome, DecisionCheckSubject } from "../packages/core/src/checks.ts";
import type { DecisionAnswer, DecisionRun } from "../packages/core/src/decision.ts";
import { createEntityId } from "../packages/core/src/run-kernel/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

// The captured llama.cpp all-types answers (tests/fixtures/system-one/llamacpp-all-types.json).
const answers: Record<string, DecisionAnswer> = {
  intent: {
    type: "choice",
    choice: "billing",
    probabilities: { billing: 0.9282073370713441, bug: 0.05861868866168816, other: 0.013173974266967876 },
    confidence: 0.8923110056070159,
  },
  severity: {
    type: "score",
    score: 1.0871479652612954,
    probabilities: { 0: 0.07519514273998514, 1: 0.7624617492587342, 2: 0.1623431080012806 },
    confidence: 0.6436926238881013,
  },
  is_spam: { type: "noul", noul: 0.07768066663542304 },
};

const runId = createEntityId("run", "decision-checks");
const exchangeId = createEntityId("exchange", "decision-checks-1");

function run(overrides: Partial<DecisionRun> = {}): DecisionRun {
  return {
    kind: "decision",
    runId,
    input: {
      runId,
      resolvedAt: "2026-10-24T12:00:00.000Z",
      target: {
        profileId: createEntityId("profile", "llamacpp"),
        protocol: "systemone",
        endpoint: "https://llm.example.test/v1",
        model: "local-decision",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      decision: { state: "ticket", questions: {} },
    },
    status: { kind: "completed", completedAt: "2026-10-24T12:00:01.250Z" },
    attempts: [{
      attempt: 1,
      exchangeId,
      status: "completed",
      result: { model: "local-decision", answers, usage: { inputTokens: 203, outputTokens: 0, totalTokens: 203 } },
    }],
    exchanges: { [exchangeId]: { exchangeId, attempt: 1, frames: [] } },
    startedAt: "2026-10-24T12:00:00.000Z",
    endedAt: "2026-10-24T12:00:01.250Z",
    ...overrides,
  };
}

type UnnamedCheck = CheckDefinition extends infer Definition
  ? Definition extends CheckDefinition ? Omit<Definition, "checkId"> : never
  : never;

function check(definition: UnnamedCheck): CheckDefinition {
  return { checkId: createEntityId("check", "one"), ...definition } as CheckDefinition;
}

function outcomeFor(definition: UnnamedCheck, subject: DecisionCheckSubject = decisionCheckSubject(run())): CheckOutcome {
  return evaluateCheck(check(definition), subject);
}

test("check vocabulary 5 adds the five decision kinds and partitions every kind once", () => {
  assert.equal(CHECK_SCHEMA_VERSION, 5);
  assert.deepEqual([...DECISION_CHECK_KINDS], [
    "decision-choice",
    "decision-option-probability",
    "decision-score-range",
    "decision-noul",
    "decision-confidence",
  ]);
  assert.deepEqual([...SHARED_CHECK_KINDS], ["max-duration-ms", "max-total-tokens"]);
  const partition = [...CHAT_CHECK_KINDS, ...DECISION_CHECK_KINDS, ...SHARED_CHECK_KINDS].sort();
  assert.deepEqual(partition, [...CHECK_KINDS].sort());
});

test("a container below vocabulary 5 refuses decision kinds", () => {
  const choice = check({ kind: "decision-choice", questionId: "intent", option: "billing" });
  assert.match(checkVocabularyIssue(choice, 4) ?? "", /requires check vocabulary version 5/);
  assert.match(checkVocabularyIssue(choice, 3) ?? "", /requires check vocabulary version 5/);
  assert.equal(checkVocabularyIssue(choice, 5), undefined);
  assert.equal(checkVocabularyIssue(check({ kind: "max-duration-ms", limit: 1 }), 4), undefined);
});

test("each decision kind parses, and malformed bounds are refused", () => {
  const valid: UnnamedCheck[] = [
    { kind: "decision-choice", questionId: "intent", option: "billing", negate: true },
    { kind: "decision-option-probability", questionId: "severity", option: "1", comparator: "at-least", value: 0.5 },
    { kind: "decision-score-range", questionId: "severity", min: 0.5 },
    { kind: "decision-score-range", questionId: "severity", max: 2 },
    { kind: "decision-noul", questionId: "is_spam", comparator: "at-most", value: 0.2 },
    { kind: "decision-confidence", questionId: "intent", atLeast: 0.7 },
  ];
  for (const definition of valid) assert.deepEqual(parseCheckDefinition(check(definition)), check(definition));

  const invalid: unknown[] = [
    check({ kind: "decision-option-probability", questionId: "severity", option: "1", comparator: "at-least", value: 1.5 }),
    check({ kind: "decision-noul", questionId: "is_spam", comparator: "at-most", value: -0.1 }),
    check({ kind: "decision-confidence", questionId: "intent", atLeast: 2 }),
    check({ kind: "decision-score-range", questionId: "severity" }),
    check({ kind: "decision-score-range", questionId: "severity", min: 2, max: 1 }),
    check({ kind: "decision-choice", questionId: "", option: "billing" }),
    { ...check({ kind: "decision-noul", questionId: "is_spam", comparator: "at-most", value: 0.2 }), comparator: "exact" },
  ];
  for (const definition of invalid) assert.throws(() => parseCheckDefinition(definition), CheckValidationError);
});

test("an authored decision check may leave its question and option empty for preflight to report", () => {
  const draft = check({ kind: "decision-choice", questionId: "", option: "" });
  assert.equal(authoredCheckDefinitionSchema.safeParse(draft).success, true);
});

test("the decision subject reads the completed attempt's answers, wall time, and usage", () => {
  const subject = decisionCheckSubject(run());
  assert.equal(subject.kind, "decision");
  assert.equal(subject.unavailable, undefined);
  assert.deepEqual(subject.answers, answers);
  assert.equal(subject.totalDurationMs, 1250);
  assert.equal(subject.reportedTotalTokens, 203);
});

test("a decision subject with no reported usage leaves tokens absent, never zero", () => {
  const attempt = run().attempts[0]!;
  const subject = decisionCheckSubject(run({
    attempts: [{ ...attempt, result: { ...attempt.result!, usage: undefined } }],
  }));
  assert.equal(subject.reportedTotalTokens, undefined);
  const tokens = outcomeFor({ kind: "max-total-tokens", limit: 1000 }, subject);
  assert.equal(tokens.status, "not-evaluated");
});

test("a failed or cancelled decision run supports no assertion", () => {
  const failed = decisionCheckSubject(run({
    status: { kind: "failed", error: { code: "provider_error", message: "boom", retryable: false }, failedAt: "2026-10-24T12:00:01.000Z" },
  }));
  assert.match(failed.unavailable ?? "", /failed/);
  assert.equal(outcomeFor({ kind: "decision-choice", questionId: "intent", option: "billing" }, failed).status, "not-evaluated");
  const cancelled = decisionCheckSubject(run({ status: { kind: "cancelled", cancelledAt: "2026-10-24T12:00:01.000Z" } }));
  assert.match(cancelled.unavailable ?? "", /cancelled/);
});

test("decision-choice compares the selected option, and negate asserts the opposite", () => {
  assert.deepEqual(outcomeFor({ kind: "decision-choice", questionId: "intent", option: "billing" }), {
    status: "passed",
    evidence: { choice: "billing", expected: "billing" },
  });
  const wrong = outcomeFor({ kind: "decision-choice", questionId: "intent", option: "bug" });
  assert.equal(wrong.status, "failed");
  assert.equal(outcomeFor({ kind: "decision-choice", questionId: "intent", option: "bug", negate: true }).status, "passed");
  assert.equal(outcomeFor({ kind: "decision-choice", questionId: "intent", option: "billing", negate: true }).status, "failed");
});

test("decision-option-probability bounds an option's probability, with score levels keyed by number", () => {
  assert.equal(outcomeFor({ kind: "decision-option-probability", questionId: "intent", option: "billing", comparator: "at-least", value: 0.9 }).status, "passed");
  const tooLow = outcomeFor({ kind: "decision-option-probability", questionId: "intent", option: "bug", comparator: "at-least", value: 0.5 });
  assert.equal(tooLow.status, "failed");
  assert.deepEqual(tooLow.status === "failed" && tooLow.evidence, { probability: 0.05861868866168816, comparator: "at-least", value: 0.5 });
  assert.equal(outcomeFor({ kind: "decision-option-probability", questionId: "severity", option: "2", comparator: "at-most", value: 0.2 }).status, "passed");
  assert.equal(outcomeFor({ kind: "decision-option-probability", questionId: "severity", option: "1", comparator: "at-most", value: 0.5 }).status, "failed");
});

test("decision-score-range is inclusive against the fractional score", () => {
  assert.equal(outcomeFor({ kind: "decision-score-range", questionId: "severity", min: 1, max: 2 }).status, "passed");
  assert.equal(outcomeFor({ kind: "decision-score-range", questionId: "severity", min: 1.0871479652612954 }).status, "passed");
  const high = outcomeFor({ kind: "decision-score-range", questionId: "severity", max: 1 });
  assert.equal(high.status, "failed");
  assert.deepEqual(high.status === "failed" && high.evidence, { score: 1.0871479652612954, max: 1 });
});

test("decision-noul bounds P(true)", () => {
  assert.equal(outcomeFor({ kind: "decision-noul", questionId: "is_spam", comparator: "at-most", value: 0.1 }).status, "passed");
  assert.equal(outcomeFor({ kind: "decision-noul", questionId: "is_spam", comparator: "at-least", value: 0.5 }).status, "failed");
});

test("decision-confidence needs a reported confidence; a noul answer has none to read", () => {
  assert.equal(outcomeFor({ kind: "decision-confidence", questionId: "intent", atLeast: 0.8 }).status, "passed");
  assert.equal(outcomeFor({ kind: "decision-confidence", questionId: "severity", atLeast: 0.8 }).status, "failed");
  const noConfidence = run({
    attempts: [{
      ...run().attempts[0]!,
      result: { answers: { intent: { type: "choice", choice: "billing", probabilities: { billing: 1 } } } },
    }],
  });
  assert.equal(outcomeFor({ kind: "decision-confidence", questionId: "intent", atLeast: 0.5 }, decisionCheckSubject(noConfidence)).status, "not-evaluated");
  assert.equal(outcomeFor({ kind: "decision-confidence", questionId: "is_spam", atLeast: 0.5 }).status, "not-evaluated");
});

test("a missing question, a wrong answer type, or an omitted probability is not evaluated", () => {
  const missing = outcomeFor({ kind: "decision-choice", questionId: "nope", option: "billing" });
  assert.equal(missing.status, "not-evaluated");
  assert.match(missing.status === "not-evaluated" ? missing.reason : "", /no answer for question "nope"/);
  assert.equal(outcomeFor({ kind: "decision-choice", questionId: "severity", option: "1" }).status, "not-evaluated");
  assert.equal(outcomeFor({ kind: "decision-score-range", questionId: "intent", min: 0 }).status, "not-evaluated");
  assert.equal(outcomeFor({ kind: "decision-noul", questionId: "intent", comparator: "at-least", value: 0 }).status, "not-evaluated");
  assert.equal(outcomeFor({ kind: "decision-option-probability", questionId: "intent", option: "refund", comparator: "at-least", value: 0 }).status, "not-evaluated");
});

test("shared kinds read a decision subject; chat output kinds are not evaluated against it", () => {
  assert.equal(outcomeFor({ kind: "max-duration-ms", limit: 2000 }).status, "passed");
  assert.equal(outcomeFor({ kind: "max-duration-ms", limit: 1000 }).status, "failed");
  assert.equal(outcomeFor({ kind: "max-total-tokens", limit: 200 }).status, "failed");
  assert.equal(outcomeFor({ kind: "contains", value: "billing" }).status, "not-evaluated");
  assert.equal(outcomeFor({ kind: "called-tool", toolName: "x" }).status, "not-evaluated");
});

test("a decision kind against a chat subject is not evaluated rather than thrown", () => {
  const outcome = evaluateCheck(check({ kind: "decision-choice", questionId: "intent", option: "billing" }), { output: "billing", toolCalls: [] });
  assert.equal(outcome.status, "not-evaluated");
});
