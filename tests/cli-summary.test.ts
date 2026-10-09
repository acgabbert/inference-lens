import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessSummary, headlessRepeatedOutcome } from "../packages/cli/src/summary.ts";
import type {
  EvaluationBakeoffAssessment,
  EvaluationExperimentPlanV4,
  ExperimentResult,
  RepeatedExperimentAggregate,
} from "../packages/core/src/experiment.ts";

test("summary v1 reports a stop with only the fields it shipped with", () => {
  const plan = {
    experimentId: "experiment_stopped",
    suite: { suiteId: "evaluation-suite_triage", name: "Triage" },
  } as unknown as EvaluationExperimentPlanV4;
  const result = {
    status: "stopped",
    stop: { reason: "tool_unavailable", cellId: "experiment-cell_1", toolId: "tool_lookup", startedCells: 1 },
  } as unknown as ExperimentResult;
  const summary = createHeadlessSummary({
    plan,
    scope: { cases: { selected: 1, total: 1 }, configurations: { selected: 1, total: 1 } },
    result,
    assessment: { lifecycle: "stopped", variants: [] } as unknown as EvaluationBakeoffAssessment,
    projectDirectory: "/project",
    planPath: "experiments/experiment_stopped.plan.json",
    tracePaths: new Map(),
  });
  assert.deepEqual(summary.stop, { reason: "tool_unavailable", cellId: "experiment-cell_1", toolId: "tool_lookup" });
});

test("a repeated run's real failure outranks rate limiting, and anything short of all completed is incomplete", () => {
  const aggregate = (counts: Partial<RepeatedExperimentAggregate>) =>
    ({ lifecycle: "completed", requested: 3, completed: 0, failed: 0, rateLimited: 0, ...counts }) as RepeatedExperimentAggregate;
  assert.equal(headlessRepeatedOutcome(aggregate({ completed: 3 })), "completed");
  assert.equal(headlessRepeatedOutcome(aggregate({ completed: 1, failed: 1, rateLimited: 1 })), "failed");
  assert.equal(headlessRepeatedOutcome(aggregate({ completed: 2, rateLimited: 1 })), "incomplete");
  assert.equal(headlessRepeatedOutcome(aggregate({ completed: 2, notRun: 1 })), "incomplete");
  assert.equal(headlessRepeatedOutcome(aggregate({ lifecycle: "cancelled", completed: 1, failed: 1 })), "incomplete");
});
