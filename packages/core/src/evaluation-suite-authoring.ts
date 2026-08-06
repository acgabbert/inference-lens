import type { CheckDefinition, CheckKind } from "./checks.ts";
import { evaluationSuitePreflight, templateUseVariableIndex } from "./evaluation-suites.ts";
import type { EvaluationCase, EvaluationInputBinding, EvaluationSuite, EvaluationVariant } from "./evaluation-suites.ts";
import {
  createBranchRevision,
  insertPromptTemplateUse,
  parseProjectFile,
  ProjectValidationError,
} from "./project.ts";
import type { ProjectFile, PromptTemplateMessage } from "./project.ts";
import { randomUUID } from "./random-id.ts";
import { createEntityId } from "./run-kernel/types.ts";
import { discoverTemplateVariables } from "./template-engine.ts";
import type {
  CheckId,
  ConnectionRequirementId,
  ConversationRevisionId,
  EvaluationCaseId,
  EvaluationInputBindingId,
  EvaluationSuiteId,
  EvaluationVariantId,
  PromptTemplateId,
  PromptTemplateRevisionId,
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
  | { kind: "regex"; pattern?: string; flags?: string };

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

export interface SavedPromptVariable {
  name: string;
  /** True when the template revision itself supplies a value for this variable. */
  hasDefault: boolean;
  defaultValue?: string;
}

export interface SavedPromptCandidate {
  templateId: PromptTemplateId;
  name: string;
  currentRevisionId: PromptTemplateRevisionId;
  revisionCreatedAt: string;
  messageCount: number;
  roles: PromptTemplateMessage["role"][];
  variables: SavedPromptVariable[];
  /**
   * Advisory only. A recommendation records the target a template was authored
   * against; it never selects or overrides the evaluation's target, because one
   * request may contain several templates and the provider accepts one model.
   */
  recommendedTarget?: {
    connectionRequirementId: ConnectionRequirementId;
    connectionName: string;
    model: string;
  };
}

/**
 * The templates the saved-prompt shortcut may insert, described from each
 * template's current immutable revision.
 *
 * Archived templates are excluded: existing project policy forbids adding them
 * to a conversation, so offering one would produce a refusal rather than a
 * revision.
 */
export function savedPromptCandidates(
  project: Pick<ProjectFile, "promptTemplates" | "connectionRequirements">,
): SavedPromptCandidate[] {
  const connectionsById = new Map(
    project.connectionRequirements.map((requirement) => [requirement.id, requirement]),
  );
  return project.promptTemplates.flatMap((template): SavedPromptCandidate[] => {
    if (template.archivedAt) return [];
    const revision = template.revisions.find(({ id }) => id === template.currentRevisionId);
    if (!revision) return [];
    const recommendation = template.recommendedTarget;
    return [{
      templateId: template.id,
      name: template.name,
      currentRevisionId: revision.id,
      revisionCreatedAt: revision.createdAt,
      messageCount: revision.messages.length,
      roles: revision.messages.map(({ role }) => role),
      variables: discoverTemplateVariables(revision.messages).variables.map(({ name }) => {
        const hasDefault = Object.prototype.hasOwnProperty.call(revision.variableDefaults, name);
        return {
          name,
          hasDefault,
          ...(hasDefault ? { defaultValue: revision.variableDefaults[name]! } : {}),
        };
      }),
      ...(recommendation
        ? {
            recommendedTarget: {
              connectionRequirementId: recommendation.connectionRequirementId,
              connectionName:
                connectionsById.get(recommendation.connectionRequirementId)?.name ?? "Unknown connection",
              model: recommendation.model,
            },
          }
        : {}),
    }];
  });
}

export interface CreateRevisionFromSavedPromptOptions {
  /**
   * The revision the evaluation currently selects. It supplies lineage and the
   * conversation, not content: the child is authored from the prompt alone.
   */
  parentRevisionId: ConversationRevisionId;
  templateId: PromptTemplateId;
  /** Defaults to the current prompt revision; library actions can pin history. */
  templateRevisionId?: PromptTemplateRevisionId;
  revisionIdSuffix?: string;
  templateUseIdSuffix?: string;
  createdAt?: string;
}

export interface SavedPromptRevision {
  project: ProjectFile;
  conversationRevisionId: ConversationRevisionId;
  templateUseId: PromptTemplateUseId;
}

/**
 * Authors a prompt-only child of `parentRevisionId` containing exactly one
 * pinned use of the template's current immutable revision. The Messages
 * editor remains on its own active revision; this revision belongs to the
 * evaluation input that selects it.
 *
 * The child deliberately does not inherit the parent's items. "Start from
 * saved prompt" then has predictable replacement semantics and cannot silently
 * duplicate a system message or an earlier prompt; a template's own multi-
 * message structure still arrives whole and ordered, because one use emits
 * every message of its pinned revision. Authors add surrounding messages
 * afterwards in the Messages editor.
 *
 * Suites, bindings, cases, target, and inference options are untouched: this
 * mints a new stable template-use ID, so retargeting existing bindings would be
 * a guess rather than a translation.
 */
export function createRevisionFromSavedPrompt(
  project: ProjectFile,
  {
    parentRevisionId,
    templateId,
    templateRevisionId,
    revisionIdSuffix = randomUUID(),
    templateUseIdSuffix = randomUUID(),
    createdAt = new Date().toISOString(),
  }: CreateRevisionFromSavedPromptOptions,
): SavedPromptRevision {
  const parent = project.conversationRevisions.find(({ id }) => id === parentRevisionId);
  if (!parent) {
    throw new ProjectValidationError([{
      code: "custom",
      path: ["conversationRevisions", "parentRevisionId"],
      message: "The revision this prompt would start from no longer exists.",
    }]);
  }
  const conversationRevisionId = createEntityId("revision", revisionIdSuffix);
  // Branching first and inserting second reuses the existing lineage and
  // pinned-use rules verbatim, including the archived-template refusal, rather
  // than restating them here where they could drift.
  const branched = createBranchRevision(project, {
    conversationId: parent.conversationId,
    parentRevisionId,
    messages: [],
    items: [],
    idSuffix: revisionIdSuffix,
    createdAt,
  });
  const messagesRevisionId = project.defaults.conversationRevisionId;
  const evaluationBranch = parseProjectFile({
    ...branched,
    defaults: { ...branched.defaults, conversationRevisionId: messagesRevisionId },
  });
  return {
    project: insertPromptTemplateUse(evaluationBranch, {
      conversationRevisionId,
      templateId,
      ...(templateRevisionId ? { templateRevisionId } : {}),
      idSuffix: templateUseIdSuffix,
    }),
    conversationRevisionId,
    templateUseId: createEntityId("template-use", templateUseIdSuffix),
  };
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
      input: {
        kind: "conversation-revision",
        conversationRevisionId: project.defaults.conversationRevisionId,
      },
      execution: {
        target: structuredClone(project.defaults.target),
        // Buffered by default: a batch of runs is read after it finishes, so
        // incremental delivery buys nothing and only narrows which providers
        // the suite can run against.
        responseMode: "buffered",
        options: structuredClone(project.defaults.options),
        repetitions: 1,
        // A new suite exposes nothing. Tool exposure is a deliberate act on the
        // suite, never inherited from whatever the composer had switched on.
        toolIds: [],
      },
      variants: [{
        id: createEntityId("evaluation-variant", `${suiteId}-default`),
        name: "Default",
        overrides: {},
      }],
      inputBindings: [],
      cases: [],
    }]),
  };
}

