import { authoredItemsForMessages } from "../../packages/core/src/project.ts";
import type {
  ProjectConversationItem,
  ProjectConversationRevision,
  ProjectFile,
  TemplateResolutionContext,
} from "../../packages/core/src/project.ts";
import type {
  LocalChatInput,
  WorkbenchChatRequestDraftV1,
  WorkbenchDraftV1,
  WorkbenchScratchV1,
} from "../../packages/core/src/personal-workbench.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/types.ts";
import type {
  ConversationId,
  ConversationMessage,
  ConversationRevisionId,
  RunConversationIdentity,
  RunTrace,
} from "../../packages/core/src/run-kernel/types.ts";
import { randomUUID } from "../../packages/core/src/random-id.ts";
import type { ChatScratchParent } from "../workbench/personal-workbench-controller.ts";
import { requestMenu } from "../workbench/request-menu.ts";
import type { RequestMenu } from "../workbench/request-menu.ts";

/**
 * Pure helpers for the chat request a personal session's composer edits
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 3 decisions"). The record is
 * a saved revision, its request draft, or a scratch; none of these helpers
 * writes a project or a record.
 */

export type SelectedChatRecord =
  | { kind: "saved"; items: ProjectConversationItem[]; revision: ProjectConversationRevision | undefined }
  /** `revision` is the draft's base, when the project still holds it. */
  | { kind: "draft"; items: ProjectConversationItem[]; draft: WorkbenchChatRequestDraftV1; revision: ProjectConversationRevision | undefined }
  | { kind: "scratch"; items: ProjectConversationItem[]; scratch: WorkbenchScratchV1; revision?: undefined };

export interface LocalChatRecords {
  draftById(draftId: string): WorkbenchDraftV1 | undefined;
  scratch(scratchId: string): WorkbenchScratchV1 | undefined;
}

function launchDefault(project: ProjectFile): SelectedChatRecord {
  const revision = project.conversationRevisions.find(({ id }) => id === project.defaults.conversationRevisionId);
  return { kind: "saved", items: revision ? structuredClone(revision.items) : [], revision };
}

/**
 * What the composer edits. No selection, or one that names nothing here (a
 * deleted revision, a discarded record), inherits the launch default.
 */
export function selectedChatRecord(
  project: ProjectFile,
  selection: LocalChatInput | undefined,
  records: LocalChatRecords,
): SelectedChatRecord {
  switch (selection?.kind) {
    case "saved-conversation-revision": {
      const revision = project.conversationRevisions.find(({ id }) => id === selection.revisionId);
      return revision ? { kind: "saved", items: structuredClone(revision.items), revision } : launchDefault(project);
    }
    case "draft": {
      const draft = records.draftById(selection.draftId);
      if (draft?.asset.kind !== "chat-request") return launchDefault(project);
      const request = draft as WorkbenchChatRequestDraftV1;
      const revision = project.conversationRevisions.find(({ id }) => id === request.base.revisionId);
      return { kind: "draft", items: structuredClone(request.edited.items), draft: request, revision };
    }
    case "scratch": {
      const scratch = records.scratch(selection.scratchId);
      if (scratch?.request.kind !== "chat") return launchDefault(project);
      return { kind: "scratch", items: structuredClone(scratch.request.items), scratch };
    }
    default:
      return launchDefault(project);
  }
}

const OVERLAY_CONVERSATION = createEntityId("conversation", "local-overlay");
const OVERLAY_REVISION = createEntityId("revision", "local-overlay");

/** A revision that renders local items; it is never part of a project. */
export function localRevision(
  items: ProjectConversationItem[],
  identity: RunConversationIdentity = { conversationId: OVERLAY_CONVERSATION, conversationRevisionId: OVERLAY_REVISION },
): ProjectConversationRevision {
  return { id: identity.conversationRevisionId, conversationId: identity.conversationId, items, createdAt: "1970-01-01T00:00:00.000Z" };
}

