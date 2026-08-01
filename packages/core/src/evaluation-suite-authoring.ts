import { parseCheckDefinition } from "./checks.ts";
import type { CheckDefinition, CheckKind } from "./checks.ts";
import { evaluationSuitePreflight, templateUseVariableIndex } from "./evaluation-suites.ts";
import type { EvaluationCase, EvaluationInputBinding, EvaluationSuite } from "./evaluation-suites.ts";
import { parseProjectFile } from "./project.ts";
import type { ProjectFile } from "./project.ts";
import { randomUUID } from "./random-id.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type {
  CheckId,
  ConversationRevisionId,
  EvaluationCaseId,
  EvaluationInputBindingId,
  EvaluationSuiteId,
  PromptTemplateUseId,
} from "./run-kernel/types.ts";

export { evaluationSuitePreflight };

export interface EvaluationBindingCandidate {
  templateUseId: PromptTemplateUseId;
  templateName: string;
  variableName: string;
}

type NonRegexCheckKind = Exclude<CheckKind, "regex">;

/** The complete information required before a check enters portable project data. */
export type NewEvaluationCheck =
  | { kind: NonRegexCheckKind }
  | { kind: "regex"; pattern: string; flags?: string };

export function evaluationBindingCandidates(
  project: ProjectFile,
  revisionId: ConversationRevisionId,
): EvaluationBindingCandidate[] {
  const revision = project.conversationRevisions.find(({ id }) => id === revisionId);
  if (!revision) return [];
  const occurrences = templateUseVariableIndex([revision], project.promptTemplates);
  const templates = new Map(project.promptTemplates.map((template) => [template.id, template]));
  return revision.items.flatMap((item) => {
    if (item.kind !== "template-use") return [];
    const variables = occurrences.get(item.use.id)?.[0]?.variables ?? [];
    const templateName = templates.get(item.use.templateId)?.name ?? item.use.templateId;
    return [...variables].map((variableName) => ({
      templateUseId: item.use.id,
      templateName,
      variableName,
    }));
  });
}

type IdSuffix = () => string;
const generatedSuffix: IdSuffix = randomUUID;

function updatedSuites(project: ProjectFile, suites: EvaluationSuite[]): ProjectFile {
  return parseProjectFile({ ...project, evaluationSuites: suites });
}

function mapSuite(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  update: (suite: EvaluationSuite) => EvaluationSuite,
): ProjectFile {
  return updatedSuites(project, project.evaluationSuites.map((suite) =>
    suite.id === suiteId ? update(structuredClone(suite)) : suite,
  ));
}

