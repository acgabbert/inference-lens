import type {
  InferenceOptions,
  ProviderWireProtocol,
} from "../../packages/core/src/run-kernel/types.ts";
import { protocolLabel } from "../../packages/core/src/provider-protocols.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type {
  ConversationRevisionId,
  EvaluationSuiteId,
  EvaluationVariantId,
} from "../../packages/core/src/run-kernel/types.ts";
import type { ExperimentToolBinding } from "../../packages/core/src/tool-binding-resolution.ts";
import { describeConversationRevision } from "../../packages/core/src/conversation-revision-description.ts";
import {
  createEvaluationStartPlan,
  evaluationStartBlocker,
  resolveEvaluationLocalTargets,
} from "../../packages/runner/src/evaluation-start.ts";
import type {
  EvaluationLocalProfile,
  EvaluationResolvedLocalTarget,
  EvaluationStartBlocker,
  EvaluationStartPlanInput,
} from "../../packages/runner/src/evaluation-start.ts";
import { evaluationBatchLimitMessage } from "./evaluation-batch.client.ts";
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

/** The app's wording for a blocker, naming the preflight control that clears it. */
function startBlockerMessage(blocker: EvaluationStartBlocker, commandToolsUnavailableReason?: string): string {
  switch (blocker.kind) {
    case "suite_diagnostic":
      return blocker.message;
    case "no_configuration_selected":
      return "Select at least one configuration before starting.";
    case "batch_limit":
      return evaluationBatchLimitMessage(blocker.limit, blocker.size);
    case "unbound_tools": {
      const { toolNames } = blocker;
      return `This suite exposes ${toolNames.join(", ")}, and nothing on this device can serve ${
        toolNames.length === 1 ? "it" : "them"
      }. Enable a mock or grant a command tool first.${
        commandToolsUnavailableReason ? ` ${commandToolsUnavailableReason}` : ""
      }`;
    }
    case "profile_unmapped":
      return `Map “${blocker.target.requirementName}” to a local profile for configuration “${blocker.target.variantName}”.`;
    case "endpoint_missing":
      return `The profile mapped to configuration “${blocker.target.variantName}” needs an endpoint.`;
    case "model_missing":
      return `Configuration “${blocker.target.variantName}” needs a model.`;
    case "protocol_disabled":
      return `Configuration “${blocker.target.variantName}” uses ${protocolLabel(blocker.target.protocol)}, but ${blocker.target.profile.name || "its mapped profile"} does not have it enabled.`;
    case "streaming_unsupported":
      return `Configuration “${blocker.target.variantName}” uses streaming, but ${blocker.target.profile.name || "its mapped profile"} cannot stream. Choose buffered delivery.`;
    case "tools_unsupported":
      return `Configuration “${blocker.target.variantName}” uses exposed tools, but ${blocker.target.profile.name || "its mapped profile"} cannot send tools.`;
  }
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
  const blocker = evaluationStartBlocker({
    diagnostics: input.diagnostics,
    selectedCaseCount: input.selectedCaseCount,
    selectedVariantCount: input.selectedVariantCount ?? 1,
    repetitions: input.repetitions,
    toolBindings: input.toolBindings,
    ...(input.turnCeiling === undefined ? {} : { turnCeiling: input.turnCeiling }),
    targets: input.targets,
  });
  if (blocker) return { blockedReason: startBlockerMessage(blocker, input.commandToolsUnavailableReason) };
  if (input.activityInProgress) return { blockedReason: "Finish or stop the current run first." };
  return {};
}

export interface EvaluationWorkspaceExecutionInput {
  project: ProjectFile | null;
  suiteId?: EvaluationSuiteId;
  revisionId?: ConversationRevisionId;
  diagnostics: readonly { message: string }[];
  selectedCaseCount: number;
  selectedVariantIds: readonly EvaluationVariantId[];
  profiles: readonly EvaluationLocalProfile[];
  mappedProfileIds: Readonly<Record<string, string>>;
  /** What serves each of the project's tools on this device; filtered to the suite's here. */
  toolBindings: readonly ExperimentToolBinding[];
  commandToolsUnavailableReason?: string;
  /** Whether any other run or batch is in progress. */
  activityInProgress: boolean;
}

/** The exact target and settings one selected configuration would snapshot. */
export interface EvaluationTargetPreview {
  variantId: EvaluationVariantId;
  variantName: string;
  requirementName: string;
  targetName?: string;
  endpoint?: string;
  protocol: ProviderWireProtocol;
  model: string;
  responseMode: "streaming" | "buffered";
  options: InferenceOptions;
  streamingAvailable: boolean;
}

export interface EvaluationWorkspaceExecution {
  targets: EvaluationResolvedLocalTarget[];
  previewTargets: EvaluationTargetPreview[];
  disabledReason?: string;
}

/**
 * Joins the suite being authored to this device's profiles and tools. The
 * preflight and the provider-input preview both read the result, so they
 * report the same target and the same reason a start is refused.
 */
export function evaluationWorkspaceExecution(
  input: EvaluationWorkspaceExecutionInput,
): EvaluationWorkspaceExecution {
  const suite = input.project?.evaluationSuites.find(({ id }) => id === input.suiteId);
  const targets = input.project && suite
    ? resolveEvaluationLocalTargets({
        project: input.project,
        suiteId: suite.id,
        selectedVariantIds: input.selectedVariantIds,
        profiles: input.profiles,
        mappedProfileIds: input.mappedProfileIds,
      })
    : [];
  const { blockedReason } = evaluationStartReadiness({
    projectOpen: Boolean(input.project),
    suiteSelected: Boolean(input.suiteId),
    revisionSelected: Boolean(input.revisionId),
    revisionAvailable: Boolean(input.project?.conversationRevisions.some(
      ({ id }) => id === input.revisionId,
    )),
    diagnostics: input.diagnostics,
    selectedCaseCount: input.selectedCaseCount,
    selectedVariantCount: input.selectedVariantIds.length,
    repetitions: suite?.execution.repetitions ?? 1,
    toolBindings: input.toolBindings
      .filter(({ tool }) => suite?.execution.toolIds.includes(tool.id))
      .map(({ tool, binding }) => ({ name: tool.name, bound: Boolean(binding) })),
    ...(input.commandToolsUnavailableReason
      ? { commandToolsUnavailableReason: input.commandToolsUnavailableReason }
      : {}),
    ...(suite?.execution.turnCeiling === undefined
      ? {}
      : { turnCeiling: suite.execution.turnCeiling }),
    targets,
    activityInProgress: input.activityInProgress,
  });
  return {
    targets,
    previewTargets: targets.map((target) => ({
      variantId: target.variantId,
      variantName: target.variantName,
      requirementName: target.requirementName,
      ...(target.profile
        ? { targetName: target.profile.name || "Untitled profile", endpoint: target.profile.endpoint }
        : {}),
      protocol: target.protocol,
      model: target.model,
      responseMode: target.responseMode,
      options: target.options,
      streamingAvailable: target.profile?.capabilities.streaming ?? false,
    })),
    ...(blockedReason ? { disabledReason: blockedReason } : {}),
  };
}

export interface EvaluationStartDraftInput extends EvaluationStartPlanInput {
  durable: boolean;
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
  const { plan, toolBindings, targets } = createEvaluationStartPlan(input);
  return {
    revisionLabel,
    plan,
    toolBindings,
    targetNames: Object.fromEntries(targets.map(({ variantId, profile }) => [variantId, profile!.name || "Untitled profile"])) as Record<EvaluationVariantId, string>,
    storage: input.durable ? "durable" as const : "unsaved" as const,
  };
}
