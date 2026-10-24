import type { ChatEvaluationSuite, EvaluationCase } from "./evaluation-suites.ts";
import { ProjectValidationError, resolveProjectRevision } from "./project.ts";
import type {
  ProjectConversationRevision,
  ProjectFile,
  ProjectTemplateDiagnostic,
  TemplateRunOverrides,
} from "./project.ts";
import { discoverTemplateVariables } from "./template-engine.ts";
import type {
  ConversationMessage,
  EvaluationInputBindingId,
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
  ResolvedTemplateUse,
} from "./run-kernel/types.ts";

/** Where a template variable's effective value came from. */
export type EvaluationValueSource = "case" | "authored-use" | "template-default";

export interface EvaluationVariableResolution {
  templateUseId: PromptTemplateUseId;
  templateId: PromptTemplateId;
  templateName: string;
  templateRevisionId: PromptTemplateRevisionId;
  variableName: string;
  /** Absent when no level supplied a value; that is a visible setup error, not a blank. */
  value?: string;
  source?: EvaluationValueSource;
  /** Present only for `case`, identifying the suite input that supplied the value. */
  inputBindingId?: EvaluationInputBindingId;
  inputName?: string;
}

export interface EvaluationUnresolvedBinding {
  inputBindingId: EvaluationInputBindingId;
  inputName: string;
  templateUseId: PromptTemplateUseId;
  variableName: string;
  reason: "missing-template-use" | "missing-template-variable";
}

interface EvaluationCaseProvenance {
  /** One entry per template variable of every use, in authored order. */
  variables: EvaluationVariableResolution[];
  /** The case values that produced the `case`-sourced overrides. */
  caseValues: Record<EvaluationInputBindingId, string>;
  /** Bindings the selected revision cannot satisfy; they contribute no override. */
  unresolvedBindings: EvaluationUnresolvedBinding[];
}

export type EvaluationCaseResolution =
  | (EvaluationCaseProvenance & {
      ok: true;
      messages: ConversationMessage[];
      templateResolutions: ResolvedTemplateUse[];
    })
  | (EvaluationCaseProvenance & {
      ok: false;
      diagnostics: ProjectTemplateDiagnostic[];
      /**
       * Set when the revision cannot be rendered at all — a pinned template
       * revision has gone missing — rather than merely leaving variables
       * unfilled. The case still resolves to a describable failure so the
       * editor can name the problem instead of throwing the tab away.
       */
      unresolvable?: string;
    });

/** The issue itself reads better than the parser's whole-project summary. */
function unresolvableReason(cause: unknown): string {
  if (cause instanceof ProjectValidationError) {
    return cause.issues[0]?.message ?? "This revision cannot be resolved for the selected case.";
  }
  return cause instanceof Error
    ? cause.message
    : "This revision cannot be resolved for the selected case.";
}

/**
 * The one projection that turns a suite case into the exact provider input an
 * execution would snapshot.
 *
 * Preflight, the focused-case preview, and plan creation all resolve through
 * here, so the preview cannot drift from the plan: precedence is applied once,
 * as template revision defaults < authored template-use values < the selected
 * case's values for bound variables.
 *
 * The signature accepts no run overrides. Transient composer values therefore
 * cannot enter an evaluation by mistake — their exclusion is structural rather
 * than a convention each caller has to remember.
 */
export function resolveEvaluationCase(
  project: Pick<ProjectFile, "promptTemplates">,
  revision: ProjectConversationRevision,
  suite: Pick<ChatEvaluationSuite, "inputBindings">,
  evaluationCase: Pick<EvaluationCase, "values">,
): EvaluationCaseResolution {
  const templatesById = new Map(project.promptTemplates.map((template) => [template.id, template]));
  const usesById = new Map(
    revision.items.flatMap((item) => (item.kind === "template-use" ? [[item.use.id, item.use] as const] : [])),
  );
  const variablesByUse = new Map<PromptTemplateUseId, string[]>();
  usesById.forEach((use, useId) => {
    const templateRevision = templatesById
      .get(use.templateId)
      ?.revisions.find(({ id }) => id === use.templateRevisionId);
    if (!templateRevision) return;
    variablesByUse.set(
      useId,
      discoverTemplateVariables(templateRevision.messages).variables.map(({ name }) => name),
    );
  });

  const overrides: Record<string, Record<string, string>> = {};
  const caseValues: Record<EvaluationInputBindingId, string> = {};
  const bindingByVariable = new Map<string, { id: EvaluationInputBindingId; name: string }>();
  const unresolvedBindings: EvaluationUnresolvedBinding[] = [];

  suite.inputBindings.forEach((binding) => {
    const { templateUseId, variableName } = binding.target;
    const variables = variablesByUse.get(templateUseId);
    if (!variables || !variables.includes(variableName)) {
      unresolvedBindings.push({
        inputBindingId: binding.id,
        inputName: binding.name,
        templateUseId,
        variableName,
        reason: usesById.has(templateUseId) ? "missing-template-variable" : "missing-template-use",
      });
      return;
    }
    // Key presence is what matters: an empty case value is an intentional empty
    // override, and preflight reports it separately as an unfinished case.
    const value = evaluationCase.values[binding.id] ?? "";
    overrides[templateUseId] = { ...overrides[templateUseId], [variableName]: value };
    caseValues[binding.id] = value;
    bindingByVariable.set(`${templateUseId}::${variableName}`, { id: binding.id, name: binding.name });
  });

  const variables = [...usesById.values()].flatMap((use): EvaluationVariableResolution[] => {
    const template = templatesById.get(use.templateId);
    const templateRevision = template?.revisions.find(({ id }) => id === use.templateRevisionId);
    if (!template || !templateRevision) return [];
    return (variablesByUse.get(use.id) ?? []).map((variableName) => {
      const identity = {
        templateUseId: use.id,
        templateId: use.templateId,
        templateName: template.name,
        templateRevisionId: templateRevision.id,
        variableName,
      };
      const binding = bindingByVariable.get(`${use.id}::${variableName}`);
      const has = (values: Record<string, string>) =>
        Object.prototype.hasOwnProperty.call(values, variableName);
      if (binding) {
        return {
          ...identity,
          value: overrides[use.id]![variableName]!,
          source: "case" as const,
          inputBindingId: binding.id,
          inputName: binding.name,
        };
      }
      if (has(use.values)) {
        return { ...identity, value: use.values[variableName]!, source: "authored-use" as const };
      }
      if (has(templateRevision.variableDefaults)) {
        return {
          ...identity,
          value: templateRevision.variableDefaults[variableName]!,
          source: "template-default" as const,
        };
      }
      return identity;
    });
  });

  const provenance: EvaluationCaseProvenance = { variables, caseValues, unresolvedBindings };

  // Provenance is derived above, so a revision whose pinned template revision
  // has gone missing still reports every variable it can identify. Only the
  // rendering fails, and it fails as a described condition rather than as an
  // exception that would take the whole editor down with it.
  let resolved: ReturnType<typeof resolveProjectRevision>;
  try {
    resolved = resolveProjectRevision(project, revision, overrides as TemplateRunOverrides);
  } catch (cause) {
    return {
      ...provenance,
      ok: false,
      diagnostics: [],
      unresolvable: unresolvableReason(cause),
    };
  }
  if (resolved.diagnostics.length > 0) {
    return { ...provenance, ok: false, diagnostics: resolved.diagnostics };
  }
  return {
    ...provenance,
    ok: true,
    messages: resolved.messages,
    templateResolutions: resolved.templateResolutions,
  };
}
