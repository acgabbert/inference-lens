import type { ProviderCapabilities } from "../../packages/core/src/types.ts";
import type { InferenceOptions } from "../../packages/core/src/run-kernel/types.ts";
import { createEvaluationExperimentPlan } from "../../packages/core/src/evaluation-execution.ts";
import { resolveEvaluationVariant } from "../../packages/core/src/evaluation-suites.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/types.ts";
import type {
  EvaluationCaseId,
  EvaluationSuiteId,
  EvaluationVariantId,
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
  selectedVariantCount?: number;
  repetitions: number;
  /** The suite's exposed tools and what will serve each one on this device. */
  toolBindings: readonly { name: string; bound: boolean }[];
  /**
   * Why a command-bound tool cannot run in this shell, when that is the case.
   * Reported before the batch starts rather than as a failure per repetition.
   */
  commandToolsUnavailableReason?: string;
  turnCeiling?: number;
  targets: readonly EvaluationResolvedLocalTarget[];
  activityInProgress: boolean;
}

export interface EvaluationLocalProfile {
  id: string;
  name: string;
  endpoint: string;
  capabilities: ProviderCapabilities;
}

export interface EvaluationResolvedLocalTarget {
  variantId: EvaluationVariantId;
  variantName: string;
  requirementId: string;
  requirementName: string;
  model: string;
  responseMode: "streaming" | "buffered";
  options: InferenceOptions;
  profile?: EvaluationLocalProfile;
}

export function resolveEvaluationLocalTargets(input: {
  project: ProjectFile;
  suiteId: EvaluationSuiteId;
  selectedVariantIds: readonly EvaluationVariantId[];
  profiles: readonly EvaluationLocalProfile[];
  mappedProfileIds: Readonly<Record<string, string>>;
}): EvaluationResolvedLocalTarget[] {
  const suite = input.project.evaluationSuites.find(({ id }) => id === input.suiteId);
  if (!suite) return [];
  return suite.variants
    .filter(({ id }) => input.selectedVariantIds.includes(id))
    .map((variant) => {
      const effective = resolveEvaluationVariant(suite, variant);
      const requirement = input.project.connectionRequirements.find(
        ({ id }) => id === effective.target.connectionRequirementId,
      );
      const profile = input.profiles.find(
        ({ id }) => id === input.mappedProfileIds[effective.target.connectionRequirementId],
      );
      return {
        variantId: variant.id,
        variantName: variant.name,
        requirementId: effective.target.connectionRequirementId,
        requirementName: requirement?.name ?? effective.target.connectionRequirementId,
        model: effective.target.model,
        responseMode: effective.responseMode,
        options: effective.options,
        ...(profile ? { profile } : {}),
      };
    });
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
  const selectedVariantCount = input.selectedVariantCount ?? 1;
  if (selectedVariantCount === 0) return { blockedReason: "Select at least one configuration before starting." };
  const batch = evaluationBatchGuardrail(input.selectedCaseCount, selectedVariantCount, input.repetitions, {
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
  for (const target of input.targets) {
    if (!target.profile) {
      return { blockedReason: `Map “${target.requirementName}” to a local profile for configuration “${target.variantName}”.` };
    }
    if (!target.profile.endpoint.trim()) {
      return { blockedReason: `The profile mapped to configuration “${target.variantName}” needs an endpoint.` };
    }
    if (!target.model.trim()) {
      return { blockedReason: `Configuration “${target.variantName}” needs a model.` };
    }
    if (target.responseMode === "streaming" && !target.profile.capabilities.streaming) {
      return { blockedReason: `Configuration “${target.variantName}” uses streaming, but ${target.profile.name || "its mapped profile"} cannot stream. Choose buffered delivery.` };
    }
    if (input.toolBindings.length > 0 && !target.profile.capabilities.tools) {
      return { blockedReason: `Configuration “${target.variantName}” uses exposed tools, but ${target.profile.name || "its mapped profile"} cannot send tools.` };
    }
  }
  if (input.activityInProgress) return { blockedReason: "Finish or stop the current run first." };
  return {};
}

export interface EvaluationStartDraftInput {
  project: ProjectFile;
  suiteId: EvaluationSuiteId;
  selectedCaseIds: readonly EvaluationCaseId[];
  selectedVariantIds: readonly EvaluationVariantId[];
  profiles: readonly EvaluationLocalProfile[];
  mappedProfileIds: Readonly<Record<string, string>>;
  durable: boolean;
  /** The device-local binding that will serve one of the suite's exposed tools. */
  bindingForTool(toolId: ToolId): ToolBinding | undefined;
}

/** Snapshots cross-feature route inputs into the draft owned by evaluation execution. */
export function createEvaluationStartDraft(input: EvaluationStartDraftInput) {
  const suite = input.project.evaluationSuites.find(({ id }) => id === input.suiteId);
  if (!suite) throw new Error("The selected evaluation suite no longer exists.");
  const revision = input.project.conversationRevisions.find(({ id }) => id === suite?.input.conversationRevisionId);
  if (!revision) throw new Error("The selected conversation revision no longer exists.");
  // Confirmation names the revision the same way the selector and preflight did,
  // so the author confirms something they recognize rather than a bare timestamp.
  const revisionLabel = revisionChoice(
    describeConversationRevision(input.project, revision),
  ).label;
  const selectedVariants = suite.variants.filter(({ id }) => input.selectedVariantIds.includes(id));
  if (selectedVariants.length !== input.selectedVariantIds.length) {
    throw new Error("A selected evaluation configuration no longer exists.");
  }
  const targets = resolveEvaluationLocalTargets(input);
  if (targets.length !== selectedVariants.length) throw new Error("A selected evaluation configuration no longer exists.");
  const missing = targets.find(({ profile }) => !profile);
  if (missing) throw new Error(`Map “${missing.requirementName}” to a local profile for configuration “${missing.variantName}”.`);
  const runtimeTargets = Object.fromEntries(targets.map((target) => [target.variantId, {
    profileId: createEntityId("profile", target.profile!.id),
    protocol: "openai-compatible-chat-completions" as const,
    endpoint: target.profile!.endpoint,
    capabilities: target.profile!.capabilities,
  }])) as Record<EvaluationVariantId, Omit<import("../../packages/core/src/run-kernel/types.ts").ResolvedRunInput["target"], "model">>;
  const plan = createEvaluationExperimentPlan({
    project: input.project,
    suiteId: input.suiteId,
    selectedCaseIds: input.selectedCaseIds,
    selectedVariantIds: input.selectedVariantIds,
    runtimeTargets,
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
    targetNames: Object.fromEntries(targets.map(({ variantId, profile }) => [variantId, profile!.name || "Untitled profile"])) as Record<EvaluationVariantId, string>,
    storage: input.durable ? "durable" as const : "unsaved" as const,
  };
}
