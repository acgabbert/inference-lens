import type { ProviderCapabilities } from "../../packages/core/src/types.ts";
import { createEvaluationExperimentPlan } from "../../packages/core/src/evaluation-execution.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/types.ts";
import type {
  EvaluationCaseId,
  EvaluationSuiteId,
  ToolId,
} from "../../packages/core/src/run-kernel/types.ts";
import { experimentExposedTools } from "../../packages/core/src/experiment.ts";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";
import { listExperimentToolBindings } from "../run/experiment-tool-bindings.client.ts";
import { describeConversationRevision } from "../../packages/core/src/conversation-revision-description.ts";
import { evaluationBatchGuardrail } from "./evaluation-batch.client.ts";
import { revisionChoice } from "./revision-choice.client.ts";

export interface EvaluationStartReadinessInput {
  projectOpen: boolean;
  suiteSelected: boolean;
  revisionSelected: boolean;
  revisionAvailable: boolean;
  diagnostics: readonly { message: string }[];
  selectedCaseCount: number;
  repetitions: number;
  /** The suite's exposed tools and what will serve each one on this device. */
  toolBindings: readonly { name: string; bound: boolean }[];
  /**
   * Why a command-bound tool cannot run in this shell, when that is the case.
   * Reported before the batch starts rather than as a failure per repetition.
   */
  commandToolsUnavailableReason?: string;
  turnCeiling?: number;
  connectionMapped: boolean;
  hasProjectMapping: boolean;
  endpoint: string;
  model: string;
  responseMode: "streaming" | "buffered";
  streamingAvailable: boolean;
  activityInProgress: boolean;
}

/** The single start gate used by the button and imperative start paths. */
export function evaluationStartReadiness(
  input: EvaluationStartReadinessInput,
): { blockedReason?: string } {
  if (!input.projectOpen) return { blockedReason: "Open or save a project first." };
  if (!input.suiteSelected || !input.revisionSelected) {
    return { blockedReason: "Create an evaluation suite first." };
  }
  if (!input.revisionAvailable) {
    return { blockedReason: "The selected conversation revision no longer exists." };
  }
  if (input.diagnostics[0]) return { blockedReason: input.diagnostics[0].message };
  const batch = evaluationBatchGuardrail(input.selectedCaseCount, input.repetitions, {
    exposedToolCount: input.toolBindings.length,
    ...(input.turnCeiling === undefined ? {} : { turnCeiling: input.turnCeiling }),
  });
  if (batch.error) return { blockedReason: batch.error };
  // The same gate a repeated experiment applies, for the same reason: an
  // evaluation answers its own tool calls, so a tool nothing here can serve
  // would fail every repetition at a call nobody is present to answer.
  const unbound = input.toolBindings.filter(({ bound }) => !bound);
  if (unbound.length > 0) {
    const names = unbound.map(({ name }) => name).join(", ");
    return {
      blockedReason: `This suite exposes ${names}, and nothing on this device can serve ${
        unbound.length === 1 ? "it" : "them"
      }. Enable a mock or grant a command tool first.${
        input.commandToolsUnavailableReason ? ` ${input.commandToolsUnavailableReason}` : ""
      }`,
    };
  }
  if (!input.connectionMapped) {
    return {
      blockedReason: input.hasProjectMapping
        ? "Activate this project's mapped connection before starting."
        : "Map this project's connection to a local profile before starting.",
    };
  }
  if (!input.endpoint.trim()) return { blockedReason: "Enter an endpoint before starting." };
  if (!input.model.trim()) return { blockedReason: "Enter a model before starting." };
  if (input.responseMode === "streaming" && !input.streamingAvailable) {
    return { blockedReason: "This connection does not support streaming. Choose buffered delivery for this evaluation." };
  }
  if (input.activityInProgress) return { blockedReason: "Finish or stop the current run first." };
  return {};
}

export interface EvaluationStartDraftInput {
  project: ProjectFile;
  suiteId: EvaluationSuiteId;
  selectedCaseIds: readonly EvaluationCaseId[];
  profile: { id: string; name: string; endpoint: string };
  capabilities: ProviderCapabilities;
  durable: boolean;
  /** The device-local binding that will serve one of the suite's exposed tools. */
  bindingForTool(toolId: ToolId): ToolBinding | undefined;
}

/** Snapshots cross-feature route inputs into the draft owned by evaluation execution. */
export function createEvaluationStartDraft(input: EvaluationStartDraftInput) {
  const suite = input.project.evaluationSuites.find(({ id }) => id === input.suiteId);
  const revision = input.project.conversationRevisions.find(({ id }) => id === suite?.input.conversationRevisionId);
  if (!revision) throw new Error("The selected conversation revision no longer exists.");
  // Confirmation names the revision the same way the selector and preflight did,
  // so the author confirms something they recognize rather than a bare timestamp.
  const revisionLabel = revisionChoice(
    describeConversationRevision(input.project, revision),
  ).label;
  const plan = createEvaluationExperimentPlan({
    project: input.project,
    suiteId: input.suiteId,
    selectedCaseIds: input.selectedCaseIds,
    runtimeTarget: {
        profileId: createEntityId("profile", input.profile.id),
        protocol: "openai-compatible-chat-completions",
        endpoint: input.profile.endpoint,
        capabilities: input.capabilities,
    },
  });
  return {
    revisionLabel,
    plan,
    // The plan-time join, exactly as `runtimeTarget` above: the plan carries
    // portable descriptors, and how this device serves them travels beside it.
    toolBindings: listExperimentToolBindings(
      experimentExposedTools(plan),
      input.bindingForTool,
    ),
    targetName: input.profile.name || "Untitled profile",
    storage: input.durable ? "durable" as const : "unsaved" as const,
  };
}
