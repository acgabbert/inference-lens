import { CHECK_SCHEMA_VERSION } from "./checks.ts";
import type { ResolvedDecisionTarget } from "./decision.ts";
import { prepareDecisionRequestRun } from "./decision-request.ts";
import { EXPERIMENT_SCHEMA_VERSION, parseExperimentPlanFile } from "./experiment.ts";
import type { DecisionEvaluationExperimentPlan, EvaluationExperimentPlan } from "./experiment.ts";
import { resolveEvaluationCase } from "./evaluation-case-resolution.ts";
import {
  evaluationSuitePreflight,
  isChatEvaluationSuite,
  isDecisionEvaluationSuite,
  resolveDecisionEvaluationVariant,
  resolveEvaluationVariant,
} from "./evaluation-suites.ts";
import type { ProjectFile } from "./project.ts";
import { randomUUID } from "./random-id.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type {
  EvaluationCaseId,
  EvaluationSuiteId,
  EvaluationVariantId,
  ResolvedRunInput,
} from "./run-kernel/types.ts";

export class EvaluationSetupError extends Error {
  readonly diagnostics: readonly { code: string; message: string }[];

  constructor(diagnostics: readonly { code: string; message: string }[]) {
    super(diagnostics[0]?.message ?? "The evaluation setup is invalid.");
    this.name = "EvaluationSetupError";
    this.diagnostics = diagnostics;
  }
}

export interface CreateEvaluationPlanOptions {
  project: ProjectFile;
  suiteId: EvaluationSuiteId;
  selectedCaseIds: readonly EvaluationCaseId[];
  selectedVariantIds?: readonly EvaluationVariantId[];
  /** Device-local target resolution keyed by selected authored configuration. */
  runtimeTargets?: Readonly<Record<EvaluationVariantId, Omit<ResolvedRunInput["target"], "model">>>;
  /** @deprecated Callers must resolve every selected configuration in runtimeTargets. */
  runtimeTarget?: Omit<ResolvedRunInput["target"], "model">;
  createdAt?: string;
  createSuffix?: () => string;
}

/**
 * Resolves authored project values and template defaults first, then applies
 * only the selected case bindings. Transient composer overrides never cross
 * this API, which makes their exclusion structural rather than conventional.
 */
