import { CHECK_SCHEMA_VERSION } from "./checks.ts";
import { parseExperimentPlanFile } from "./experiment.ts";
import type { EvaluationExperimentPlanV3 } from "./experiment.ts";
import { resolveEvaluationCase } from "./evaluation-case-resolution.ts";
import { evaluationSuitePreflight } from "./evaluation-suites.ts";
import type { ProjectFile } from "./project.ts";
import { randomUUID } from "./random-id.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type {
  ConversationRevisionId,
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
  conversationRevisionId: ConversationRevisionId;
  selectedCaseIds: readonly EvaluationCaseId[];
  repetitions: number;
  /** Snapshot of confirmation-time execution settings; never contains credentials. */
  execution: Pick<ResolvedRunInput, "target" | "responseMode" | "options" | "tools">;
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
    conversationRevisionId,
    selectedCaseIds,
    execution,
  } = options;
  const diagnostics = evaluationSuitePreflight(
    project,
    suiteId,
    conversationRevisionId,
    selectedCaseIds,
  );
  if (diagnostics.length > 0) throw new EvaluationSetupError(diagnostics);
  if (execution.tools.length > 0) {
    throw new EvaluationSetupError([{
      code: "tools-exposed",
      message: "Evaluations do not support exposed tools yet. Disable tools before starting.",
    }]);
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new EvaluationSetupError([{
      code: "invalid-repetitions",
      message: "Evaluation repetitions must be a positive integer.",
    }]);
  }

  const suite = project.evaluationSuites.find(({ id }) => id === suiteId);
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
        target: structuredClone(execution.target),
        messages: resolved.messages,
        templateResolutions: resolved.templateResolutions,
        responseMode: execution.responseMode,
        options: structuredClone(execution.options),
        tools: structuredClone(execution.tools),
        resolvedAt: now,
      },
    };
  });

  let ordinal = 0;
  const cells = cases.flatMap((evaluationCase) =>
    Array.from({ length: options.repetitions }, (_, index) => ({
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
    repetitions: options.repetitions,
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
