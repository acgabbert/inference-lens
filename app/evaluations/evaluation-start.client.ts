import type { ProviderCapabilities } from "../../packages/core/src/types.ts";
import { createEvaluationExperimentPlan } from "../../packages/core/src/evaluation-execution.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/types.ts";
import type {
  ConversationRevisionId,
  EvaluationCaseId,
  EvaluationSuiteId,
} from "../../packages/core/src/run-kernel/types.ts";
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
  selectedToolCount: number;
  connectionMapped: boolean;
  hasProjectMapping: boolean;
  endpoint: string;
  model: string;
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
  const batch = evaluationBatchGuardrail(input.selectedCaseCount, input.repetitions);
  if (batch.error) return { blockedReason: batch.error };
  if (input.selectedToolCount > 0) {
    return { blockedReason: "Evaluations do not support exposed tools yet. Disable tools before starting." };
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
  if (input.activityInProgress) return { blockedReason: "Finish or stop the current run first." };
  return {};
}

export interface EvaluationStartDraftInput {
  project: ProjectFile;
  suiteId: EvaluationSuiteId;
  revisionId: ConversationRevisionId;
  selectedCaseIds: readonly EvaluationCaseId[];
  repetitions: number;
  profile: { id: string; name: string; endpoint: string };
  model: string;
  capabilities: ProviderCapabilities;
  responseMode: "streaming" | "buffered";
  temperature: number;
  durable: boolean;
}

/** Snapshots cross-feature route inputs into the draft owned by evaluation execution. */
export function createEvaluationStartDraft(input: EvaluationStartDraftInput) {
  const revision = input.project.conversationRevisions.find(({ id }) => id === input.revisionId);
  if (!revision) throw new Error("The selected conversation revision no longer exists.");
  // Confirmation names the revision the same way the selector and preflight did,
  // so the author confirms something they recognize rather than a bare timestamp.
  const revisionLabel = revisionChoice(
    describeConversationRevision(input.project, revision),
  ).label;
  return {
    revisionLabel,
    plan: createEvaluationExperimentPlan({
      project: input.project,
      suiteId: input.suiteId,
      conversationRevisionId: input.revisionId,
      selectedCaseIds: input.selectedCaseIds,
      repetitions: input.repetitions,
      execution: {
        target: {
          profileId: createEntityId("profile", input.profile.id),
          protocol: "openai-compatible-chat-completions",
          endpoint: input.profile.endpoint,
          model: input.model,
          capabilities: input.capabilities,
        },
        responseMode: input.responseMode,
        options: { temperature: input.temperature },
        tools: [],
      },
    }),
    targetName: input.profile.name || "Untitled profile",
    storage: input.durable ? "durable" as const : "unsaved" as const,
  };
}
