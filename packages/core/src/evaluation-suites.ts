import type { DecisionWireProtocol } from "./decision.ts";
import type {
  CheckId,
  ConnectionRequirementId,
  ConversationRevisionId,
  DecisionRequestRevisionId,
  EvaluationCaseId,
  EvaluationInputBindingId,
  EvaluationSuiteId,
  EvaluationVariantId,
  PromptTemplateUseId,
  InferenceOptions,
  ToolId,
} from "./run-kernel/types.ts";
import type { CheckDefinition, DecisionCheckDefinition } from "./checks.ts";
import { isDecisionCheckKind } from "./checks.ts";
import type { DecisionInput, DecisionQuestion } from "./decision.ts";
import { renderDecisionInput } from "./decision-variables.ts";
import { resolveProjectDecisionRequestRevision } from "./decision-request.ts";
import { resolveEvaluationCase } from "./evaluation-case-resolution.ts";
import { SCHEMA_CHECK_LIMITS } from "./json-schema/limits.ts";
import { preflightJsonSchema } from "./json-schema/preflight.ts";
import type { ExecutionTarget, ProjectFile } from "./project.ts";
import { templateUseVariableIndex } from "./template-use-variable-index.ts";
export { templateUseVariableIndex } from "./template-use-variable-index.ts";

/** A chat suite's binding: a case value fills one template use's variable. */
export interface EvaluationInputBinding {
  id: EvaluationInputBindingId;
  name: string;
  target: {
    kind: "template-variable";
    templateUseId: PromptTemplateUseId;
    variableName: string;
  };
}

/**
 * A decision suite's binding (D45): a case value overrides the pinned
 * revision's value for one `{{variable}}` of its decision input (D40).
 */
