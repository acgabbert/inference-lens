"use client";

import { useRef, useState } from "react";
import type {
  ProjectConversationItem,
  ProjectFile,
  TemplateResolutionContext,
} from "../../packages/core/src/project.ts";
import type {
  ConversationId,
  ConversationMessage,
  ConversationRevisionId,
  MessageId,
  RunId,
} from "../../packages/core/src/run-kernel/types.ts";
import { stableJsonValue } from "../../packages/core/src/stable-json.ts";
import type { ChatScratchParent, PersonalWorkbenchHandle } from "../workbench/use-personal-workbench.client.ts";
import {
  branchItems,
  branchScratchParent,
  chatParentItems,
  localRunInput,
  selectedChatRecord,
} from "./local-chat-request.ts";
import type { LocalChatRunInput, SelectedChatRecord } from "./local-chat-request.ts";

export type { LocalChatRunInput, SelectedChatRecord };

/** The run a branch starts from, as the run session or a saved trace knows it. */
export interface ChatBranchSource {
  runId: RunId;
  conversationId?: ConversationId;
  conversationRevisionId?: ConversationRevisionId;
  messageId: MessageId;
}

/**
 * Which record the composer edits in a `personal` session: a clean saved
 * revision, its request draft, or a scratch (I4; docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md,
 * "Step 3 decisions"). Composer edits become a draft or scratch update, Save
 * publishes it, and a branch creates a scratch. `usePendingBranch` keeps only
 * the legacy session's run provenance.
 *
 * Disabled in a legacy session or without a project: every caller then takes
 * today's path.
 */
export interface ChatRequestRecordHandle {
  enabled: boolean;
  /** Undefined while disabled. */
  record: SelectedChatRecord | undefined;
  /** Whether Save will ask for a name: a scratch with no saved ancestor. */
  needsName: boolean;
  saving: boolean;
  /** Records the composer's items as a draft or scratch. False after reporting why not. */
  edit(items: ProjectConversationItem[]): boolean;
  /** Saves the selected draft or scratch. Resolves true once it landed. */
  save(name?: string): Promise<boolean>;
  discard(): Promise<void>;
  /** What the next run resolves; undefined while disabled. */
  runInput(): LocalChatRunInput | undefined;
  /** Remembers where a branch from this live run would hang (R2). */
  noteRun(runId: RunId, input: LocalChatRunInput): void;
  /** Creates and selects a scratch from a run. False after reporting why not. */
  branch(source: ChatBranchSource, messages: ConversationMessage[], context: TemplateResolutionContext): boolean;
  /** Selects a saved revision, as a confirmed import does. */
  selectSaved(revisionId: ConversationRevisionId): void;
}

type PersonalRequestOwner = Pick<
  PersonalWorkbenchHandle,
  | "enabled" | "status" | "chatSelection" | "scratches" | "scratch" | "draftById" | "selectChat"
  | "updateChatRequestDraft" | "createChatScratch" | "updateChatScratch" | "discardChatRequestDraft"
  | "discardScratch" | "publishChatRequestDraft" | "publishScratch"
>;

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

export function useChatRequestRecord(input: {
  personal: PersonalRequestOwner;
  project: ProjectFile | null;
  onError(message: string | undefined): void;
}): ChatRequestRecordHandle {
  const { personal, project, onError } = input;
  const [saving, setSaving] = useState(false);
  const runParentsRef = useRef(new Map<RunId, ChatScratchParent>());
  const enabled = personal.enabled && Boolean(project);
  const record = enabled && project ? selectedChatRecord(project, personal.chatSelection, personal) : undefined;

  let needsName = false;
  if (record?.kind === "scratch") {
    let parent = record.scratch.request.parent;
    const seen = new Set([record.scratch.scratchId]);
    while (parent?.kind === "scratch" && !seen.has(parent.scratchId)) {
      seen.add(parent.scratchId);
      parent = personal.scratch(parent.scratchId)?.request.parent;
    }
    needsName = parent?.kind !== "saved-conversation-revision";
  }

  function ready(): boolean {
    if (personal.status.kind === "ready" || personal.status.kind === "session") return true;
    onError(personal.status.kind === "blocked"
      ? personal.status.message
      : "Your personal workbench is still loading. Try again in a moment.");
    return false;
  }

  return {
    enabled,
    record,
    needsName,
    saving,
    edit(items) {
      if (!record || !ready()) return false;
      switch (record.kind) {
        case "saved": {
          if (!record.revision) {
            onError("The project's launch request no longer exists.");
            return false;
          }
          const draft = personal.updateChatRequestDraft(record.revision, items);
          if (!draft && !same(items, record.revision.items)) {
            onError("An earlier save of this request needs review before it can be edited.");
            return false;
          }
          return true;
        }
        case "draft": {
          const draft = personal.updateChatRequestDraft(record.draft.base.snapshot, items, { draftId: record.draft.draftId });
          if (!draft && !same(items, record.draft.base.snapshot.items)) {
            onError("An earlier save of this request needs review before it can be edited.");
            return false;
          }
          return true;
        }
        case "scratch":
          personal.updateChatScratch(record.scratch.scratchId, items);
          return true;
      }
    },
    async save(name) {
      if (!record || record.kind === "saved" || !ready()) return false;
      setSaving(true);
      try {
        const outcome = record.kind === "draft"
          ? await personal.publishChatRequestDraft(record.draft.asset.id as ConversationId)
          : await personal.publishScratch(record.scratch.scratchId, name);
        if (outcome.kind !== "published") {
          onError(outcome.message);
          return false;
        }
        onError(undefined);
        return true;
      } finally {
        setSaving(false);
      }
    },
    async discard() {
      if (!record || record.kind === "saved") return;
      const outcome = record.kind === "draft"
        ? await personal.discardChatRequestDraft(record.draft.asset.id as ConversationId)
        : await personal.discardScratch(record.scratch.scratchId);
      if (outcome && outcome.kind !== "saved" && outcome.kind !== "deleted") {
        onError("message" in outcome ? outcome.message : "The local request could not be discarded.");
      }
    },
    runInput() {
      return record?.kind === "saved" && !record.revision ? undefined : record && localRunInput(record);
    },
    noteRun(runId, run) {
      if (run.branchParent) runParentsRef.current.set(runId, run.branchParent);
    },
    branch(source, messages, context) {
      if (!project || !ready()) return false;
      const parent = branchScratchParent(project, personal.scratches, source, runParentsRef.current.get(source.runId));
      const items = branchItems(project, chatParentItems(project, personal.scratches, parent), messages, context);
      try {
        const scratch = personal.createChatScratch(items, {
          ...(parent ? { parent } : {}),
          branchedFrom: { runId: source.runId, messageId: source.messageId },
        });
        if (!scratch) return false;
      } catch (error) {
        onError(error instanceof Error ? error.message : "Could not start the branch.");
        return false;
      }
      onError(undefined);
      return true;
    },
    selectSaved(revisionId) {
      personal.selectChat({ kind: "saved-conversation-revision", revisionId });
    },
  };
}