/**
 * Applies a core revision helper (insert, values, revision change, detach,
 * remove) to local items. The helper runs against a copy of the project that
 * also holds the items as a throwaway revision, so it validates pins exactly
 * as it would for a saved one; only the resulting items are kept.
 */
export function itemsAfterMutation(
  project: ProjectFile,
  items: ProjectConversationItem[],
  mutate: (project: ProjectFile, revisionId: ConversationRevisionId) => ProjectFile,
): ProjectConversationItem[] {
  const overlay: ProjectFile = {
    ...project,
    conversations: [...project.conversations, { id: OVERLAY_CONVERSATION, name: "Local request" }],
    conversationRevisions: [...project.conversationRevisions, localRevision(structuredClone(items))],
  };
  const next = mutate(overlay, OVERLAY_REVISION);
  const revision = next.conversationRevisions.find(({ id }) => id === OVERLAY_REVISION);
  if (!revision) throw new Error("The edit did not apply to this request.");
  return structuredClone(revision.items);
}

export interface LocalChatRunInput {
  items: ProjectConversationItem[];
  identity: RunConversationIdentity;
  /** True for a draft or scratch: nothing in the project pins this revision. */
  local: boolean;
  branchedFrom?: RunTrace["branchedFrom"];
  /** Where a branch from this run would hang: its nearest saved ancestor (R2). */
  branchParent?: ChatScratchParent;
}

/**
 * The run identity (I3): a saved revision runs as itself, a request draft
 * under its saved conversation and a scratch under its local conversation,
 * each with a fresh revision ID that never reaches the project. Every run of
 * an unsaved scratch records its branch point (R3).
 */
export function localRunInput(record: SelectedChatRecord, idSuffix: string = randomUUID()): LocalChatRunInput {
  const fresh = createEntityId("revision", idSuffix);
  switch (record.kind) {
    case "saved":
      return {
        items: record.items,
        identity: { conversationId: record.revision!.conversationId, conversationRevisionId: record.revision!.id },
        local: false,
        branchParent: { kind: "saved-conversation-revision", revisionId: record.revision!.id },
      };
    case "draft":
      return {
        items: record.items,
        identity: { conversationId: record.draft.asset.id as ConversationId, conversationRevisionId: fresh },
        local: true,
        branchParent: { kind: "saved-conversation-revision", revisionId: record.draft.base.revisionId },
      };
    case "scratch": {
      const { scratch } = record;
      const parent = scratch.request.parent;
      return {
        items: record.items,
        identity: { conversationId: scratch.localConversationId, conversationRevisionId: fresh },
        local: true,
        ...(scratch.branchedFrom ? {
          branchedFrom: {
            runId: scratch.branchedFrom.runId as RunTrace["runId"],
            messageId: scratch.branchedFrom.messageId,
            ...(parent?.kind === "saved-conversation-revision" ? { parentConversationRevisionId: parent.revisionId } : {}),
          },
        } : {}),
        branchParent: { kind: "scratch", scratchId: scratch.scratchId },
      };
    }
  }
}

/**
 * R2. The parent of a scratch branched from a run: the run's revision when
 * the project holds it, else what this tab remembers about the live run, else
 * the scratch whose local conversation the run used, else nothing (Save then
 * asks for a name and creates a request).
 */
export function branchScratchParent(
  project: ProjectFile,
  scratches: readonly WorkbenchScratchV1[],
  run: { conversationId?: ConversationId; conversationRevisionId?: ConversationRevisionId },
  remembered?: ChatScratchParent,
): ChatScratchParent | undefined {
  if (run.conversationRevisionId && project.conversationRevisions.some(({ id }) => id === run.conversationRevisionId)) {
    return { kind: "saved-conversation-revision", revisionId: run.conversationRevisionId };
  }
  if (remembered?.kind === "saved-conversation-revision"
    && project.conversationRevisions.some(({ id }) => id === remembered.revisionId)) return remembered;
  if (remembered?.kind === "scratch"
    && scratches.some(({ scratchId, request }) => scratchId === remembered.scratchId && request.kind === "chat")) return remembered;
  const scratch = scratches.find(({ localConversationId, request }) => request.kind === "chat" && localConversationId === run.conversationId);
  return scratch ? { kind: "scratch", scratchId: scratch.scratchId } : undefined;
}