export function updateEvaluationSuiteInput(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  conversationRevisionId: ConversationRevisionId,
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({
    ...suite,
    input: { kind: "conversation-revision", conversationRevisionId },
  }));
}

export function updateEvaluationSuiteExecution(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  execution: EvaluationSuite["execution"],
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({ ...suite, execution }));
}

export function addEvaluationVariant(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  suffix: IdSuffix = generatedSuffix,
): { project: ProjectFile; variantId: EvaluationVariantId } {
  const variantId = createEntityId("evaluation-variant", suffix());
  const next = mapSuite(project, suiteId, (suite) => ({
    ...suite,
    variants: [...suite.variants, {
      id: variantId,
      name: uniqueName("New configuration", suite.variants.map(({ name }) => name)),
      overrides: {},
    }],
  }));
  return { project: next, variantId };
}

export function updateEvaluationVariant(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  variantId: EvaluationVariantId,
  patch: Pick<EvaluationVariant, "name" | "overrides">,
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => ({
    ...suite,
    variants: suite.variants.map((variant) => variant.id === variantId ? { ...variant, ...patch } : variant),
  }));
}

export function reorderEvaluationVariant(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  variantId: EvaluationVariantId,
  destinationIndex: number,
): ProjectFile {
  return mapSuite(project, suiteId, (suite) => {
    const sourceIndex = suite.variants.findIndex(({ id }) => id === variantId);
    if (sourceIndex < 0) return suite;
    const variants = [...suite.variants];
    const [variant] = variants.splice(sourceIndex, 1);
    variants.splice(Math.max(0, Math.min(destinationIndex, variants.length)), 0, variant!);
    return { ...suite, variants };
  });
}

export function removeEvaluationVariant(
  project: ProjectFile,
  suiteId: EvaluationSuiteId,
  variantId: EvaluationVariantId,
): ProjectFile {
  const suite = project.evaluationSuites.find(({ id }) => id === suiteId);
  if (suite?.variants.length === 1 && suite.variants[0]?.id === variantId) {
    throw new ProjectValidationError([{ code: "custom", path: ["evaluationSuites", suiteId, "variants"], message: "An evaluation suite needs at least one configuration." }]);
  }
  return mapSuite(project, suiteId, (current) => ({
    ...current,
    variants: current.variants.filter(({ id }) => id !== variantId),
  }));
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

/** Every created check is structurally valid; unfinished values are preflight state. */
export function defaultCheck(
  input: NewEvaluationCheck,
  suffix: IdSuffix = generatedSuffix,
): CheckDefinition {
  const checkId = createEntityId("check", suffix()) as CheckId;
  switch (input.kind) {
    case "exact-match": return { checkId, kind: input.kind, value: "" };
    case "contains": return { checkId, kind: input.kind, value: "" };
    case "regex": return {
      checkId,
      kind: input.kind,
      syntax: "re2",
      pattern: input.pattern ?? "",
      ...(input.flags ? { flags: input.flags } : {}),
    };
    case "valid-json": return { checkId, kind: input.kind, topLevel: "any" };
    case "max-output-characters": return { checkId, kind: input.kind, limit: 1000 };
    case "max-duration-ms": return { checkId, kind: input.kind, limit: 30000 };
    case "max-total-tokens": return { checkId, kind: input.kind, limit: 1000 };
    case "called-tool": return { checkId, kind: input.kind, toolName: "" };
    case "did-not-call-tool": return { checkId, kind: input.kind, toolName: "" };
    case "tool-call-count": return { checkId, kind: input.kind, count: 1, comparator: "at-least" };
    case "tool-call-arguments": return { checkId, kind: input.kind, toolName: "", argumentsSubset: {} };
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
