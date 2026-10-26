import type { DecisionInput } from "./decision.ts";
import { renderDecisionInput } from "./decision-variables.ts";
import type { DecisionVariableField } from "./decision-variables.ts";
import {
  isSensitiveTemplateVariableName,
  parseProjectFile,
  ProjectValidationError,
} from "./project.ts";
import type {
  ProjectDecisionRequestRevision,
  ProjectFile,
} from "./project.ts";
import { randomUUID } from "./random-id.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type { DecisionRequestId, DecisionRequestRevisionId, PromptTemplateId, PromptTemplateRevisionId } from "./run-kernel/types.ts";
import { stableJsonValue } from "./stable-json.ts";

/**
 * Project-owned decision requests (D31, D38–D43): the pure mutations Decision
 * Compose applies to the project, and the run boundary that refuses a request
 * while any variable is unresolved.
 */

export const DEFAULT_DECISION_REQUEST_NAME = "Decision request";

/** The revision Decision Compose edits, if the project has one. */
export function activeDecisionRequestRevision(
  project: Pick<ProjectFile, "decisionRequestRevisions" | "defaults">,
): ProjectDecisionRequestRevision | undefined {
  const id = project.defaults.decisionRequestRevisionId;
  return id ? project.decisionRequestRevisions.find((revision) => revision.id === id) : undefined;
}

export interface ResolvedProjectDecisionRequestRevision {
  /** Authored content: variable tokens and question/criteria order are retained. */
  decision: DecisionInput;
  /** Supplied assignments only. An absent key must never become an empty value. */
  values: Record<string, string>;
  source: {
    decisionRequestId: DecisionRequestId;
    decisionRequestRevisionId: DecisionRequestRevisionId;
  } & ({ kind: "inline" } | { kind: "template-use"; templateId: PromptTemplateId; templateRevisionId: PromptTemplateRevisionId });
  variables: string[];
  /** Authoring diagnostics; resolving a saved source does not make it runnable. */
  diagnostics: DecisionRequestDiagnostic[];
}

/**
 * The project-content boundary shared by Compose, suite authoring, preflight,
 * and experiment snapshots. Source resolution keeps authored tokens; callers
 * apply case values before rendering at the existing execution boundary.
 *
 * Returns undefined for an unknown revision. Other references are guaranteed by
 * project validation. The library is part of the input contract now so v15 can
 * resolve template pins here without changing each caller's project boundary.
 * Returned content and assignments are owned by the caller, never aliases of
 * the saved revision.
 */
export function resolveProjectDecisionRequestRevision(
  project: Pick<ProjectFile, "decisionRequestRevisions" | "promptTemplates">,
  revisionId: DecisionRequestRevisionId,
): ResolvedProjectDecisionRequestRevision | undefined {
  const revision = project.decisionRequestRevisions.find(({ id }) => id === revisionId);
  if (!revision) return undefined;
  const pin = revision.kind === "template-use"
    ? decisionTemplatePin(project, revision.templateId, revision.templateRevisionId).revision : undefined;
  const decision = structuredClone(revision.kind === "inline" ? revision.decision : pin!.decision);
  const values = revision.kind === "inline" ? { ...revision.values } : { ...pin!.variableDefaults, ...revision.overrides };
  const { variables, diagnostics } = resolveDecisionRequest(decision, values);
  return {
    decision,
    values,
    source: {
      ...(revision.kind === "inline" ? { kind: "inline" as const } : { kind: "template-use" as const, templateId: revision.templateId, templateRevisionId: revision.templateRevisionId }),
      decisionRequestId: revision.decisionRequestId,
      decisionRequestRevisionId: revision.id,
    },
    variables,
    diagnostics,
  };
}

export interface UpdateDecisionRequestDraft {
  decision: DecisionInput;
  values: Readonly<Record<string, string>>;
  /**
   * The active revision may no longer change in place: it has run in this
   * session, or it was loaded from disk and its history is unknown (D38).
   */
  branch: boolean;
  idSuffix?: string;
  createdAt?: string;
}

