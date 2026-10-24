import type {
  ExperimentControllerOptions,
} from "../../packages/runner/src/experiment-controller.ts";
import {
  saveExperimentPlanWorkspace,
  saveExperimentResultWorkspace,
  saveRunTraceWorkspace,
} from "../project-workspace.client.ts";
import type { ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import type { DecisionEvaluationExperimentPlan, ExperimentPlanV3 } from "../../packages/core/src/experiment.ts";
import type { DecisionRunTrace } from "../../packages/core/src/decision-trace.ts";

/**
 * Binds the storage-neutral controller callbacks to one writable project.
 * The controller supplies serialized artifacts for its validation boundary;
 * workspace helpers remain the sole authority for their durable encoding.
 */
export function createExperimentWorkspacePersistence(
  workspace: ProjectWorkspaceHandle,
  plan: ExperimentPlanV3,
): Pick<
  ExperimentControllerOptions,
  "savePlan" | "saveResult" | "onTerminalTrace"
> {
  return {
    async savePlan(frozenPlan) {
      await saveExperimentPlanWorkspace(workspace, frozenPlan);
    },
    async saveResult(result) {
      await saveExperimentResultWorkspace(workspace, result, plan);
    },
    async onTerminalTrace(trace) {
      await saveRunTraceWorkspace(workspace, { kind: "chat", trace });
    },
  };
}

/** The same binding for a decision evaluation, whose cells save decision traces (D49). */
export function createDecisionExperimentWorkspacePersistence(
  workspace: ProjectWorkspaceHandle,
  plan: DecisionEvaluationExperimentPlan,
): {
  savePlan(plan: ExperimentPlanV3): Promise<void>;
  saveResult(result: Parameters<typeof saveExperimentResultWorkspace>[1]): Promise<void>;
  onTerminalTrace(trace: DecisionRunTrace): Promise<void>;
} {
  return {
    async savePlan(frozenPlan) {
      await saveExperimentPlanWorkspace(workspace, frozenPlan);
    },
    async saveResult(result) {
      await saveExperimentResultWorkspace(workspace, result, plan);
    },
    async onTerminalTrace(trace) {
      await saveRunTraceWorkspace(workspace, { kind: "decision", trace });
    },
  };
}