function uniqueName(base: string, occupied: readonly string[]): string {
  const names = new Set(occupied.map((name) => name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let number = 2; ; number += 1) {
    const candidate = `${base} ${number}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

export function createEvaluationSuite(
  project: ProjectFile,
  name = "Untitled evaluation",
  suffix: IdSuffix = generatedSuffix,
): { project: ProjectFile; suiteId: EvaluationSuiteId } {
  const suiteId = createEntityId("evaluation-suite", suffix());
  return {
    suiteId,
    project: updatedSuites(project, [...project.evaluationSuites, {
      id: suiteId,
      name: uniqueName(name, project.evaluationSuites.map(({ name: existing }) => existing)),
      inputBindings: [],
      cases: [],
    }]),
  };
}

export function renameEvaluationSuite(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  name: string,
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({ ...suite, name }));
}

export function removeEvaluationSuite(project: ProjectFile, suiteId: EvaluationSuiteId): ProjectFile {
  return updatedSuites(project, project.evaluationSuites.filter(({ id }) => id !== suiteId));
}

export function addEvaluationInput(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  candidate: Pick<EvaluationBindingCandidate, "templateUseId" | "variableName">,
  suffix: IdSuffix = generatedSuffix,
): { project: ProjectFile; inputId: EvaluationInputBindingId } {
  const inputId = createEntityId("evaluation-input", suffix());
  const next = mapSuite(project, suiteId, (suite) => {
    const binding: EvaluationInputBinding = {
      id: inputId,
      name: uniqueName(candidate.variableName, suite.inputBindings.map(({ name }) => name)),
      target: {
        kind: "template-variable",
        templateUseId: candidate.templateUseId,
        variableName: candidate.variableName,
      },
    };
    return {
      ...suite,
      inputBindings: [...suite.inputBindings, binding],
      cases: suite.cases.map((evaluationCase) => ({
        ...evaluationCase,
        values: { ...evaluationCase.values, [inputId]: "" },
      })),
    };
  });
  return { project: next, inputId };
}

export function renameEvaluationInput(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  inputId: EvaluationInputBindingId,
  name: string,
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({
    ...suite,
    inputBindings: suite.inputBindings.map((binding) =>
      binding.id === inputId ? { ...binding, name } : binding,
    ),
  }));
}

export function removeEvaluationInput(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  inputId: EvaluationInputBindingId,
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({
    ...suite,
    inputBindings: suite.inputBindings.filter(({ id }) => id !== inputId),
    cases: suite.cases.map((evaluationCase) => {
      const values = { ...evaluationCase.values };
      delete values[inputId];
      return { ...evaluationCase, values };
    }),
  }));
}

export function addEvaluationCase(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  suffix: IdSuffix = generatedSuffix,
): { project: ProjectFile; caseId: EvaluationCaseId } {
  const caseId = createEntityId("evaluation-case", suffix());
  const next = mapSuite(project, suiteId, (suite) => {
    const evaluationCase: EvaluationCase = {
      id: caseId,
      name: uniqueName("Untitled case", suite.cases.map(({ name }) => name)),
      values: Object.fromEntries(suite.inputBindings.map(({ id }) => [id, ""])) as EvaluationCase["values"],
      checks: [],
    };
    return { ...suite, cases: [...suite.cases, evaluationCase] };
  });
  return { project: next, caseId };
}

export function updateEvaluationCase(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  caseId: EvaluationCaseId,
  patch: { name?: string; referenceAnswer?: string; values?: EvaluationCase["values"] },
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({
    ...suite,
    cases: suite.cases.map((evaluationCase) => {
      if (evaluationCase.id !== caseId) return evaluationCase;
      const next = { ...evaluationCase, ...patch };
      if ("referenceAnswer" in patch && patch.referenceAnswer === undefined) delete next.referenceAnswer;
      return next;
    }),
  }));
}

export function removeEvaluationCase(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  caseId: EvaluationCaseId,
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({
    ...suite,
    cases: suite.cases.filter(({ id }) => id !== caseId),
  }));
}

/** Every created check is valid before it enters portable project data. */
export function defaultCheck(
  input: NewEvaluationCheck,
  suffix: IdSuffix = generatedSuffix,
): CheckDefinition {
  const checkId = createEntityId("check", suffix()) as CheckId;
  switch (input.kind) {
    case "exact-match": return { checkId, kind: input.kind, value: "" };
    case "contains": return { checkId, kind: input.kind, value: "" };
    case "regex": return parseCheckDefinition({
      checkId,
      kind: input.kind,
      syntax: "re2",
      pattern: input.pattern,
      ...(input.flags ? { flags: input.flags } : {}),
    });
    case "valid-json": return { checkId, kind: input.kind, topLevel: "any" };
    case "max-output-characters": return { checkId, kind: input.kind, limit: 1000 };
    case "max-duration-ms": return { checkId, kind: input.kind, limit: 30000 };
    case "max-total-tokens": return { checkId, kind: input.kind, limit: 1000 };
  }
}

export function addEvaluationCheck(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  caseId: EvaluationCaseId,
  input: NewEvaluationCheck,
  suffix: IdSuffix = generatedSuffix,
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({
    ...suite,
    cases: suite.cases.map((evaluationCase) => evaluationCase.id === caseId
      ? { ...evaluationCase, checks: [...evaluationCase.checks, defaultCheck(input, suffix)] }
      : evaluationCase),
  }));
}

export function updateEvaluationCheck(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  caseId: EvaluationCaseId,
  check: CheckDefinition,
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({
    ...suite,
    cases: suite.cases.map((evaluationCase) => evaluationCase.id === caseId
      ? { ...evaluationCase, checks: evaluationCase.checks.map((item) => item.checkId === check.checkId ? check : item) }
      : evaluationCase),
  }));
}

export function removeEvaluationCheck(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  caseId: EvaluationCaseId,
  checkId: CheckId,
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({
    ...suite,
    cases: suite.cases.map((evaluationCase) => evaluationCase.id === caseId
      ? { ...evaluationCase, checks: evaluationCase.checks.filter((check) => check.checkId !== checkId) }
      : evaluationCase),
  }));
}
