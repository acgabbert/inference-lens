import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessSummary } from "../packages/cli/src/summary.ts";
import type { EvaluationBakeoffAssessment, EvaluationExperimentPlanV4, ExperimentResult } from "../packages/core/src/experiment.ts";

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
    result,
    assessment: { lifecycle: "stopped", variants: [] } as unknown as EvaluationBakeoffAssessment,
    projectDirectory: "/project",
    planPath: "experiments/experiment_stopped.plan.json",
    tracePaths: new Map(),
  });
  assert.deepEqual(summary.stop, { reason: "tool_unavailable", cellId: "experiment-cell_1", toolId: "tool_lookup" });
});
