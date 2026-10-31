import { parseProjectFile, ProjectValidationError } from "./project.ts";
import type {
  ProjectConversationRevision,
  ProjectDecisionRequestRevision,
  ProjectFile,
  PromptTemplate,
  PromptTemplateRevision,
} from "./project.ts";
import { parseWorkbenchRecord } from "./personal-workbench.ts";
import type {
  WorkbenchChatRequestDraftV1,
  WorkbenchDecisionRequestContent,
  WorkbenchDecisionRequestDraftV1,
  WorkbenchDraftV1,
  WorkbenchPromptDraftV1,
  WorkbenchScratchV1,
} from "./personal-workbench.ts";
import { randomUUID } from "./random-id.ts";
import { createEntityId } from "./run-kernel/types.ts";
import { stableJsonValue } from "./stable-json.ts";

/**
 * Pure publication operations for personal drafts and scratch records
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Publication and migration
 * recovery" and "Core operations"). None of them writes a file. The owner runs
 * the protocol: write the returned intent into the record and read it back,
 * write the returned project, then settle the record with
 * `completePublication` or `clearPublication`. On restart it settles a record
 * that still carries an intent with `reconcilePublication` first.
 *
 * Publication never moves `defaults`: saving a request moves only the personal
 * selection (D10, D11). Saving a prompt moves its template's current revision,
 * as saving a template does today.
 */

export interface PublishOptions {
  idSuffix?: string;
  createdAt?: string;
}

export type DraftPublication<R extends WorkbenchDraftV1> =
  | { kind: "publish"; project: ProjectFile; intent: NonNullable<R["publishing"]> }
  /** Content equals the base: no shared write. Clear the draft once the base is confirmed. */
  | { kind: "unchanged" };

export interface ScratchPublication {
  project: ProjectFile;
  intent: NonNullable<WorkbenchScratchV1["publishing"]>;
}

export type PublicationState = "published" | "not-published" | "conflict";

type PublishableRecord = WorkbenchDraftV1 | WorkbenchScratchV1;
type Path = Array<string | number>;