export function createEvaluationExperimentPlan(
  options: CreateEvaluationPlanOptions,
): EvaluationExperimentPlan {
  const {
    project,
    suiteId,
    selectedCaseIds,
  } = options;
  const found = project.evaluationSuites.find(({ id }) => id === suiteId);
  if (found && !isChatEvaluationSuite(found)) {
    throw new EvaluationSetupError([{
      code: "unsupported-suite-kind",
      message: "Decision suites cannot be run by this build yet.",
    }]);
  }
  const suite = found;
  const conversationRevisionId = suite?.input.conversationRevisionId;
  if (!suite || !conversationRevisionId) {
    throw new EvaluationSetupError([{
      code: "missing-selection",
      message: "The selected evaluation suite or input revision no longer exists.",
    }]);
  }
  const diagnostics = evaluationSuitePreflight(
    project,
    suiteId,
    conversationRevisionId,
    selectedCaseIds,
  );
  if (diagnostics.length > 0) throw new EvaluationSetupError(diagnostics);
  if (!Number.isInteger(suite.execution.repetitions) || suite.execution.repetitions < 1) {
    throw new EvaluationSetupError([{
      code: "invalid-repetitions",
      message: "Evaluation repetitions must be a positive integer.",
    }]);
  }

  const revision = project.conversationRevisions.find(({ id }) => id === conversationRevisionId);
  if (!suite || !revision) {
    throw new EvaluationSetupError([{
      code: "missing-selection",
      message: "The selected evaluation suite or conversation revision no longer exists.",
    }]);
  }
  const selected = new Set(selectedCaseIds);
  const selectedCases = suite.cases.filter(({ id }) => selected.has(id));
  // Preflight diagnoses an empty explicit selection. This catches duplicate or
  // unknown IDs without silently changing the requested paid cell count.
  if (selectedCases.length !== selected.size) {
    throw new EvaluationSetupError([{
      code: "unknown-case",
      message: "One or more selected evaluation cases no longer exist.",
    }]);
  }
  const selectedVariants = new Set(options.selectedVariantIds ?? suite.variants.map(({ id }) => id));
  const variants = suite.variants.filter(({ id }) => selectedVariants.has(id));
  if (variants.length === 0) {
    throw new EvaluationSetupError([{
      code: "empty-configuration-selection",
      message: "Select at least one evaluation configuration before starting.",
    }]);
  }
  if (variants.length !== selectedVariants.size) {
    throw new EvaluationSetupError([{
      code: "unknown-configuration",
      message: "One or more selected evaluation configurations no longer exist.",
    }]);
  }

  const now = options.createdAt ?? new Date().toISOString();
  const suffix = options.createSuffix ?? randomUUID;
  // Snapshotted in project order rather than selection order, so the provider
  // sees the same list an ordinary run would send and two plans built from one
  // suite are byte-comparable. A missing ID cannot occur: the project schema
  // refuses to hold a suite that names a tool it does not have.
  const exposedTools = project.tools
    .filter(({ id }) => suite.execution.toolIds.includes(id))
    .map((tool) => structuredClone(tool));
  const cases = selectedCases.map((evaluationCase) => {
    // The same projection the focused-case preview renders, so what an author
    // approved and what the plan freezes cannot disagree.
    const resolved = resolveEvaluationCase(project, revision, suite, evaluationCase);
    if (!resolved.ok) {
      throw new EvaluationSetupError(resolved.diagnostics.map(({ diagnostic }) => ({
        code: diagnostic.code,
        message: diagnostic.message,
      })));
    }
    return {
      caseId: evaluationCase.id,
      name: evaluationCase.name,
      values: structuredClone(evaluationCase.values),
      checks: structuredClone(evaluationCase.checks),
      ...(evaluationCase.referenceAnswer === undefined
        ? {}
        : { referenceAnswer: evaluationCase.referenceAnswer }),
      input: {
        conversationId: revision.conversationId,
        conversationRevisionId: revision.id,
        messages: resolved.messages,
        templateResolutions: resolved.templateResolutions,
        resolvedAt: now,
      },
    };
  });
  const variantSnapshots = variants.map((variant) => {
    const effective = resolveEvaluationVariant(suite, variant);
    const runtimeTarget = options.runtimeTargets?.[variant.id] ?? options.runtimeTarget;
    if (!runtimeTarget) {
      throw new EvaluationSetupError([{
        code: "missing-runtime-target",
        message: `Configuration “${variant.name}” does not have a resolved local connection.`,
      }]);
    }
    return {
      variantId: variant.id,
      name: variant.name,
      target: { ...structuredClone(runtimeTarget), model: effective.target.model },
      responseMode: effective.responseMode,
      options: structuredClone(effective.options),
    };
  });

  let ordinal = 0;
  const cells = cases.flatMap((evaluationCase) => variantSnapshots.flatMap((variant) =>
    Array.from({ length: suite.execution.repetitions }, (_, index) => ({
      cellId: createEntityId("experiment-cell", suffix()),
      ordinal: ++ordinal,
      runId: createEntityId("run", suffix()),
      caseId: evaluationCase.caseId,
      variantId: variant.variantId,
      repetition: index + 1,
    })),
  ));
  const plan: EvaluationExperimentPlan = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: createEntityId("experiment", suffix()),
    kind: "evaluation",
    createdAt: now,
    checkSchemaVersion: CHECK_SCHEMA_VERSION,
    scoringPolicy: "strict",
    repetitions: suite.execution.repetitions,
    // Carried only when the suite authored one, so a plan built from a suite
    // that never touched the control stays identical to the plans this
    // evaluation produced before suites could expose tools at all.
    ...(suite.execution.turnCeiling === undefined
      ? {}
      : { turnCeiling: suite.execution.turnCeiling }),
    suite: {
      suiteId: suite.id,
      name: suite.name,
      conversationRevisionId: revision.id,
      inputBindings: structuredClone(suite.inputBindings),
      tools: structuredClone(exposedTools),
      cases,
      variants: variantSnapshots,
    },
    cells,
  };
  const parsed = parseExperimentPlanFile(plan);
  if (parsed.kind !== "evaluation") {
    throw new EvaluationSetupError([{
      code: "unexpected-plan-kind",
      message: "Evaluation setup produced an invalid experiment plan.",
    }]);
  }
  return parsed;
}

export interface CreateDecisionEvaluationPlanOptions {
  project: ProjectFile;
  suiteId: EvaluationSuiteId;
  selectedCaseIds: readonly EvaluationCaseId[];
  selectedVariantIds?: readonly EvaluationVariantId[];
  /** Device-local System One target keyed by selected configuration; the model is the suite's. */
  runtimeTargets: Readonly<Record<EvaluationVariantId, Omit<ResolvedDecisionTarget, "model">>>;
  createdAt?: string;
  createSuffix?: () => string;
}

/**
 * Freezes a decision suite (D47): each case's request is resolved once, with
 * its values over the pinned revision's (D45), and every repetition sends
 * exactly that request. Preflight runs first, so a plan never holds a request
 * that would be refused.
 */