export interface DecisionInputBinding {
  id: EvaluationInputBindingId;
  name: string;
  target: {
    kind: "decision-variable";
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

/** Sparse portable changes to a suite's base execution configuration. */
export interface EvaluationVariant {
  id: EvaluationVariantId;
  name: string;
  overrides: {
    target?: Partial<ChatEvaluationSuite["execution"]["target"]>;
    responseMode?: ChatEvaluationSuite["execution"]["responseMode"];
    options?: {
      temperature?: number | null;
      maxOutputTokens?: number | null;
      seed?: number | null;
      stop?: string[] | null;
      providerOptions?: InferenceOptions["providerOptions"] | null;
    };
  };
}

export type ResolvedEvaluationVariantExecution = Pick<ChatEvaluationSuite["execution"], "target" | "responseMode" | "options">;

/**
 * Resolves the one-level sparse override contract. Option fields inherit
 * individually; a present providerOptions object replaces the base object.
 */
export function resolveEvaluationVariant(
  suite: Pick<ChatEvaluationSuite, "execution">,
  variant: EvaluationVariant,
): ResolvedEvaluationVariantExecution {
  const optionOverrides = variant.overrides.options ?? {};
  const resolveOption = <Key extends keyof InferenceOptions>(key: Key) => {
    const value = optionOverrides[key];
    return value === null ? undefined : value ?? suite.execution.options[key];
  };
  return {
    target: {
      connectionRequirementId: variant.overrides.target?.connectionRequirementId ?? suite.execution.target.connectionRequirementId,
      model: variant.overrides.target?.model ?? suite.execution.target.model,
      protocol: variant.overrides.target?.protocol ?? suite.execution.target.protocol,
    },
    responseMode: variant.overrides.responseMode ?? suite.execution.responseMode,
    options: {
      ...(resolveOption("temperature") === undefined ? {} : { temperature: resolveOption("temperature") }),
      ...(resolveOption("maxOutputTokens") === undefined ? {} : { maxOutputTokens: resolveOption("maxOutputTokens") }),
      ...(resolveOption("seed") === undefined ? {} : { seed: resolveOption("seed") }),
      ...(resolveOption("stop") === undefined ? {} : { stop: structuredClone(resolveOption("stop")) }),
      ...(resolveOption("providerOptions") === undefined ? {} : { providerOptions: structuredClone(resolveOption("providerOptions")) }),
    },
  };
}

/**
 * The portable target a decision suite runs against (D44). Nothing about
 * System One enters the connection requirement: D9 keeps the declaration on
 * the device-local profile.
 */
export interface DecisionExecutionTarget {
  connectionRequirementId: ConnectionRequirementId;
  model: string;
  protocol: DecisionWireProtocol;
}

/** A decision configuration may override the target only (D33). */
export interface DecisionEvaluationVariant {
  id: EvaluationVariantId;
  name: string;
  overrides: {
    target?: Partial<DecisionExecutionTarget>;
  };
}

/** A decision configuration's target: each field it names replaces the suite's. */
export function resolveDecisionEvaluationVariant(
  suite: Pick<DecisionEvaluationSuite, "execution">,
  variant: DecisionEvaluationVariant,
): DecisionExecutionTarget {
  const base = suite.execution.target;
  const override = variant.overrides.target ?? {};
  return {
    connectionRequirementId: override.connectionRequirementId ?? base.connectionRequirementId,
    model: override.model ?? base.model,
    protocol: override.protocol ?? base.protocol,
  };
}

/** Authored, provider-neutral evaluation content; one arm per run kind (D44). */
export type EvaluationSuite = ChatEvaluationSuite | DecisionEvaluationSuite;

export function isChatEvaluationSuite(suite: EvaluationSuite): suite is ChatEvaluationSuite {
  return suite.input.kind === "conversation-revision";
}

export function isDecisionEvaluationSuite(suite: EvaluationSuite): suite is DecisionEvaluationSuite {
  return suite.input.kind === "decision-request-revision";
}

/** A suite that runs a pinned decision request revision. */
export interface DecisionEvaluationSuite {
  id: EvaluationSuiteId;
  name: string;
  input: {
    kind: "decision-request-revision";
    decisionRequestRevisionId: DecisionRequestRevisionId;
  };
  /** A target and repetitions only: no response mode, options, tools, or turn ceiling. */
  execution: {
    target: DecisionExecutionTarget;
    repetitions: number;
  };
  variants: DecisionEvaluationVariant[];
  inputBindings: DecisionInputBinding[];
  cases: EvaluationCase[];
}

/** A suite that runs a pinned conversation revision. */
export interface ChatEvaluationSuite {
  id: EvaluationSuiteId;
  name: string;
  /** The immutable authored input this suite resolves independently of Messages. */
  input: {
    kind: "conversation-revision";
    conversationRevisionId: ConversationRevisionId;
  };
  /** Portable execution preferences. Credentials and local profile identity never enter project data. */
  execution: {
    target: ExecutionTarget;
    responseMode: "streaming" | "buffered";
    options: InferenceOptions;
    repetitions: number;
    /**
     * Project tool IDs this suite exposes, per [D8]: a suite references
     * portable descriptors, and the device-local binding that serves each one
     * joins at plan time. Snapshotting the descriptors still happens at plan
     * time, exactly as it does for an ordinary run.
     */
    toolIds: ToolId[];
    /**
     * Provider turns one repetition may spend before it is failed. Absent means
     * the shared default. Authored here rather than at confirmation because a
     * ceiling changes outcomes — a repetition that reaches it fails — and a
     * suite owns everything its result depends on.
     */
    turnCeiling?: number;
  };
  /** At least one named configuration; the base execution remains the editing anchor. */
  variants: EvaluationVariant[];
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
      /** Authoring keeps unsupported schemas editable; a run cannot evaluate them. */
      code: "unsupported-schema";
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
      /** Absent for a decision suite, whose variables belong to no template use. */
      templateUseId?: PromptTemplateUseId;
      variableName: string;
      message: string;
    }
  | {
      /** A decision binding names a variable the pinned revision does not use. */
      code: "missing-decision-variable";
      inputBindingId: EvaluationInputBindingId;
      variableName: string;
      message: string;
    }
  | {
      /** The pinned revision's input has a malformed `{{` token. */
      code: "invalid-decision-template";
      message: string;
    }
  | {
      code: "missing-decision-question" | "wrong-question-type";
      caseId: EvaluationCaseId;
      checkId: CheckId;
      questionId: string;
      message: string;
    }
  | {
      code: "unknown-decision-option";
      caseId: EvaluationCaseId;
      checkId: CheckId;
      questionId: string;
      option: string;
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
  ) || (check.kind === "regex" && check.pattern === "")
    || (
      (check.kind === "called-tool" || check.kind === "did-not-call-tool" || check.kind === "tool-call-arguments") &&
      check.toolName === ""
    );
}

/**
 * Pure, provider-free authoring preflight for a selected suite and revision.
 * A decision suite reads its own pinned revision, so `conversationRevisionId`
 * applies to chat suites only.
 */
export function evaluationSuitePreflight(
  project: Pick<ProjectFile, "evaluationSuites" | "conversationRevisions" | "promptTemplates" | "decisionRequestRevisions">,
  evaluationSuiteId: EvaluationSuiteId,
  conversationRevisionId: ConversationRevisionId,
  selectedCaseIds?: readonly EvaluationCaseId[],
): EvaluationSuitePreflightDiagnostic[] {
  const found = project.evaluationSuites.find(({ id }) => id === evaluationSuiteId);
  if (found && isDecisionEvaluationSuite(found)) return decisionSuitePreflight(project, found, selectedCaseIds);
  const suite = found as ChatEvaluationSuite | undefined;
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
      if (check.kind !== "json-schema") return;
      const preflight = preflightJsonSchema(check.schema, SCHEMA_CHECK_LIMITS.schema);
      if (preflight.status === "ready") return;
      diagnostics.push({
        code: "unsupported-schema",
        caseId: evaluationCase.id,
        checkId: check.checkId,
        message: `A JSON Schema check on case "${evaluationCase.name}" cannot run: ${preflight.diagnostic.message}`,
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
          : check.kind === "called-tool" || check.kind === "did-not-call-tool" || check.kind === "tool-call-arguments"
            ? `A ${check.kind} check on case "${evaluationCase.name}" needs a tool name.`
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

const decisionCheckNoun: Record<DecisionCheckDefinition["kind"], string> = {
  "decision-choice": "choice",
  "decision-option-probability": "option probability",
  "decision-score-range": "score range",
  "decision-noul": "noul",
  "decision-confidence": "confidence",
};

/** The question types each decision check kind can read (D34). */
export const decisionCheckQuestionTypes: Record<DecisionCheckDefinition["kind"], readonly DecisionQuestion["type"][]> = {
  "decision-choice": ["choice"],
  "decision-option-probability": ["choice", "score"],
  "decision-score-range": ["score"],
  "decision-noul": ["noul"],
  "decision-confidence": ["choice", "score"],
};

/** A choice option is its label; a score option is its level number as a string. */
export function decisionOptions(question: DecisionQuestion): string[] {
  if (question.type === "choice") return Object.keys(question.criteria);
  if (question.type === "score") return question.criteria.map((_level, index) => String(index));
  return [];
}

/** D34's question checks: each names a question of the right type and, where it names one, a real option. */
function decisionCheckDiagnostics(
  decision: DecisionInput,
  evaluationCase: EvaluationCase,
  check: DecisionCheckDefinition,
): EvaluationSuitePreflightDiagnostic[] {
  const noun = decisionCheckNoun[check.kind];
  const question = Object.hasOwn(decision.questions, check.questionId) ? decision.questions[check.questionId] : undefined;
  const base = { caseId: evaluationCase.id, checkId: check.checkId, questionId: check.questionId };
  if (!question) {
    return [{
      code: "missing-decision-question",
      ...base,
      message: check.questionId === ""
        ? `A ${noun} check on case "${evaluationCase.name}" needs a question.`
        : `A ${noun} check on case "${evaluationCase.name}" names question "${check.questionId}", which the pinned revision does not ask.`,
    }];
  }
  const types = decisionCheckQuestionTypes[check.kind];
  if (!types.includes(question.type)) {
    return [{
      code: "wrong-question-type",
      ...base,
      message: `A ${noun} check on case "${evaluationCase.name}" needs a ${types.join(" or ")} question; "${check.questionId}" is a ${question.type} question.`,
    }];
  }
  if (check.kind !== "decision-choice" && check.kind !== "decision-option-probability") return [];
  if (decisionOptions(question).includes(check.option)) return [];
  return [{
    code: "unknown-decision-option",
    ...base,
    option: check.option,
    message: check.option === ""
      ? `A ${noun} check on case "${evaluationCase.name}" needs an option.`
      : question.type === "score"
        ? `A ${noun} check on case "${evaluationCase.name}" names level "${check.option}"; question "${check.questionId}" has levels 0 to ${question.criteria.length - 1}.`
        : `A ${noun} check on case "${evaluationCase.name}" names option "${check.option}", which question "${check.questionId}" does not offer.`,
  }];
}

/**
 * Preflight for a decision suite against its pinned revision (D45, D46). A
 * case value overrides the revision's value for its bound variable; anything
 * still unfilled blocks the run, as an unresolved chat variable does.
 */
function decisionSuitePreflight(
  project: Pick<ProjectFile, "decisionRequestRevisions" | "promptTemplates">,
  suite: DecisionEvaluationSuite,
  selectedCaseIds?: readonly EvaluationCaseId[],
): EvaluationSuitePreflightDiagnostic[] {
  const revision = resolveProjectDecisionRequestRevision(project, suite.input.decisionRequestRevisionId);
  if (!revision) return [];

  const diagnostics: EvaluationSuitePreflightDiagnostic[] = [];
  if (suite.cases.length === 0) {
    diagnostics.push({ code: "empty-suite", message: "Add at least one case before running this suite." });
  } else if (selectedCaseIds && selectedCaseIds.length === 0) {
    diagnostics.push({ code: "no-cases-selected", message: "Select at least one case before running this suite." });
  }
  const selectedCases = selectedCaseIds
    ? suite.cases.filter(({ id }) => selectedCaseIds.includes(id))
    : suite.cases;
  const used = new Set(revision.variables);
  const invalidToken = revision.diagnostics.find(({ code }) => code === "invalid-template-token");

  selectedCases.forEach((evaluationCase) => {
    if (evaluationCase.checks.length === 0) {
      diagnostics.push({
        code: "no-checks",
        caseId: evaluationCase.id,
        message: `Case "${evaluationCase.name}" needs at least one deterministic check before it can run.`,
      });
    }
    suite.inputBindings.forEach((binding) => {
      if (Object.hasOwn(evaluationCase.values, binding.id)) return;
      diagnostics.push({
        code: "empty-case-value",
        caseId: evaluationCase.id,
        inputBindingId: binding.id,
        message: `Case "${evaluationCase.name}" has no value for input "${binding.name}".`,
      });
    });
    evaluationCase.checks.forEach((check) => {
      if (isDecisionCheckKind(check.kind)) diagnostics.push(...decisionCheckDiagnostics(revision.decision, evaluationCase, check as DecisionCheckDefinition));
    });
    if (invalidToken) return;
    const values: Record<string, string> = { ...revision.values };
    suite.inputBindings.forEach((binding) => {
      const value = evaluationCase.values[binding.id];
      if (value !== undefined) values[binding.target.variableName] = value;
    });
    const reported = new Set<string>();
    renderDecisionInput(revision.decision, values).diagnostics.forEach(({ diagnostic }) => {
      if (diagnostic.code !== "missing-template-variable" || reported.has(diagnostic.name)) return;
      reported.add(diagnostic.name);
      diagnostics.push({
        code: "unresolved-template-variable",
        caseId: evaluationCase.id,
        variableName: diagnostic.name,
        message: `Case "${evaluationCase.name}" cannot resolve template variable "${diagnostic.name}": ${diagnostic.message}`,
      });
    });
  });

  if (invalidToken) {
    diagnostics.push({
      code: "invalid-decision-template",
      message: `The pinned decision request cannot be rendered: ${invalidToken.message}`,
    });
  }
  suite.inputBindings.forEach((binding) => {
    if (used.has(binding.target.variableName)) return;
    diagnostics.push({
      code: "missing-decision-variable",
      inputBindingId: binding.id,
      variableName: binding.target.variableName,
      message: `Input "${binding.name}" fills variable "${binding.target.variableName}", which the pinned decision request does not use.`,
    });
  });
  return diagnostics;
}
