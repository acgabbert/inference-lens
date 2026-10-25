import type { DecisionInput } from "./decision.ts";
import { renderDecisionInput } from "./decision-variables.ts";
import type { DecisionVariableField } from "./decision-variables.ts";
import {
  isSensitiveTemplateVariableName,
  parseProjectFile,
} from "./project.ts";
import type {
  ProjectDecisionRequestRevision,
  ProjectFile,
} from "./project.ts";
import { randomUUID } from "./random-id.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type { DecisionRequestId, DecisionRequestRevisionId } from "./run-kernel/types.ts";
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
    kind: "inline";
    decisionRequestId: DecisionRequestId;
    decisionRequestRevisionId: DecisionRequestRevisionId;
  };
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
  const decision = structuredClone(revision.decision);
  const values = { ...revision.values };
  const { variables, diagnostics } = resolveDecisionRequest(decision, values);
  return {
    decision,
    values,
    source: {
      kind: "inline",
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
  return (
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
