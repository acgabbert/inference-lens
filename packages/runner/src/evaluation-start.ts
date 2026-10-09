import { createEvaluationExperimentPlan } from "../../core/src/evaluation-execution.ts";
import { resolveEvaluationVariant } from "../../core/src/evaluation-suites.ts";
import { experimentExposedTools } from "../../core/src/experiment.ts";
import type { ProjectFile } from "../../core/src/project.ts";
import { supportsProtocol } from "../../core/src/provider-protocols.ts";
import { createEntityId } from "../../core/src/run-kernel/types.ts";
import type {
  EvaluationCaseId,
  EvaluationSuiteId,
  EvaluationVariantId,
  InferenceOptions,
  ProviderWireProtocol,
  ResolvedRunInput,
  ToolDefinition,
} from "../../core/src/run-kernel/types.ts";
import { listExperimentToolBindings } from "../../core/src/tool-binding-resolution.ts";
import type { ToolBinding } from "../../core/src/tool-execution.ts";
import type { ProviderCapabilities } from "../../core/src/types.ts";
import { evaluationBatchSize } from "./evaluation-batch-limits.ts";
import type { EvaluationBatchLimit, EvaluationBatchSize } from "./evaluation-batch-limits.ts";

/** A connection on this host, whatever the host calls it: a device profile or a declared requirement. */
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
  /** The configuration's protocol: its own override, else the suite's. */
  protocol: ProviderWireProtocol;
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
        protocol: effective.target.protocol,
        model: effective.target.model,
        responseMode: effective.responseMode,
        options: effective.options,
        ...(profile ? { profile } : {}),
      };
    });
}

/**
 * Why an evaluation cannot start, as data. Each host phrases it for its own
 * medium: the app names its preflight controls, the CLI names project fields.
 */
export type EvaluationStartBlocker =
  | { kind: "suite_diagnostic"; message: string }
  | { kind: "no_configuration_selected" }
  | { kind: "batch_limit"; limit: EvaluationBatchLimit; size: EvaluationBatchSize }
  | { kind: "unbound_tools"; toolNames: string[] }
  | { kind: "profile_unmapped"; target: EvaluationResolvedLocalTarget }
  | { kind: "endpoint_missing"; target: EvaluationResolvedLocalTarget & { profile: EvaluationLocalProfile } }
  | { kind: "model_missing"; target: EvaluationResolvedLocalTarget }
  | { kind: "protocol_disabled"; target: EvaluationResolvedLocalTarget & { profile: EvaluationLocalProfile } }
  | { kind: "streaming_unsupported"; target: EvaluationResolvedLocalTarget & { profile: EvaluationLocalProfile } }
  | { kind: "tools_unsupported"; target: EvaluationResolvedLocalTarget & { profile: EvaluationLocalProfile } };

export interface EvaluationStartCheckInput {
  /** The suite preflight's findings, already phrased by core. */
  diagnostics: readonly { message: string }[];
  selectedCaseCount: number;
  selectedVariantCount: number;
  repetitions: number;
  /** The suite's exposed tools and whether anything on this host serves each one. */
  toolBindings: readonly { name: string; bound: boolean }[];
  turnCeiling?: number;
  targets: readonly EvaluationResolvedLocalTarget[];
}

/**
 * The first reason an evaluation cannot start on this host, in a fixed order:
 * authoring, cost, tools, then each configuration's connection.
 */
export function evaluationStartBlocker(input: EvaluationStartCheckInput): EvaluationStartBlocker | undefined {
  if (input.diagnostics[0]) return { kind: "suite_diagnostic", message: input.diagnostics[0].message };
  if (input.selectedVariantCount === 0) return { kind: "no_configuration_selected" };
  const size = evaluationBatchSize({
    selectedCases: input.selectedCaseCount,
    selectedVariants: input.selectedVariantCount,
    repetitions: input.repetitions,
    exposedToolCount: input.toolBindings.length,
    ...(input.turnCeiling === undefined ? {} : { turnCeiling: input.turnCeiling }),
  });
  if (size.limit) return { kind: "batch_limit", limit: size.limit, size };
  // An evaluation answers its own tool calls, so a tool nothing here can serve
  // would fail every repetition at a call nobody is present to answer.
  const unbound = input.toolBindings.filter(({ bound }) => !bound);
  if (unbound.length > 0) return { kind: "unbound_tools", toolNames: unbound.map(({ name }) => name) };
  for (const target of input.targets) {
    const { profile } = target;
    if (!profile) return { kind: "profile_unmapped", target };
    const mapped = { ...target, profile };
    if (!profile.endpoint.trim()) return { kind: "endpoint_missing", target: mapped };
    if (!target.model.trim()) return { kind: "model_missing", target };
    if (!supportsProtocol(profile.capabilities, target.protocol)) return { kind: "protocol_disabled", target: mapped };
    if (target.responseMode === "streaming" && !profile.capabilities.streaming) {
      return { kind: "streaming_unsupported", target: mapped };
    }
    if (input.toolBindings.length > 0 && !profile.capabilities.tools) {
      return { kind: "tools_unsupported", target: mapped };
    }
  }
  return undefined;
}

export interface EvaluationStartPlanInput {
  project: ProjectFile;
  suiteId: EvaluationSuiteId;
  selectedCaseIds: readonly EvaluationCaseId[];
  selectedVariantIds: readonly EvaluationVariantId[];
  profiles: readonly EvaluationLocalProfile[];
  mappedProfileIds: Readonly<Record<string, string>>;
  /** The host-local binding that will serve one of the suite's exposed tools. */
  bindingForTool(tool: ToolDefinition): ToolBinding | undefined;
}

/**
 * Freezes the plan a start would run, joined to this host's targets and tool
 * bindings. Callers check `evaluationStartBlocker` first; a throw here means
 * the project changed underneath that check.
 */
export function createEvaluationStartPlan(input: EvaluationStartPlanInput) {
  const suite = input.project.evaluationSuites.find(({ id }) => id === input.suiteId);
  if (!suite) throw new Error("The selected evaluation suite no longer exists.");
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
    protocol: target.protocol,
    endpoint: target.profile!.endpoint,
    capabilities: target.profile!.capabilities,
  }])) as Record<EvaluationVariantId, Omit<ResolvedRunInput["target"], "model">>;
  const plan = createEvaluationExperimentPlan({
    project: input.project,
    suiteId: input.suiteId,
    selectedCaseIds: input.selectedCaseIds,
    selectedVariantIds: input.selectedVariantIds,
    runtimeTargets,
  });
  return {
    plan,
    // The plan-time join, exactly as `runtimeTarget` above: the plan carries
    // portable descriptors, and how this host serves them travels beside it.
    toolBindings: listExperimentToolBindings(experimentExposedTools(plan), input.bindingForTool),
    targets,
  };
}
