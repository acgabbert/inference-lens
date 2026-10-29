import assert from "node:assert/strict";
import test from "node:test";

import type { DecisionRun } from "../packages/core/src/decision.ts";
import {
  EXPERIMENT_RESULT_SCHEMA_VERSION,
  evaluationParsedExperimentAggregate,
  materializeParsedDecisionCellInput,
  noExperimentRetries,
  repetitionEvidence,
  sequentialExperimentConcurrency,
} from "../packages/core/src/experiment.ts";
import type {
  DecisionEvaluationExperimentPlan,
  EvaluationRepetitionClassification,
  ExperimentResult,
} from "../packages/core/src/experiment.ts";
import { createEvaluationAssessment, evaluationAssessmentCriteria } from "../packages/core/src/evaluation-assessment.ts";
import type { RunId } from "../packages/core/src/run-kernel/index.ts";
import {
  RATE_LIMITED,
  check,
  decisionAnswers,
  decisionPlan,
  finishedDecisionRun,
} from "./fixtures/decision-evaluation.ts";
import type { FinishedRunOptions } from "./fixtures/decision-evaluation.ts";

const plan = decisionPlan();

function completedResult(source: DecisionEvaluationExperimentPlan): ExperimentResult {
  return {
    schemaVersion: EXPERIMENT_RESULT_SCHEMA_VERSION,
    experimentId: source.experimentId,
    status: "completed",
    endedAt: "2026-10-24T13:10:00.000Z",
    concurrency: sequentialExperimentConcurrency(source),
    retryPolicy: noExperimentRetries(),
    cells: source.cells.map((cell, index) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed", startOrder: index + 1 })),
  };
}

/** One finished run per cell, by ordinal. */
function runs(byOrdinal: (ordinal: number) => FinishedRunOptions): Map<RunId, DecisionRun> {
  return new Map(plan.cells.map((cell) => [
    cell.runId,
    finishedDecisionRun(materializeParsedDecisionCellInput(plan, cell), byOrdinal(cell.ordinal)),
  ]));
}

const correct: FinishedRunOptions = {
  last: { kind: "completed", answers: decisionAnswers("refund", 1.5), usage: { inputTokens: 200, outputTokens: 0, totalTokens: 200 } },
  durationMs: 800,
};

function classifications(aggregate: ReturnType<typeof evaluationParsedExperimentAggregate>) {
  return aggregate.variants.map((variant) => variant.cases.map((item) => item.repetitions.map(({ classification }) => classification)));
}

test("decision repetitions are scored by their answers, strictly, per configuration", () => {
  // Ordinals 1–4 are Refund (Default ×2, Big ×2); 5–8 are Crash. Big routes Refund to billing.
  const states = runs((ordinal) => ordinal === 3 || ordinal === 4
    ? { ...correct, last: { kind: "completed", answers: decisionAnswers("billing", 1.5) } }
    : correct);
  const aggregate = evaluationParsedExperimentAggregate(plan, completedResult(plan), states);
  assert.equal(aggregate.lifecycle, "completed");
  assert.deepEqual(classifications(aggregate), [
    [["passed", "passed"], ["passed", "passed"]],
    [["check-failed", "check-failed"], ["passed", "passed"]],
  ]);
  const [base, big] = aggregate.variants;
  assert.equal(base!.passed, true);
  assert.deepEqual(base!.caseCounts, { total: 2, passed: 2, failed: 0, incomplete: 0 });
  assert.equal(big!.passed, false);
  assert.deepEqual(big!.caseCounts, { total: 2, passed: 1, failed: 1, incomplete: 0 });
  assert.equal(big!.variant.target.model, "big-decision");
  const failedChoice = big!.cases[0]!.repetitions[0]!.checks[0]!;
  assert.equal(failedChoice.outcome.status, "failed");
});

test("decision repetitions report their duration and reported tokens, and absent usage stays absent", () => {
  const states = runs((ordinal) => ordinal % 2 === 0
    ? { last: { kind: "completed", answers: decisionAnswers("refund", 1.5) }, durationMs: 1_200 }
    : correct);
  const [base] = evaluationParsedExperimentAggregate(plan, completedResult(plan), states).variants;
  assert.deepEqual(base!.totalDurationMs, { count: 4, min: 800, median: 1_000, max: 1_200 });
  assert.deepEqual(base!.totalTokens, { reportedRuns: 2, total: 400 });
  assert.deepEqual(base!.outputTokens, { reportedRuns: 2, total: 0 });
});

test("a decision 429 is missing evidence, a retried 429 is counted, and another failure fails the repetition", () => {
  const states = runs((ordinal) => {
    if (ordinal === 1) return { last: { kind: "failed", error: RATE_LIMITED } };
    if (ordinal === 2) return { ...correct, failedFirst: [RATE_LIMITED] };
    if (ordinal === 5) return { last: { kind: "failed", error: { code: "provider_error", message: "Bad request", providerStatus: 400 } } };
    if (ordinal === 6) return { last: { kind: "cancelled" } };
    return correct;
  });
  const [base] = evaluationParsedExperimentAggregate(plan, completedResult(plan), states).variants;
  const counts: Partial<Record<EvaluationRepetitionClassification, number>> = Object.fromEntries(
    Object.entries(base!.repetitionCounts).filter(([, count]) => count > 0),
  );
  assert.deepEqual(counts, { passed: 1, "rate-limited": 1, "run-failed": 1, cancelled: 1 });
  assert.equal(base!.retriedAfterRateLimit, 1);
  // Refund has a rate-limited repetition and nothing failing: incomplete, not failed.
  assert.deepEqual(base!.caseCounts, { total: 2, passed: 0, failed: 1, incomplete: 1 });
  const runFailed = base!.cases[1]!.repetitions[0]!;
  assert.equal(runFailed.classification, "run-failed");
  assert.deepEqual(runFailed.checks.map(({ outcome }) => outcome.status), ["not-evaluated", "not-evaluated"]);
});

test("a decision run that is missing or unstarted leaves its case incomplete", () => {
  // Ordinals 5 and 6 are Crash on Default, the last two cells on that connection.
  const states = runs(() => correct);
  states.delete(plan.cells[4]!.runId);
  let started = 0;
  const result: ExperimentResult = {
    ...completedResult(plan),
    status: "cancelled",
    cells: plan.cells.map((cell) => cell.ordinal === 6
      ? { cellId: cell.cellId, runId: cell.runId, status: "not-run" as const }
      : { cellId: cell.cellId, runId: cell.runId, status: "completed" as const, startOrder: ++started }),
  };
  const [base] = evaluationParsedExperimentAggregate(plan, result, states).variants;
  assert.deepEqual(base!.cases[1]!.repetitions.map(({ classification }) => classification), ["trace-unavailable", "not-run"]);
  assert.deepEqual(base!.caseCounts, { total: 2, passed: 1, failed: 0, incomplete: 1 });
});

test("replacement criteria reinterpret saved decision answers without rerunning them", () => {
  const states = runs((ordinal) => ordinal === 3 || ordinal === 4
    ? { ...correct, last: { kind: "completed", answers: decisionAnswers("billing", 1.5) } }
    : correct);
  const criteria = new Map([[plan.suite.cases[0]!.caseId, [check({ kind: "decision-choice", questionId: "intent", option: "billing" })]]]);
  const [base, big] = evaluationParsedExperimentAggregate(plan, completedResult(plan), states, criteria).variants;
  assert.equal(base!.cases[0]!.passed, false);
  assert.equal(big!.cases[0]!.passed, true);
  const assessment = createEvaluationAssessment({
    assessmentId: "evaluation-assessment_one",
    name: "Billing is right",
    createdAt: "2026-10-24T14:00:00.000Z",
    criteria,
  }, plan);
  assert.deepEqual(evaluationAssessmentCriteria(assessment), criteria);
  assert.throws(
    () => createEvaluationAssessment({
      assessmentId: "evaluation-assessment_two",
      name: "Chat check",
      createdAt: "2026-10-24T14:00:00.000Z",
      criteria: new Map([[plan.suite.cases[0]!.caseId, [check({ kind: "contains", value: "refund" })]]]),
    }, plan),
    /"contains" checks read a chat run/,
  );
});

test("decision evidence projects status, rate limiting, metrics, and the decision subject", () => {
  const input = materializeParsedDecisionCellInput(plan, plan.cells[0]!);
  const retried = repetitionEvidence(finishedDecisionRun(input, { ...correct, failedFirst: [RATE_LIMITED, RATE_LIMITED] }));
  assert.equal(retried.status, "completed");
  assert.equal(retried.rateLimited, false);
  assert.equal(retried.rateLimitRetries, 2);
  assert.deepEqual(retried.metrics, { totalDurationMs: 800, totalTokens: 200, outputTokens: 0 });
  assert.equal(retried.subject.kind, "decision");

  const limited = repetitionEvidence(finishedDecisionRun(input, { last: { kind: "failed", error: RATE_LIMITED } }));
  assert.equal(limited.status, "failed");
  assert.equal(limited.rateLimited, true);
  assert.equal(limited.rateLimitRetries, 0);
  assert.deepEqual(limited.metrics, { totalDurationMs: 1_000 });
});