function refuse(path: Path, message: string): never {
  throw new ProjectValidationError([{ code: "custom", path, message }]);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

function checkProject(project: ProjectFile, record: PublishableRecord): void {
  if (record.projectId !== project.projectId) refuse(["projectId"], "Workbench record belongs to a different project.");
}

function checkPublishable(project: ProjectFile, record: PublishableRecord): void {
  checkProject(project, record);
  if (record.publishing) refuse(["publishing"], "Settle the pending publication before publishing again.");
}

/** A prompt's content without its label: a later rename is not new content. */
function promptBody(content: { variableDefaults: Record<string, string> } & ({ messages: unknown } | { decision: unknown })) {
  return "messages" in content
    ? { messages: content.messages, variableDefaults: content.variableDefaults }
    : { decision: content.decision, variableDefaults: content.variableDefaults };
}

function decisionContent(revision: ProjectDecisionRequestRevision): WorkbenchDecisionRequestContent {
  return revision.kind === "inline"
    ? { kind: "inline", decision: revision.decision, values: revision.values }
    : { kind: "template-use", templateId: revision.templateId, templateRevisionId: revision.templateRevisionId, overrides: revision.overrides };
}

const orphanedBase = "The draft's base revision no longer exists. Compare it and save it as a new request instead.";

function promptTemplateFor(project: ProjectFile, record: WorkbenchPromptDraftV1): PromptTemplate {
  const kind = record.asset.kind === "chat-prompt" ? "chat" : "decision";
  const template = project.promptTemplates.find(({ id }) => id === record.asset.id);
  if (!template || template.kind !== kind) refuse(["asset", "id"], "The draft's template no longer exists.");
  return template;
}

export function publishPromptDraft(
  project: ProjectFile,
  record: WorkbenchPromptDraftV1,
  { idSuffix = randomUUID(), createdAt = new Date().toISOString() }: PublishOptions = {},
): DraftPublication<WorkbenchPromptDraftV1> {
  checkPublishable(project, record);
  const template = promptTemplateFor(project, record);
  const base = (template.revisions as PromptTemplateRevision[]).find(({ id }) => id === record.base.revisionId);
  if (!base) refuse(["base", "revisionId"], "The draft's base revision no longer exists. Compare it and save it as a new prompt instead.");
  const body = promptBody(record.edited);
  if (same(promptBody(base), body)) return { kind: "unchanged" };
  const revisionId = createEntityId("template-revision", idSuffix);
  const name = record.edited.revisionName?.trim();
  const revision = { id: revisionId, createdAt, ...(name ? { name } : {}), ...structuredClone(body) };
  const next = parseProjectFile({
    ...project,
    promptTemplates: project.promptTemplates.map(entry => entry.id !== template.id ? entry : {
      ...template, currentRevisionId: revisionId, revisions: [...template.revisions, revision],
    }),
  });
  return {
    kind: "publish",
    project: next,
    intent: { revisionId, parentRevisionId: base.id, content: structuredClone(record.edited) } as NonNullable<WorkbenchPromptDraftV1["publishing"]>,
  };
}

export function publishChatRequestDraft(
  project: ProjectFile,
  record: WorkbenchChatRequestDraftV1,
  { idSuffix = randomUUID(), createdAt = new Date().toISOString() }: PublishOptions = {},
): DraftPublication<WorkbenchChatRequestDraftV1> {
  checkPublishable(project, record);
  const base = project.conversationRevisions.find(({ id }) => id === record.base.revisionId);
  if (!base || base.conversationId !== record.asset.id) refuse(["base", "revisionId"], orphanedBase);
  if (same(base.items, record.edited.items)) return { kind: "unchanged" };
  const revisionId = createEntityId("revision", idSuffix);
  const revision: ProjectConversationRevision = {
    id: revisionId, conversationId: base.conversationId, parentRevisionId: base.id, items: structuredClone(record.edited.items), createdAt,
  };
  return {
    kind: "publish",
    project: parseProjectFile({ ...project, conversationRevisions: [...project.conversationRevisions, revision] }),
    intent: { revisionId, parentRevisionId: base.id, content: structuredClone(record.edited) },
  };
}

export function publishDecisionRequestDraft(
  project: ProjectFile,
  record: WorkbenchDecisionRequestDraftV1,
  { idSuffix = randomUUID(), createdAt = new Date().toISOString() }: PublishOptions = {},
): DraftPublication<WorkbenchDecisionRequestDraftV1> {
  checkPublishable(project, record);
  const base = project.decisionRequestRevisions.find(({ id }) => id === record.base.revisionId);
  if (!base || base.decisionRequestId !== record.asset.id) refuse(["base", "revisionId"], orphanedBase);
  if (same(decisionContent(base), record.edited)) return { kind: "unchanged" };
  const revisionId = createEntityId("decision-revision", idSuffix);
  const revision = {
    ...structuredClone(record.edited), id: revisionId, decisionRequestId: base.decisionRequestId, parentRevisionId: base.id, createdAt,
  } as ProjectDecisionRequestRevision;
  return {
    kind: "publish",
    project: parseProjectFile({ ...project, decisionRequestRevisions: [...project.decisionRequestRevisions, revision] }),
    intent: { revisionId, parentRevisionId: base.id, content: structuredClone(record.edited) },
  };
}

type ScratchParent = NonNullable<WorkbenchScratchV1["request"]["parent"]>;

/**
 * Follows local parents to the nearest saved ancestor. Undefined means the
 * chain ends at a root scratch, so publication creates a request.
 */
function savedAncestor(record: WorkbenchScratchV1, scratches: readonly WorkbenchScratchV1[]): Exclude<ScratchParent, { kind: "scratch" }> | undefined {
  const seen = new Set([record.scratchId]);
  let parent: ScratchParent | undefined = record.request.parent;
  while (parent?.kind === "scratch") {
    const { scratchId } = parent;
    if (seen.has(scratchId)) refuse(["request", "parent"], "The scratch's parent chain loops.");
    seen.add(scratchId);
    const next = scratches.find(candidate => candidate.scratchId === scratchId && candidate.projectId === record.projectId);
    if (!next) refuse(["request", "parent"], "A parent scratch is missing, so the saved ancestor is unknown.");
    if (next.request.kind !== record.request.kind) refuse(["request", "parent"], "A parent scratch is a request of a different kind.");
    parent = next.request.parent;
  }
  return parent;
}

export interface PublishScratchOptions extends PublishOptions {
  /** The store's other scratch records, to follow a local parent chain. */
  scratches: readonly WorkbenchScratchV1[];
  /** Names a new request. Ignored when the scratch has a saved ancestor. */
  name?: string;
}

/**
 * With a saved ancestor the scratch publishes as one child of it, inside its
 * request; the local steps between are omitted (D10). Without one it creates
 * a named request. Its local conversation ID never reaches the project.
 */
export function publishScratch(
  project: ProjectFile,
  record: WorkbenchScratchV1,
  { scratches, name, idSuffix = randomUUID(), createdAt = new Date().toISOString() }: PublishScratchOptions,
): ScratchPublication {
  checkPublishable(project, record);
  const ancestor = savedAncestor(record, scratches);
  const trimmed = name?.trim();
  if (!ancestor && !trimmed) refuse(["name"], "A scratch with no saved ancestor creates a request, which needs a name.");
  const missingAncestor = "The scratch's saved ancestor no longer exists.";
  const { request } = record;
  if (request.kind === "chat") {
    const revisionId = createEntityId("revision", idSuffix);
    const content = { items: structuredClone(request.items) };
    if (ancestor) {
      const parent = project.conversationRevisions.find(({ id }) => id === ancestor.revisionId);
      if (!parent) refuse(["request", "parent"], missingAncestor);
      return {
        project: parseProjectFile({ ...project, conversationRevisions: [...project.conversationRevisions, {
          id: revisionId, conversationId: parent.conversationId, parentRevisionId: parent.id, items: structuredClone(content.items), createdAt,
        }] }),
        intent: { conversationId: parent.conversationId, revisionId, parentRevisionId: parent.id, content },
      };
    }
    const conversationId = createEntityId("conversation", idSuffix);
    return {
      project: parseProjectFile({
        ...project,
        conversations: [...project.conversations, { id: conversationId, name: trimmed! }],
        conversationRevisions: [...project.conversationRevisions, { id: revisionId, conversationId, items: structuredClone(content.items), createdAt }],
      }),
      intent: { conversationId, name: trimmed!, revisionId, content },
    };
  }
  const revisionId = createEntityId("decision-revision", idSuffix);
  const content = structuredClone(request.content);
  if (ancestor) {
    const parent = project.decisionRequestRevisions.find(({ id }) => id === ancestor.revisionId);
    if (!parent) refuse(["request", "parent"], missingAncestor);
    const revision = { ...structuredClone(content), id: revisionId, decisionRequestId: parent.decisionRequestId, parentRevisionId: parent.id, createdAt } as ProjectDecisionRequestRevision;
    return {
      project: parseProjectFile({ ...project, decisionRequestRevisions: [...project.decisionRequestRevisions, revision] }),
      intent: { decisionRequestId: parent.decisionRequestId, revisionId, parentRevisionId: parent.id, content },
    };
  }
  const decisionRequestId = createEntityId("decision-request", idSuffix);
  const revision = { ...structuredClone(content), id: revisionId, decisionRequestId, createdAt } as ProjectDecisionRequestRevision;
  return {
    project: parseProjectFile({
      ...project,
      decisionRequests: [...project.decisionRequests, { id: decisionRequestId, name: trimmed! }],
      decisionRequestRevisions: [...project.decisionRequestRevisions, revision],
    }),
    intent: { decisionRequestId, name: trimmed!, revisionId, content },
  };
}

/** The saved revision an intent names, if it is the publication the intent describes. */
type PublishedRevision =
  | { kind: "template"; revision: PromptTemplateRevision }
  | { kind: "conversation"; revision: ProjectConversationRevision }
  | { kind: "decision"; revision: ProjectDecisionRequestRevision };

function locate(project: ProjectFile, record: PublishableRecord): { state: PublicationState; published?: PublishedRevision } {
  checkProject(project, record);
  const intent = record.publishing;
  if (!intent) refuse(["publishing"], "The record has no pending publication.");
  const settle = (matches: boolean, published: PublishedRevision) =>
    matches ? { state: "published" as const, published } : { state: "conflict" as const };

  if (record.kind === "scratch") {
    const scratchIntent = intent as NonNullable<WorkbenchScratchV1["publishing"]>;
    const parentMatches = (parentRevisionId?: string) => parentRevisionId === scratchIntent.parentRevisionId;
    if ("conversationId" in scratchIntent) {
      const revision = project.conversationRevisions.find(({ id }) => id === intent.revisionId);
      if (!revision) return { state: "not-published" };
      return settle(revision.conversationId === scratchIntent.conversationId && parentMatches(revision.parentRevisionId)
        && same(revision.items, (scratchIntent.content as { items: unknown }).items), { kind: "conversation", revision });
    }
    const revision = project.decisionRequestRevisions.find(({ id }) => id === scratchIntent.revisionId);
    if (!revision) return { state: "not-published" };
    return settle(revision.decisionRequestId === scratchIntent.decisionRequestId && parentMatches(revision.parentRevisionId)
      && same(decisionContent(revision), scratchIntent.content), { kind: "decision", revision });
  }

  const draft = record as WorkbenchDraftV1;
  const draftIntent = intent as { revisionId: string; parentRevisionId: string; content: unknown };
  switch (draft.asset.kind) {
    case "chat-prompt":
    case "decision-prompt": {
      // Template revisions record no parent, so the owning template stands in for it.
      for (const template of project.promptTemplates) {
        const revision = (template.revisions as PromptTemplateRevision[]).find(({ id }) => id === draftIntent.revisionId);
        if (!revision) continue;
        const kind = draft.asset.kind === "chat-prompt" ? "chat" : "decision";
        return settle(template.id === draft.asset.id && template.kind === kind
          && same(promptBody(revision), promptBody(draftIntent.content as WorkbenchPromptDraftV1["edited"])), { kind: "template", revision });
      }
      return { state: "not-published" };
    }
    case "chat-request": {
      const revision = project.conversationRevisions.find(({ id }) => id === draftIntent.revisionId);
      if (!revision) return { state: "not-published" };
      return settle(revision.conversationId === draft.asset.id && revision.parentRevisionId === draftIntent.parentRevisionId
        && same(revision.items, (draftIntent.content as { items: unknown }).items), { kind: "conversation", revision });
    }
    case "decision-request": {
      const revision = project.decisionRequestRevisions.find(({ id }) => id === draftIntent.revisionId);
      if (!revision) return { state: "not-published" };
      return settle(revision.decisionRequestId === draft.asset.id && revision.parentRevisionId === draftIntent.parentRevisionId
        && same(decisionContent(revision), draftIntent.content), { kind: "decision", revision });
    }
  }
}

/**
 * Settles a record that carries an intent against the shared document (step
 * 4). A revision with the intended ID, owner, parent and frozen content is
 * published. No such ID means the shared write never landed. The ID with
 * anything else is a conflict for review: matching an ID alone is not enough.
 */
export function reconcilePublication(project: ProjectFile, record: PublishableRecord): PublicationState {
  return locate(project, record).state;
}

export interface PublicationCompletion<R extends PublishableRecord> {
  /** Replace the publishing record with this value, or delete it when absent. */
  record: R | undefined;
  /** Persist and read back ALL rewrites before settling the publishing record. */
  scratchRewrites: Array<{ before: WorkbenchScratchV1; after: WorkbenchScratchV1 }>;
}

/**
 * Plan step 3 after the shared write is confirmed. `scratches` must be the
 * complete current project scratch inventory (including any new branches).
 * Under the owner's serialized local mutation scope, compare each `before`
 * with storage, write `after`, and confirm it by read-back. On conflict or
 * failure retain the parent's publishing intent and replan from fresh records.
 * Only after every rewrite is confirmed may the owner replace/delete `record`.
 * Replanning after partial writes returns only the children still referencing
 * the parent. No new child may be added between planning and parent cleanup.
 * Frozen intents on children are retained: they describe independent writes.
 */
export function completePublication<R extends PublishableRecord>(
  project: ProjectFile,
  record: R,
  scratches: readonly WorkbenchScratchV1[],
): PublicationCompletion<R> {
  const { state, published } = locate(project, record);
  if (state !== "published" || !published) refuse(["publishing"], "The publication has not landed in the shared document.");
  const intent = record.publishing!;
  const next = clearPublication(record) as PublishableRecord;
  if (next.kind === "scratch") {
    const { request } = next;
    const current = request.kind === "chat" ? { items: request.items } : request.content;
    const parent = request.kind === "chat"
      ? { kind: "saved-conversation-revision", revisionId: intent.revisionId }
      : { kind: "saved-decision-request-revision", revisionId: intent.revisionId };
    const scratchRewrites = scratches.flatMap(child => {
      if (child.projectId !== project.projectId || child.request.parent?.kind !== "scratch"
        || child.request.parent.scratchId !== next.scratchId) return [];
      if (child.scratchId === next.scratchId || child.request.kind !== request.kind) {
        refuse(["request", "parent"], "A dependent scratch has an invalid parent relationship.");
      }
      return [{
        before: structuredClone(child),
        after: parseWorkbenchRecord({ ...structuredClone(child), request: { ...structuredClone(child.request), parent } }) as WorkbenchScratchV1,
      }];
    });
    return {
      record: same(current, intent.content) ? undefined
        : parseWorkbenchRecord({ ...next, request: { ...request, parent } }) as R,
      scratchRewrites,
    };
  }
  return {
    record: same(next.edited, intent.content) ? undefined
      : parseWorkbenchRecord({ ...next, base: { revisionId: intent.revisionId, snapshot: structuredClone(published.revision) } }) as R,
    scratchRewrites: [],
  };
}

/** A failed or refused shared write keeps the work and drops the intent (step 2). */
export function clearPublication<R extends PublishableRecord>(record: R): R {
  const next = structuredClone(record);
  delete next.publishing;
  return next;
}
