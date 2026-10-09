import type {
  ExperimentControllerOptions,
} from "../../packages/runner/src/experiment-controller.ts";
import {
  saveExperimentPlanWorkspace,
  saveExperimentResultWorkspace,
  saveRunTraceWorkspace,
} from "../project-workspace.client.ts";
import type { ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import type { ExperimentPlanV3 } from "../../packages/core/src/experiment.ts";

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
      await saveRunTraceWorkspace(workspace, trace);
    },
  };
}