export function createDecisionEvaluationExperimentPlan(
  options: CreateDecisionEvaluationPlanOptions,
): DecisionEvaluationExperimentPlan {
  const { project, suiteId, selectedCaseIds } = options;
  const suite = project.evaluationSuites.find(({ id }) => id === suiteId);
  if (suite && !isDecisionEvaluationSuite(suite)) {
    throw new EvaluationSetupError([{
      code: "unsupported-suite-kind",
      message: "A chat suite runs as a chat evaluation, not a decision evaluation.",
    }]);
  }
  const revision = suite
    ? project.decisionRequestRevisions.find(({ id }) => id === suite.input.decisionRequestRevisionId)
    : undefined;
  if (!suite || !revision) {
    throw new EvaluationSetupError([{
      code: "missing-selection",
      message: "The selected evaluation suite or decision request revision no longer exists.",
    }]);
  }
  const diagnostics = evaluationSuitePreflight(project, suiteId, project.defaults.conversationRevisionId, selectedCaseIds);
  if (diagnostics.length > 0) throw new EvaluationSetupError(diagnostics);
  if (!Number.isInteger(suite.execution.repetitions) || suite.execution.repetitions < 1) {
    throw new EvaluationSetupError([{
      code: "invalid-repetitions",
      message: "Evaluation repetitions must be a positive integer.",
    }]);
  }
  const selected = new Set(selectedCaseIds);
  const selectedCases = suite.cases.filter(({ id }) => selected.has(id));
  if (selectedCases.length !== selected.size) {
    throw new EvaluationSetupError([{
      code: "unknown-case",
      message: "One or more selected evaluation cases no longer exist.",
    }]);
  }
  const selectedVariants = new Set(options.selectedVariantIds ?? suite.variants.map(({ id }) => id));
  const variants = suite.variants.filter(({ id }) => selectedVariants.has(id));
  if (variants.length === 0) {
    throw new EvaluationSetupError([{
      code: "empty-configuration-selection",
      message: "Select at least one evaluation configuration before starting.",
    }]);
  }
  if (variants.length !== selectedVariants.size) {
    throw new EvaluationSetupError([{
      code: "unknown-configuration",
      message: "One or more selected evaluation configurations no longer exist.",
    }]);
  }

  const now = options.createdAt ?? new Date().toISOString();
  const suffix = options.createSuffix ?? randomUUID;
  const cases = selectedCases.map((evaluationCase) => {
    const values: Record<string, string> = { ...revision.values };
    for (const binding of suite.inputBindings) {
      const value = evaluationCase.values[binding.id];
      if (value !== undefined) values[binding.target.variableName] = value;
    }
    const prepared = prepareDecisionRequestRun(revision.decision, values);
    if (!prepared.ok) {
      throw new EvaluationSetupError(prepared.diagnostics.map(({ code, message }) => ({ code, message })));
    }
    return {
      caseId: evaluationCase.id,
      name: evaluationCase.name,
      values: structuredClone(evaluationCase.values),
      checks: structuredClone(evaluationCase.checks),
      ...(evaluationCase.referenceAnswer === undefined
        ? {}
        : { referenceAnswer: evaluationCase.referenceAnswer }),
      input: {
        decisionRequestId: revision.decisionRequestId,
        decisionRequestRevisionId: revision.id,
        decision: prepared.decision,
        resolvedAt: now,
      },
    };
  });
  const variantSnapshots = variants.map((variant) => {
    const target = resolveDecisionEvaluationVariant(suite, variant);
    const runtimeTarget = options.runtimeTargets[variant.id];
    if (!runtimeTarget) {
      throw new EvaluationSetupError([{
        code: "missing-runtime-target",
        message: `Configuration “${variant.name}” does not have a resolved local connection.`,
      }]);
    }
    return {
      variantId: variant.id,
      name: variant.name,
      target: { ...structuredClone(runtimeTarget), model: target.model },
    };
  });

  let ordinal = 0;
  const cells = cases.flatMap((evaluationCase) => variantSnapshots.flatMap((variant) =>
    Array.from({ length: suite.execution.repetitions }, (_, index) => ({
      cellId: createEntityId("experiment-cell", suffix()),
      ordinal: ++ordinal,
      runId: createEntityId("run", suffix()),
      caseId: evaluationCase.caseId,
      variantId: variant.variantId,
      repetition: index + 1,
    })),
  ));
  const plan: DecisionEvaluationExperimentPlan = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: createEntityId("experiment", suffix()),
    kind: "decision-evaluation",
    createdAt: now,
    checkSchemaVersion: CHECK_SCHEMA_VERSION,
    scoringPolicy: "strict",
    repetitions: suite.execution.repetitions,
    suite: {
      suiteId: suite.id,
      name: suite.name,
      decisionRequestRevisionId: revision.id,
      inputBindings: structuredClone(suite.inputBindings),
      cases,
      variants: variantSnapshots,
    },
    cells,
  };
  const parsed = parseExperimentPlanFile(plan);
  if (parsed.kind !== "decision-evaluation") {
    throw new EvaluationSetupError([{
      code: "unexpected-plan-kind",
      message: "Evaluation setup produced an invalid experiment plan.",
    }]);
  }
  return parsed;
}