function sameContent(
  revision: ProjectDecisionRequestRevision,
  decision: DecisionInput,
  values: Readonly<Record<string, string>>,
): boolean {
  // `decision` keeps authored order, so reordering questions is a change;
  // `values` is a map, so its order is not.
  return revision.kind === "inline" && (
    JSON.stringify(stableJsonValue({ decision: revision.decision, values: revision.values })) ===
    JSON.stringify(stableJsonValue({ decision, values }))
  );
}

/**
 * Writes the editor's valid draft into the project. With no active request it
 * creates one; with an active revision it edits it in place, or appends a
 * child and moves the pointer when `branch` is set or a suite pins it. An unchanged draft
 * returns the same project, so it never branches. Values for variables the
 * input no longer uses are dropped, as a newly saved template revision drops
 * obsolete defaults.
 */
export function updateDecisionRequestDraft(
  project: ProjectFile,
  {
    decision,
    values,
    branch,
    idSuffix = randomUUID(),
    createdAt = new Date().toISOString(),
  }: UpdateDecisionRequestDraft,
): ProjectFile {
  const { variables } = renderDecisionInput(decision, {});
  const keptValues = Object.fromEntries(
    variables.flatMap((name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? [[name, values[name]!]] : [],
    ),
  );
  const active = activeDecisionRequestRevision(project);
  if (active?.kind === "template-use") {
    throw new ProjectValidationError([{ code: "custom", path: ["decisionRequestRevisions", active.id], message: "Detach the pinned decision template before editing its content." }]);
  }
  if (active && sameContent(active, decision, keptValues)) return project;

  // A suite that pins the revision ran, or will run, exactly that content
  // (D44), so it never changes in place whatever the editor has frozen.
  const pinned = active !== undefined && project.evaluationSuites.some((suite) =>
    suite.input.kind === "decision-request-revision" && suite.input.decisionRequestRevisionId === active.id);
  if (active && !branch && !pinned) {
    return parseProjectFile({
      ...project,
      decisionRequestRevisions: project.decisionRequestRevisions.map((revision) =>
        revision.id === active.id
          ? { ...revision, decision: structuredClone(decision), values: keptValues }
          : revision,
      ),
    });
  }

  const revisionId = createEntityId("decision-revision", idSuffix);
  const decisionRequestId = active?.decisionRequestId ?? createEntityId("decision-request", idSuffix);
  return parseProjectFile({
    ...project,
    decisionRequests: active
      ? project.decisionRequests
      : [...project.decisionRequests, { id: decisionRequestId, name: DEFAULT_DECISION_REQUEST_NAME }],
    decisionRequestRevisions: [
      ...project.decisionRequestRevisions,
      {
        id: revisionId,
        kind: "inline",
        decisionRequestId,
        ...(active ? { parentRevisionId: active.id } : {}),
        decision: structuredClone(decision),
        values: keptValues,
        createdAt,
      },
    ],
    defaults: { ...project.defaults, decisionRequestRevisionId: revisionId },
  });
}

export interface DecisionRequestDiagnostic {
  code: "invalid-template-token" | "missing-template-variable";
  /** Readable: "State", "Question intent (instructions)". */
  location: string;
  message: string;
  /** The variable, for a missing one. */
  name?: string;
}

function fieldLocation(field: DecisionVariableField): string {
  return field.kind === "state" ? "State" : `Question ${field.questionId} (instructions)`;
}

export interface ResolvedDecisionRequest {
  /** Always produced; an unfilled variable stays as its own token. */
  decision: DecisionInput;
  variables: string[];
  diagnostics: DecisionRequestDiagnostic[];
}

/**
 * Renders a request's variables for authoring. A missing variable is reported
 * once, at the first place it is used; a secret-like one is named as the
 * blocker, since no value will ever be accepted for it.
 */
export function resolveDecisionRequest(
  decision: DecisionInput,
  values: Readonly<Record<string, string>>,
): ResolvedDecisionRequest {
  const rendered = renderDecisionInput(decision, values);
  const reported = new Set<string>();
  const diagnostics = rendered.diagnostics.flatMap(({ field, diagnostic }): DecisionRequestDiagnostic[] => {
    const location = fieldLocation(field);
    if (diagnostic.code === "invalid-template-token") {
      return [{
        code: diagnostic.code,
        location,
        message: `${diagnostic.message} Write \\{{ for literal braces.`,
      }];
    }
    if (reported.has(diagnostic.name)) return [];
    reported.add(diagnostic.name);
    return [{
      code: diagnostic.code,
      location,
      name: diagnostic.name,
      message: isSensitiveTemplateVariableName(diagnostic.name)
        ? `Template variable "${diagnostic.name}" is secret-like and can never be given a value. Rename it; credentials are supplied through the connection, not the project.`
        : diagnostic.message,
    }];
  });
  return { decision: rendered.decision, variables: rendered.variables, diagnostics };
}

export type PreparedDecisionRequestRun =
  | { ok: true; decision: DecisionInput }
  | { ok: false; diagnostics: DecisionRequestDiagnostic[] };

/** The execution boundary: no request is sent while a diagnostic remains. */
export function prepareDecisionRequestRun(
  decision: DecisionInput,
  values: Readonly<Record<string, string>>,
): PreparedDecisionRequestRun {
  const resolved = resolveDecisionRequest(decision, values);
  return resolved.diagnostics.length > 0
    ? { ok: false, diagnostics: resolved.diagnostics }
    : { ok: true, decision: resolved.decision };
}

/**
 * Resolve historical pins, including archived templates, without selecting a
 * target. A missing pin throws rather than returning `undefined`: validated
 * projects cannot hold one, so reaching it means the caller skipped validation.
 */
function decisionTemplatePin(
  project: Pick<ProjectFile, "promptTemplates">,
  templateId: PromptTemplateId,
  templateRevisionId?: PromptTemplateRevisionId,
) {
  const template = project.promptTemplates.find(({ id }) => id === templateId);
  const revision = template?.kind === "decision"
    ? template.revisions.find(({ id }) => id === (templateRevisionId ?? template.currentRevisionId)) : undefined;
  if (!template || template.kind !== "decision" || !revision) throw new ProjectValidationError([{
    code: "custom", path: ["promptTemplates", templateId], message: "Decision template or pinned revision does not exist.",
  }]);
  return { template, revision };
}

interface DecisionRevisionMutationOptions {
  idSuffix?: string;
  createdAt?: string;
  /** Evaluation inputs can be created without replacing Compose's active request. */
  activate?: boolean;
}

export interface UseDecisionPromptTemplateRevisionOptions extends DecisionRevisionMutationOptions {
  templateId: PromptTemplateId;
  templateRevisionId?: PromptTemplateRevisionId;
  overrides?: Record<string, string>;
  name?: string;
}

/** Starts a new request. Folding or discarding the editor draft belongs to Compose. */
export function useDecisionPromptTemplateRevision(project: ProjectFile, {
  templateId, templateRevisionId, overrides = {}, name,
  idSuffix = randomUUID(), createdAt = new Date().toISOString(), activate = true,
}: UseDecisionPromptTemplateRevisionOptions): ProjectFile {
  const { template, revision } = decisionTemplatePin(project, templateId, templateRevisionId);
  if (template.archivedAt) throw new ProjectValidationError([{
    code: "custom", path: ["promptTemplates", templateId, "archivedAt"], message: "Archived templates cannot be used for new decision requests.",
  }]);
  const id = createEntityId("decision-revision", idSuffix);
  const decisionRequestId = createEntityId("decision-request", idSuffix);
  return parseProjectFile({ ...project,
    decisionRequests: [...project.decisionRequests, { id: decisionRequestId, name: name ?? template.name }],
    decisionRequestRevisions: [...project.decisionRequestRevisions, {
      kind: "template-use", id, decisionRequestId, createdAt,
      templateId, templateRevisionId: revision.id, overrides: { ...overrides },
    }],
    defaults: activate ? { ...project.defaults, decisionRequestRevisionId: id } : project.defaults,
  });
}

function templateUseRevision(project: ProjectFile, id: DecisionRequestRevisionId) {
  const revision = project.decisionRequestRevisions.find((revision) => revision.id === id);
  if (!revision || revision.kind !== "template-use") throw new ProjectValidationError([{
    code: "custom", path: ["decisionRequestRevisions", id], message: "Expected a template-backed decision request revision.",
  }]);
  return revision;
}

function appendDecisionRequestChild(project: ProjectFile, parent: ProjectDecisionRequestRevision,
  content: ({ kind: "inline"; decision: DecisionInput; values: Record<string, string> }
    | { kind: "template-use"; templateId: PromptTemplateId; templateRevisionId: PromptTemplateRevisionId; overrides: Record<string, string> }),
  { idSuffix = randomUUID(), createdAt = new Date().toISOString(), activate = true }: DecisionRevisionMutationOptions,
): ProjectFile {
  const id = createEntityId("decision-revision", idSuffix);
  return parseProjectFile({ ...project,
    decisionRequestRevisions: [...project.decisionRequestRevisions, { ...structuredClone(content), id,
      decisionRequestId: parent.decisionRequestId, parentRevisionId: parent.id, createdAt }],
    defaults: activate ? { ...project.defaults, decisionRequestRevisionId: id } : project.defaults,
  });
}

/** Override edits obey the same loaded/executed/suite-pinned freeze rules as inline drafts. */
export function updateDecisionRequestOverrides(project: ProjectFile, {
  decisionRequestRevisionId, overrides, branch, ...options
}: DecisionRevisionMutationOptions & { decisionRequestRevisionId: DecisionRequestRevisionId; overrides: Record<string, string>; branch: boolean }): ProjectFile {
  const parent = templateUseRevision(project, decisionRequestRevisionId);
  if (JSON.stringify(stableJsonValue(parent.overrides)) === JSON.stringify(stableJsonValue(overrides))) return project;
  const content = { kind: "template-use" as const, templateId: parent.templateId, templateRevisionId: parent.templateRevisionId, overrides };
  const pinned = project.evaluationSuites.some((suite) => suite.input.kind === "decision-request-revision" && suite.input.decisionRequestRevisionId === parent.id);
  if (branch || pinned) return appendDecisionRequestChild(project, parent, content, options);
  return parseProjectFile({ ...project, decisionRequestRevisions: project.decisionRequestRevisions.map((revision) =>
    revision.id === parent.id ? { ...parent, overrides: { ...overrides } } : revision) });
}

/** Explicit retargeting always creates a child; source saves never move a pin. */
export function updateDecisionRequestTemplateRevision(project: ProjectFile, {
  decisionRequestRevisionId, templateRevisionId, ...options
}: DecisionRevisionMutationOptions & { decisionRequestRevisionId: DecisionRequestRevisionId; templateRevisionId?: PromptTemplateRevisionId }): ProjectFile {
  const parent = templateUseRevision(project, decisionRequestRevisionId);
  const { template, revision } = decisionTemplatePin(project, parent.templateId, templateRevisionId);
  if (template.archivedAt) throw new ProjectValidationError([{
    code: "custom", path: ["promptTemplates", template.id, "archivedAt"], message: "Restore the archived template before choosing another revision.",
  }]);
  if (revision.id === parent.templateRevisionId) return project;
  const variables = new Set(renderDecisionInput(revision.decision, {}).variables);
  return appendDecisionRequestChild(project, parent, { kind: "template-use", templateId: template.id,
    templateRevisionId: revision.id, overrides: Object.fromEntries(Object.entries(parent.overrides).filter(([name]) => variables.has(name))) }, options);
}

/** Detach preserves tokens and absent assignments; it never renders permanent content. */
export function detachDecisionRequestTemplate(project: ProjectFile, {
  decisionRequestRevisionId, ...options
}: DecisionRevisionMutationOptions & { decisionRequestRevisionId: DecisionRequestRevisionId }): ProjectFile {
  const parent = templateUseRevision(project, decisionRequestRevisionId);
  const resolved = resolveProjectDecisionRequestRevision(project, parent.id)!;
  return appendDecisionRequestChild(project, parent, { kind: "inline", decision: resolved.decision, values: resolved.values }, options);
}
