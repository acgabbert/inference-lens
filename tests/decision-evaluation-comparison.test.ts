import assert from "node:assert/strict";
import test from "node:test";

import type { DecisionRun } from "../packages/core/src/decision.ts";
import { updateDecisionRequestDraft } from "../packages/core/src/decision-request.ts";
import { compareEvaluationExecutions } from "../packages/core/src/evaluation-comparison.ts";
import type { EvaluationComparisonInput } from "../packages/core/src/evaluation-comparison.ts";
import { isDecisionEvaluationSuite } from "../packages/core/src/evaluation-suites.ts";
import {
  EXPERIMENT_RESULT_SCHEMA_VERSION,
  materializeParsedDecisionCellInput,
  noExperimentRetries,
  sequentialExperimentConcurrency,
} from "../packages/core/src/experiment.ts";
import type { DecisionEvaluationExperimentPlan, ExperimentResult } from "../packages/core/src/experiment.ts";
import type { EvaluationVariantId, RunId } from "../packages/core/src/run-kernel/index.ts";
import {
  decision,
  decisionAnswers,
  decisionPlan,
  decisionProject,
  finishedDecisionRun,
} from "./fixtures/decision-evaluation.ts";
import type { FinishedRunOptions } from "./fixtures/decision-evaluation.ts";

const BASE = "evaluation-variant_base" as EvaluationVariantId;
const BIG = "evaluation-variant_big" as EvaluationVariantId;

function completedResult(plan: DecisionEvaluationExperimentPlan): ExperimentResult {
  return {
    schemaVersion: EXPERIMENT_RESULT_SCHEMA_VERSION,
    experimentId: plan.experimentId,
    status: "completed",
    endedAt: "2026-10-24T13:10:00.000Z",
    concurrency: sequentialExperimentConcurrency(plan),
    retryPolicy: noExperimentRetries(),
    cells: plan.cells.map((cell, index) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed", startOrder: index + 1 })),
  };
}

function runs(
  plan: DecisionEvaluationExperimentPlan,
  byCell: (variantId: EvaluationVariantId, caseId: string) => FinishedRunOptions,
): Map<RunId, DecisionRun> {
  return new Map(plan.cells.map((cell) => [
    cell.runId,
    finishedDecisionRun(materializeParsedDecisionCellInput(plan, cell), byCell(cell.variantId, cell.caseId)),
  ]));
}

const routed = (choice: string, durationMs = 800): FinishedRunOptions => ({
  last: { kind: "completed", answers: decisionAnswers(choice, 1.5) },
  durationMs,
});

function side(
  plan: DecisionEvaluationExperimentPlan,
  variantId: EvaluationVariantId,
  states: Map<RunId, DecisionRun>,
): EvaluationComparisonInput {
  return { experimentId: plan.experimentId, plan, variantId, result: completedResult(plan), states };
}

test("two decision configurations compare by case, with the target as decision drift", () => {
  const plan = decisionPlan();
  // Big routes Refund to billing, so its Refund case regresses against Default.
  const states = runs(plan, (variantId, caseId) =>
    variantId === BIG && caseId === "evaluation-case_refund" ? routed("billing", 1_200) : routed("refund"));
  const comparison = compareEvaluationExecutions(side(plan, BASE, states), side(plan, BIG, states));

  assert.equal(comparison.drift.kind, "decision");
  assert.deepEqual(comparison.drift.model, { baseline: "local-decision", candidate: "big-decision" });
  assert.deepEqual(comparison.drift.endpoint, {
    baseline: "http://127.0.0.1:24035/v1",
    candidate: "http://127.0.0.1:24036/v1",
  });
  assert.equal(comparison.drift.inputRevision, undefined);
  assert.equal(comparison.drift.protocol, undefined);
  assert.equal("responseMode" in comparison.drift, false);
  assert.equal("optionsChanged" in comparison.drift, false);
  assert.equal(comparison.drift.any, true);

  const refund = comparison.cases.find(({ caseId }) => caseId === "evaluation-case_refund");
  assert.equal(refund?.alignment, "aligned");
  assert.equal(refund?.delta, "regressed");
  assert.equal(comparison.counts.regressed, 1);
  assert.equal(comparison.counts.unchangedPass, 1);
  // Durations come from the decision runs' own start and end.
  assert.deepEqual(refund?.candidate?.totalDurationMs, { count: 2, min: 1_200, median: 1_200, max: 1_200 });
  assert.deepEqual(comparison.baseline.totalDurationMs, { count: 4, min: 800, median: 800, max: 800 });
});

test("a changed decision request revision is input revision drift", () => {
  const baseline = decisionPlan();
  // Branched without the suite: the fixture suite reuses a check id across
  // cases, which a project parse refuses and the plan builder does not.
  const source = decisionProject();
  const branched = updateDecisionRequestDraft({ ...source, evaluationSuites: [] }, {
    decision: { ...decision, state: "Customer ticket: {{ticket}} ({{plan}})" },
    values: { ticket: "Charged twice", plan: "pro" },
    branch: true,
    idSuffix: "two",
    createdAt: "2026-10-24T12:30:00.000Z",
  });
  const project = {
    ...branched,
    evaluationSuites: source.evaluationSuites.map((suite) => isDecisionEvaluationSuite(suite)
      ? { ...suite, input: { ...suite.input, decisionRequestRevisionId: "decision-revision_two" as const } }
      : suite),
  };
  const candidate = decisionPlan({ project });
  const comparison = compareEvaluationExecutions(
    side(baseline, BASE, runs(baseline, () => routed("refund"))),
    side(candidate, BASE, runs(candidate, () => routed("refund"))),
  );
  assert.deepEqual(comparison.drift.inputRevision, {
    baseline: "decision-revision_one",
    candidate: "decision-revision_two",
  });
  assert.equal(comparison.drift.model, undefined);
  assert.equal(comparison.drift.any, true);
});

test("the same decision configuration in two executions has no drift", () => {
  const baseline = decisionPlan();
  const candidate = decisionPlan({ createdAt: "2026-10-24T14:00:00.000Z" });
  const comparison = compareEvaluationExecutions(
    side(baseline, BASE, runs(baseline, () => routed("refund"))),
    side(candidate, BASE, runs(candidate, () => routed("refund"))),
  );
  assert.equal(comparison.drift.kind, "decision");
  assert.equal(comparison.drift.any, false);
  assert.equal(comparison.counts.unchangedPass, 2);
});
