import type {
  CheckId,
  ConnectionRequirementId,
  ConversationRevisionId,
  EvaluationCaseId,
  EvaluationInputBindingId,
  EvaluationSuiteId,
  PromptTemplateUseId,
  InferenceOptions,
} from "./run-kernel/types.ts";
import type { CheckDefinition } from "./checks.ts";
import { resolveEvaluationCase } from "./evaluation-case-resolution.ts";
import type { ProjectFile } from "./project.ts";
import { templateUseVariableIndex } from "./template-use-variable-index.ts";
export { templateUseVariableIndex } from "./template-use-variable-index.ts";

export interface EvaluationInputBinding {
  id: EvaluationInputBindingId;
  name: string;
  target: {
    kind: "template-variable";
    templateUseId: PromptTemplateUseId;
    variableName: string;
  };
}

export interface EvaluationCase {
  id: EvaluationCaseId;
  name: string;
  values: Record<EvaluationInputBindingId, string>;
  checks: CheckDefinition[];
  referenceAnswer?: string;
}

/** Authored, provider-neutral evaluation content. */
export interface EvaluationSuite {
  id: EvaluationSuiteId;
  name: string;
  /** The immutable authored input this suite resolves independently of Messages. */
  input: {
    kind: "conversation-revision";
    conversationRevisionId: ConversationRevisionId;
  };
  /** Portable execution preferences. Credentials and local profile identity never enter project data. */
  execution: {
    target: {
      connectionRequirementId: ConnectionRequirementId;
      model: string;
    };
    responseMode: "streaming" | "buffered";
    options: InferenceOptions;
    repetitions: number;
  };
  inputBindings: EvaluationInputBinding[];
  cases: EvaluationCase[];
}

export type EvaluationSuitePreflightDiagnostic =
  | { code: "empty-suite"; message: string }
  | { code: "no-cases-selected"; message: string }
  | {
      code: "missing-template-use";
      inputBindingId: EvaluationInputBindingId;
      templateUseId: PromptTemplateUseId;
      message: string;
    }
  | {
      code: "missing-template-variable";
      inputBindingId: EvaluationInputBindingId;
      templateUseId: PromptTemplateUseId;
      variableName: string;
      message: string;
    }
  | {
      code: "empty-case-value";
      caseId: EvaluationCaseId;
      inputBindingId: EvaluationInputBindingId;
      message: string;
    }
  | {
      code: "unfinished-check";
      caseId: EvaluationCaseId;
      checkId: CheckId;
      message: string;
    }
  | {
      code: "no-checks";
      caseId: EvaluationCaseId;
      message: string;
    }
  | {
      code: "unresolved-template-variable";
      caseId: EvaluationCaseId;
      templateUseId: PromptTemplateUseId;
      variableName: string;
      message: string;
    };

/**
 * A text check whose expected text is still empty is what "+ Add check" leaves
 * behind: `contains ""` passes against every possible answer, and `exact-match
 * ""` asserts an empty answer, which is almost never what the author meant to
 * write. Reporting it during authoring is the last chance to catch it before
 * an execution spends provider calls proving nothing.
 */
function unfinishedCheckText(check: CheckDefinition): boolean {
  return (
    (check.kind === "contains" || check.kind === "exact-match") &&
    check.value === ""
  ) || (check.kind === "regex" && check.pattern === "");
}

/** Pure, provider-free authoring preflight for a selected suite and revision. */
export function evaluationSuitePreflight(
  project: Pick<ProjectFile, "evaluationSuites" | "conversationRevisions" | "promptTemplates">,
  evaluationSuiteId: EvaluationSuiteId,
  conversationRevisionId: ConversationRevisionId,
  selectedCaseIds?: readonly EvaluationCaseId[],
): EvaluationSuitePreflightDiagnostic[] {
  const suite = project.evaluationSuites.find(({ id }) => id === evaluationSuiteId);
  const revision = project.conversationRevisions.find(({ id }) => id === conversationRevisionId);
  if (!suite || !revision) return [];

  const diagnostics: EvaluationSuitePreflightDiagnostic[] = [];
  if (suite.cases.length === 0) {
    diagnostics.push({ code: "empty-suite", message: "Add at least one case before running this suite." });
  } else if (selectedCaseIds && selectedCaseIds.length === 0) {
    diagnostics.push({ code: "no-cases-selected", message: "Select at least one case before running this suite." });
  }

  const selectedCases = selectedCaseIds
    ? suite.cases.filter(({ id }) => selectedCaseIds.includes(id))
    : suite.cases;
  const uses = templateUseVariableIndex([revision], project.promptTemplates);
  const bindingsMatchRevision = suite.inputBindings.every((binding) => {
    const occurrence = uses.get(binding.target.templateUseId)?.[0];
    return occurrence?.variables.has(binding.target.variableName) ?? false;
  });
  selectedCases.forEach((evaluationCase) => {
    if (evaluationCase.checks.length === 0) {
      diagnostics.push({
        code: "no-checks",
        caseId: evaluationCase.id,
        message: `Case "${evaluationCase.name}" needs at least one deterministic check before it can run.`,
      });
    }
    suite.inputBindings.forEach((binding) => {
      if ((evaluationCase.values[binding.id] ?? "").trim() !== "") return;
      diagnostics.push({
        code: "empty-case-value",
        caseId: evaluationCase.id,
        inputBindingId: binding.id,
        message: `Case "${evaluationCase.name}" has no value for input "${binding.name}".`,
      });
    });
    evaluationCase.checks.forEach((check) => {
      if (!unfinishedCheckText(check)) return;
      diagnostics.push({
        code: "unfinished-check",
        caseId: evaluationCase.id,
        checkId: check.checkId,
        message: check.kind === "regex"
          ? `A regex check on case "${evaluationCase.name}" needs a pattern.`
          : `A ${check.kind} check on case "${evaluationCase.name}" has no expected text yet.`,
      });
    });

    // A binding the revision cannot satisfy is already reported once, below, as
    // a suite-level incompatibility. Repeating it per case would bury the one
    // fact the author needs behind a row for every case.
    if (!bindingsMatchRevision) return;

    const resolution = resolveEvaluationCase(project, revision, suite, evaluationCase);
    if (resolution.ok) return;
    resolution.diagnostics.forEach(({ templateUseId, diagnostic }) => {
      if (diagnostic.code !== "missing-template-variable") return;
      diagnostics.push({
        code: "unresolved-template-variable",
        caseId: evaluationCase.id,
        templateUseId,
        variableName: diagnostic.name,
        message: `Case "${evaluationCase.name}" cannot resolve template variable "${diagnostic.name}": ${diagnostic.message}`,
      });
    });
  });

  suite.inputBindings.forEach((binding) => {
    const occurrence = uses.get(binding.target.templateUseId)?.[0];
    if (!occurrence) {
      diagnostics.push({
        code: "missing-template-use",
        inputBindingId: binding.id,
        templateUseId: binding.target.templateUseId,
        message: `Selected revision does not contain template use "${binding.target.templateUseId}".`,
      });
    } else if (!occurrence.variables.has(binding.target.variableName)) {
      diagnostics.push({
        code: "missing-template-variable",
        inputBindingId: binding.id,
        templateUseId: binding.target.templateUseId,
        variableName: binding.target.variableName,
        message: `Template use "${binding.target.templateUseId}" does not contain variable "${binding.target.variableName}" in the selected revision.`,
      });
    }
  });
  return diagnostics;
}
