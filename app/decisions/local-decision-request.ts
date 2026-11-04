import type { DecisionInput } from "../../packages/core/src/decision.ts";
import { DEFAULT_DECISION_REQUEST_NAME, resolveProjectDecisionRequestRevision } from "../../packages/core/src/decision-request.ts";
import { discoverDecisionVariables } from "../../packages/core/src/decision-variables.ts";
import type { ProjectDecisionRequestRevision, ProjectFile } from "../../packages/core/src/project.ts";
import type {
  LocalDecisionInput,
  WorkbenchDecisionRequestContent,
  WorkbenchDecisionRequestDraftV1,
  WorkbenchDraftV1,
  WorkbenchScratchV1,
} from "../../packages/core/src/personal-workbench.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/types.ts";
import type { DecisionRequestId, DecisionRequestRevisionId } from "../../packages/core/src/run-kernel/types.ts";
import { decisionRevisionContent } from "../workbench/personal-workbench-controller.ts";
import { decisionTemplateUseOverrides } from "./decision-template-use-overrides.ts";
import { requestMenu } from "../workbench/request-menu.ts";
import type { RequestMenu } from "../workbench/request-menu.ts";

/**
 * Pure helpers for the decision request a personal session's composer edits
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 4 decisions"). The record is
 * a saved revision, its request draft, a scratch, or nothing yet; none of
 * these helpers writes a project or a record.
 */

export type SelectedDecisionRecord =
  /** No selection and no launch default: the next valid edit starts a scratch (Q2). */
  | { kind: "none"; content?: undefined; revision?: undefined }
  | { kind: "saved"; content: WorkbenchDecisionRequestContent; revision: ProjectDecisionRequestRevision }
  /** `revision` is the draft's base, when the project still holds it. */
  | { kind: "draft"; content: WorkbenchDecisionRequestContent; draft: WorkbenchDecisionRequestDraftV1; revision: ProjectDecisionRequestRevision | undefined }
  | { kind: "scratch"; content: WorkbenchDecisionRequestContent; scratch: WorkbenchScratchV1; revision?: undefined };

/**
 * Which record this is, apart from its content: two scratches with the same
 * content are still two records.
 */
export function decisionRecordIdentity(record: SelectedDecisionRecord | undefined): string {
  switch (record?.kind) {
    case "saved": return `saved:${record.revision.id}`;
    case "draft": return `draft:${record.draft.draftId}`;
    case "scratch": return `scratch:${record.scratch.scratchId}`;
    default: return "none";
  }
}

export interface LocalDecisionRecords {
  draftById(draftId: string): WorkbenchDraftV1 | undefined;
  scratch(scratchId: string): WorkbenchScratchV1 | undefined;
}

function savedRecord(project: ProjectFile, revisionId: DecisionRequestRevisionId | undefined): SelectedDecisionRecord | undefined {
  const revision = revisionId && project.decisionRequestRevisions.find(({ id }) => id === revisionId);
  return revision ? { kind: "saved", content: decisionRevisionContent(revision), revision } : undefined;
}

function launchDefault(project: ProjectFile): SelectedDecisionRecord {
  return savedRecord(project, project.defaults.decisionRequestRevisionId) ?? { kind: "none" };
}

/**
 * What the decision composer edits. No selection, or one that names nothing
 * here (a deleted revision, a discarded record), inherits the launch default.
 */
export function selectedDecisionRecord(
  project: ProjectFile,
  selection: LocalDecisionInput | undefined,
  records: LocalDecisionRecords,
): SelectedDecisionRecord {
  switch (selection?.kind) {
    case "saved-decision-request-revision":
      return savedRecord(project, selection.revisionId) ?? launchDefault(project);
    case "draft": {
      const draft = records.draftById(selection.draftId);
      if (draft?.asset.kind !== "decision-request") return launchDefault(project);
      const request = draft as WorkbenchDecisionRequestDraftV1;
      const revision = project.decisionRequestRevisions.find(({ id }) => id === request.base.revisionId);
      return { kind: "draft", content: structuredClone(request.edited), draft: request, revision };
    }
    case "scratch": {
      const scratch = records.scratch(selection.scratchId);
      if (scratch?.request.kind !== "decision") return launchDefault(project);
      return { kind: "scratch", content: structuredClone(scratch.request.content), scratch };
    }
    default:
      return launchDefault(project);
  }
}

const OVERLAY_REQUEST = createEntityId("decision-request", "local-overlay");
const OVERLAY_REVISION = createEntityId("decision-revision", "local-overlay");

function overlayProject(project: ProjectFile, content: WorkbenchDecisionRequestContent): ProjectFile {
  const revision = {
    ...structuredClone(content), id: OVERLAY_REVISION, decisionRequestId: OVERLAY_REQUEST, createdAt: "1970-01-01T00:00:00.000Z",
  } as ProjectDecisionRequestRevision;
  return {
    ...project,
    decisionRequests: [...project.decisionRequests, { id: OVERLAY_REQUEST, name: "Local request" }],
    decisionRequestRevisions: [...project.decisionRequestRevisions, revision],
  };
}

export interface ResolvedDecisionContent {
  decision: DecisionInput;
  /** Supplied values: an inline request's own, or a pin's defaults under its overrides. */
  values: Record<string, string>;
  variables: string[];
}

/** The decision and values the editor shows; undefined when a template pin no longer resolves. */
export function resolveDecisionContent(project: ProjectFile, content: WorkbenchDecisionRequestContent): ResolvedDecisionContent | undefined {
  try {
    const resolved = resolveProjectDecisionRequestRevision(overlayProject(project, content), OVERLAY_REVISION);
    return resolved && { decision: resolved.decision, values: resolved.values, variables: resolved.variables };
  } catch {
    return undefined;
  }
}

