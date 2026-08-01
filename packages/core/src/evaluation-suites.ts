import type {
  CheckId,
  ConversationRevisionId,
  EvaluationCaseId,
  EvaluationInputBindingId,
  EvaluationSuiteId,
  PromptTemplateUseId,
} from "./run-kernel/types.ts";
import type { CheckDefinition } from "./checks.ts";
import { discoverTemplateVariables } from "./template-engine.ts";
import type {
  ProjectConversationRevision,
  ProjectFile,
  PromptTemplate,
} from "./project.ts";

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
  inputBindings: EvaluationInputBinding[];
  cases: EvaluationCase[];
}

export interface TemplateUseVariableOccurrence {
  revisionId: ConversationRevisionId;
  variables: ReadonlySet<string>;
}

/**
 * Indexes the variables exposed by each stable template-use identity. Project
 * validation asks for all revisions; authoring preflight asks for one. Keeping
 * the walk here prevents those contracts from drifting as suite execution is
 * added later.
 */
export function templateUseVariableIndex(
  revisions: readonly ProjectConversationRevision[],
  templates: readonly PromptTemplate[],
): ReadonlyMap<PromptTemplateUseId, readonly TemplateUseVariableOccurrence[]> {
  const templatesById = new Map(templates.map((template) => [template.id, template]));
  const uses = new Map<PromptTemplateUseId, TemplateUseVariableOccurrence[]>();
  revisions.forEach((revision) => {
    revision.items.forEach((item) => {
      if (item.kind !== "template-use") return;
      const templateRevision = templatesById
        .get(item.use.templateId)
        ?.revisions.find(({ id }) => id === item.use.templateRevisionId);
      if (!templateRevision) return;
      const occurrences = uses.get(item.use.id) ?? [];
      occurrences.push({
        revisionId: revision.id,
        variables: new Set(
          discoverTemplateVariables(templateRevision.messages).variables.map(({ name }) => name),
        ),
      });
      uses.set(item.use.id, occurrences);
    });
  });
  return uses;
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
  );
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
  selectedCases.forEach((evaluationCase) => {
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
        message: `A ${check.kind} check on case "${evaluationCase.name}" has no expected text yet.`,
      });
    });
  });

  const uses = templateUseVariableIndex([revision], project.promptTemplates);
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

