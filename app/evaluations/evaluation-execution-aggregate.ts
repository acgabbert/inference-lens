import type { DecisionRun } from "../../packages/core/src/decision.ts";
import {
  evaluationParsedExperimentAggregateSteps,
  parseExperimentPlanFile,
  type EvaluationBakeoffAssessment,
  type EvaluationCriteriaOverride,
  type EvaluationVariantSnapshot,
} from "../../packages/core/src/experiment.ts";
import type { RunId, RunState } from "../../packages/core/src/run-kernel/index.ts";
import type { EvaluationExecution } from "./use-evaluation-execution-session.client.ts";

/** What scoring an execution reads, of either kind. */
export type ScorableEvaluationExecution = Pick<EvaluationExecution, "kind" | "plan" | "result" | "states">;

/**
 * Scores an execution through the one aggregate (D50), choosing the overload
 * its kind needs. The plan is re-validated as the chat path always did.
 */
export function evaluationExecutionAggregateSteps(
  execution: ScorableEvaluationExecution,
  criteria?: EvaluationCriteriaOverride,
): Generator<void, EvaluationBakeoffAssessment<EvaluationVariantSnapshot>> {
  const plan = parseExperimentPlanFile(execution.plan);
  if (plan.kind === "decision-evaluation") {
    return evaluationParsedExperimentAggregateSteps(plan, execution.result, execution.states as ReadonlyMap<RunId, DecisionRun>, criteria);
  }
  if (plan.kind !== "evaluation") throw new Error("Expected an evaluation plan.");
  return evaluationParsedExperimentAggregateSteps(plan, execution.result, execution.states as ReadonlyMap<RunId, RunState>, criteria);
}

export function evaluationExecutionAggregate(
  execution: ScorableEvaluationExecution,
  criteria?: EvaluationCriteriaOverride,
): EvaluationBakeoffAssessment<EvaluationVariantSnapshot> {
  const steps = evaluationExecutionAggregateSteps(execution, criteria);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