/**
 * Applies a core revision helper (retarget, detach) to local content. The
 * helper runs against a copy of the project that also holds the content as a
 * throwaway revision, so it validates pins exactly as it would for a saved
 * one; only the resulting content is kept.
 */
export function decisionContentAfterMutation(
  project: ProjectFile,
  content: WorkbenchDecisionRequestContent,
  mutate: (project: ProjectFile, revisionId: DecisionRequestRevisionId) => ProjectFile,
): WorkbenchDecisionRequestContent {
  const overlay = overlayProject(project, content);
  const next = mutate(overlay, OVERLAY_REVISION);
  if (next === overlay) return structuredClone(content);
  const child = next.decisionRequestRevisions.find(({ parentRevisionId }) => parentRevisionId === OVERLAY_REVISION)
    ?? next.decisionRequestRevisions.find(({ id }) => id === OVERLAY_REVISION);
  if (!child) throw new Error("The edit did not apply to this request.");
  return decisionRevisionContent(child);
}

/**
 * The record content for what the editor holds now. A template-use pin keeps
 * its pin and records only sparse overrides (D11); inline content keeps values
 * only for variables the decision uses, as a saved revision does.
 */
export function editedDecisionContent(
  project: ProjectFile,
  current: WorkbenchDecisionRequestContent | undefined,
  edited: { decision: DecisionInput; values: Readonly<Record<string, string>> },
): WorkbenchDecisionRequestContent | undefined {
  if (current?.kind === "template-use") {
    const resolved = resolveDecisionContent(project, current);
    if (!resolved) return undefined;
    return {
      ...structuredClone(current),
      overrides: decisionTemplateUseOverrides({
        variables: resolved.variables,
        effectiveValues: resolved.values,
        existingOverrides: current.overrides,
        values: edited.values,
      }),
    };
  }
  const { variables } = discoverDecisionVariables(edited.decision);
  return {
    kind: "inline",
    decision: structuredClone(edited.decision),
    values: Object.fromEntries(variables.flatMap((name) => Object.hasOwn(edited.values, name) ? [[name, edited.values[name]!]] : [])),
  };
}

/** Whether Save asks for a name: a scratch whose parent chain reaches no saved revision. */
export function decisionScratchNeedsName(scratch: WorkbenchScratchV1, records: LocalDecisionRecords): boolean {
  let parent = scratch.request.parent;
  const seen = new Set([scratch.scratchId]);
  while (parent?.kind === "scratch" && !seen.has(parent.scratchId)) {
    seen.add(parent.scratchId);
    parent = records.scratch(parent.scratchId)?.request.parent;
  }
  return parent?.kind !== "saved-decision-request-revision";
}

/** Q2: a new request is offered its prompt's name, or the default request name. */
export function suggestedDecisionRequestName(project: ProjectFile, content: WorkbenchDecisionRequestContent): string {
  if (content.kind === "template-use") {
    const template = project.promptTemplates.find(({ id }) => id === content.templateId);
    if (template?.name.trim()) return template.name;
  }
  return DEFAULT_DECISION_REQUEST_NAME;
}

/** The nearest saved revision a decision scratch's parent chain reaches. */
export function decisionSavedAncestor(
  scratch: WorkbenchScratchV1,
  records: Pick<LocalDecisionRecords, "scratch">,
): DecisionRequestRevisionId | undefined {
  let parent = scratch.request.kind === "decision" ? scratch.request.parent : undefined;
  const seen = new Set([scratch.scratchId]);
  while (parent?.kind === "scratch" && !seen.has(parent.scratchId)) {
    seen.add(parent.scratchId);
    const next = records.scratch(parent.scratchId);
    parent = next?.request.kind === "decision" ? next.request.parent : undefined;
  }
  return parent?.kind === "saved-decision-request-revision" ? parent.revisionId : undefined;
}

/** The decision switcher's entries (T1). */
export function decisionRequestMenu(
  project: ProjectFile,
  selected: SelectedDecisionRecord,
  records: LocalDecisionRecords & {
    scratches: readonly WorkbenchScratchV1[];
    draftFor(asset: { kind: "decision-request"; id: DecisionRequestId }): WorkbenchDraftV1 | undefined;
  },
): RequestMenu {
  return requestMenu({
    requests: project.decisionRequests,
    revisions: project.decisionRequestRevisions.map(({ id, decisionRequestId, createdAt }) => ({ id, requestId: decisionRequestId, createdAt })),
    launchRevisionId: project.defaults.decisionRequestRevisionId,
    draftFor(requestId) {
      const draft = records.draftFor({ kind: "decision-request", id: requestId as DecisionRequestId });
      return draft?.asset.kind === "decision-request"
        ? { draftId: draft.draftId, baseRevisionId: (draft as WorkbenchDecisionRequestDraftV1).base.revisionId }
        : undefined;
    },
    scratches: records.scratches
      .filter((scratch) => scratch.request.kind === "decision" && scratch.projectId === project.projectId)
      .map((scratch) => {
        const ancestor = decisionSavedAncestor(scratch, records);
        return {
          scratchId: scratch.scratchId,
          createdAt: scratch.createdAt,
          branched: false,
          ...(ancestor ? { savedAncestorRevisionId: ancestor } : {}),
        };
      }),
    selected: selected.kind === "saved"
      ? { kind: "saved", revisionId: selected.revision.id }
      : selected.kind === "draft"
        ? { kind: "draft", draftId: selected.draft.draftId }
        : selected.kind === "scratch"
          ? { kind: "scratch", scratchId: selected.scratch.scratchId }
          : undefined,
  });
}
