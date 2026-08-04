import { CHECK_SCHEMA_VERSION } from "./checks.ts";
import { parseExperimentPlanFile } from "./experiment.ts";
import type { EvaluationExperimentPlanV3 } from "./experiment.ts";
import { resolveEvaluationCase } from "./evaluation-case-resolution.ts";
import { evaluationSuitePreflight } from "./evaluation-suites.ts";
import type { ProjectFile } from "./project.ts";
import { randomUUID } from "./random-id.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type {
  EvaluationCaseId,
  EvaluationSuiteId,
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
  /** Device-local target resolution; authored model and options come only from the suite. */
  runtimeTarget: Omit<ResolvedRunInput["target"], "model">;
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
): EvaluationExperimentPlanV3 {
  const {
    project,
    suiteId,
    selectedCaseIds,
  } = options;
  const suite = project.evaluationSuites.find(({ id }) => id === suiteId);
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
        target: {
          ...structuredClone(options.runtimeTarget),
          model: suite.execution.target.model,
        },
        messages: resolved.messages,
        templateResolutions: resolved.templateResolutions,
        responseMode: suite.execution.responseMode,
        options: structuredClone(suite.execution.options),
        tools: structuredClone(exposedTools),
        resolvedAt: now,
      },
    };
  });

  let ordinal = 0;
  const cells = cases.flatMap((evaluationCase) =>
    Array.from({ length: suite.execution.repetitions }, (_, index) => ({
      cellId: createEntityId("experiment-cell", suffix()),
      ordinal: ++ordinal,
      runId: createEntityId("run", suffix()),
      caseId: evaluationCase.caseId,
      repetition: index + 1,
    })),
  );
  const plan: EvaluationExperimentPlanV3 = {
    schemaVersion: 3,
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
      cases,
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