/** The parent's items, so a branch keeps the template uses it did not change. */
export function chatParentItems(
  project: ProjectFile,
  scratches: readonly WorkbenchScratchV1[],
  parent: ChatScratchParent | undefined,
): ProjectConversationItem[] | undefined {
  if (parent?.kind === "saved-conversation-revision") {
    return project.conversationRevisions.find(({ id }) => id === parent.revisionId)?.items;
  }
  if (parent?.kind === "scratch") {
    const scratch = scratches.find(({ scratchId }) => scratchId === parent.scratchId);
    return scratch?.request.kind === "chat" ? scratch.request.items : undefined;
  }
  return undefined;
}

/** A branch's messages as authored items over its parent's, or literal messages. */
export function branchItems(
  project: ProjectFile,
  parentItems: ProjectConversationItem[] | undefined,
  messages: ConversationMessage[],
  context: TemplateResolutionContext,
): ProjectConversationItem[] {
  if (parentItems) {
    try {
      return authoredItemsForMessages(project, localRevision(structuredClone(parentItems)), messages, context);
    } catch {
      // A parent that no longer resolves contributes nothing reusable.
    }
  }
  return messages.map((message) => ({ kind: "message", message: structuredClone(message) }));
}

/** The nearest saved revision a chat scratch's parent chain reaches. */
export function chatSavedAncestor(
  scratch: WorkbenchScratchV1,
  records: Pick<LocalChatRecords, "scratch">,
): ConversationRevisionId | undefined {
  let parent = scratch.request.kind === "chat" ? scratch.request.parent : undefined;
  const seen = new Set([scratch.scratchId]);
  while (parent?.kind === "scratch" && !seen.has(parent.scratchId)) {
    seen.add(parent.scratchId);
    const next = records.scratch(parent.scratchId);
    parent = next?.request.kind === "chat" ? next.request.parent : undefined;
  }
  return parent?.kind === "saved-conversation-revision" ? parent.revisionId : undefined;
}

/** The chat switcher's entries (T1). */
export function chatRequestMenu(
  project: ProjectFile,
  selected: SelectedChatRecord,
  records: LocalChatRecords & {
    scratches: readonly WorkbenchScratchV1[];
    draftFor(asset: { kind: "chat-request"; id: ConversationId }): WorkbenchDraftV1 | undefined;
  },
): RequestMenu {
  return requestMenu({
    requests: project.conversations,
    revisions: project.conversationRevisions.map(({ id, conversationId, createdAt }) => ({ id, requestId: conversationId, createdAt })),
    launchRevisionId: project.defaults.conversationRevisionId,
    draftFor(requestId) {
      const draft = records.draftFor({ kind: "chat-request", id: requestId as ConversationId });
      return draft?.asset.kind === "chat-request"
        ? { draftId: draft.draftId, baseRevisionId: (draft as WorkbenchChatRequestDraftV1).base.revisionId }
        : undefined;
    },
    scratches: records.scratches
      .filter((scratch) => scratch.request.kind === "chat" && scratch.projectId === project.projectId)
      .map((scratch) => {
        const ancestor = chatSavedAncestor(scratch, records);
        return {
          scratchId: scratch.scratchId,
          createdAt: scratch.createdAt,
          branched: Boolean(scratch.branchedFrom),
          ...(ancestor ? { savedAncestorRevisionId: ancestor } : {}),
        };
      }),
    selected: selected.kind === "saved"
      ? selected.revision && { kind: "saved", revisionId: selected.revision.id }
      : selected.kind === "draft"
        ? { kind: "draft", draftId: selected.draft.draftId }
        : { kind: "scratch", scratchId: selected.scratch.scratchId },
  });
}
