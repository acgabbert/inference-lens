import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { insertPromptTemplateUse, removePromptTemplateUse } from "../packages/core/src/project.ts";
import type { ProjectConversationItem, ProjectFile } from "../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import type { WorkbenchChatRequestDraftV1, WorkbenchScratchV1 } from "../packages/core/src/personal-workbench.ts";
import type { ConversationId, ConversationRevisionId, MessageId } from "../packages/core/src/run-kernel/types.ts";
import {
  branchScratchParent,
  itemsAfterMutation,
  localInputLabel,
  localRunInput,
  selectedChatRecord,
} from "../app/request/local-chat-request.ts";

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const shared: ProjectFile = plan.shared;
const projectId = shared.projectId;
const launch = shared.conversationRevisions.find(({ id }) => id === shared.defaults.conversationRevisionId)!;
const older = shared.conversationRevisions.find(({ id }) => id !== launch.id)!;
const chatTemplate = shared.promptTemplates.find((template) => template.kind === "chat")!;

function literal(text: string): ProjectConversationItem[] {
  return [{ kind: "message", message: { id: "message_local-1" as MessageId, role: "user", content: [{ type: "text", text }] } }];
}

const draft: WorkbenchChatRequestDraftV1 = {
  schemaVersion: 1, kind: "draft", projectId, draftId: "draft_one",
  asset: { kind: "chat-request", id: launch.conversationId },
  base: { revisionId: launch.id, snapshot: structuredClone(launch) },
  edited: { items: literal("Draft.") },
};
const scratch: WorkbenchScratchV1 = {
  schemaVersion: 1, kind: "scratch", projectId, scratchId: "scratch_one", createdAt: "2026-11-04T15:00:00.000Z",
  localConversationId: "conversation_local-one" as ConversationId,
  request: { kind: "chat", items: literal("Scratch."), parent: { kind: "saved-conversation-revision", revisionId: older.id } },
  branchedFrom: { runId: "run_parent", messageId: "message_local-1" as MessageId },
};
const records = {
  draftById: (id: string) => (id === draft.draftId ? draft : undefined),
  scratch: (id: string) => (id === scratch.scratchId ? scratch : undefined),
};

test("no selection, or one that names nothing here, is the launch default", () => {
  assert.equal(selectedChatRecord(shared, undefined, records).revision?.id, launch.id);
  const missing = selectedChatRecord(shared, { kind: "scratch", scratchId: "scratch_gone" }, records);
  assert.equal(missing.kind, "saved");
  assert.equal(missing.revision?.id, launch.id);
});

test("a selected draft or scratch is what the composer edits", () => {
  const selectedDraft = selectedChatRecord(shared, { kind: "draft", draftId: draft.draftId }, records);
  assert.equal(selectedDraft.kind, "draft");
  assert.deepEqual(selectedDraft.items, literal("Draft."));
  assert.equal(selectedDraft.revision?.id, launch.id);
  const selectedScratch = selectedChatRecord(shared, { kind: "scratch", scratchId: scratch.scratchId }, records);
  assert.equal(selectedScratch.kind, "scratch");
  assert.deepEqual(selectedScratch.items, literal("Scratch."));
});

test("a template-use edit applies to local items without touching the project", () => {
  const items = itemsAfterMutation(shared, literal("Before."), (project, revisionId) => insertPromptTemplateUse(project, {
    conversationRevisionId: revisionId, templateId: chatTemplate.id, itemIndex: 1, idSuffix: "inserted",
  }));
  assert.deepEqual(items[0], literal("Before.")[0]);
  assert.equal(items[1]?.kind, "template-use");
  assert.equal(shared.conversationRevisions.length, 2);
  const removed = itemsAfterMutation(shared, items, (project, revisionId) => removePromptTemplateUse(project, revisionId, "template-use_inserted" as never));
  assert.deepEqual(removed, literal("Before."));
});

test("a draft runs under its saved request with a fresh revision; a scratch under its local conversation", () => {
  const draftRun = localRunInput(selectedChatRecord(shared, { kind: "draft", draftId: draft.draftId }, records), "fresh");
  assert.deepEqual(draftRun.identity, { conversationId: launch.conversationId, conversationRevisionId: "revision_fresh" });
  assert.equal(draftRun.local, true);
  assert.equal(draftRun.branchedFrom, undefined);
  const scratchRun = localRunInput(selectedChatRecord(shared, { kind: "scratch", scratchId: scratch.scratchId }, records), "fresh");
  assert.deepEqual(scratchRun.identity, { conversationId: "conversation_local-one", conversationRevisionId: "revision_fresh" });
  // R3: every run of an unsaved scratch records its branch point.
  assert.deepEqual(scratchRun.branchedFrom, { runId: "run_parent", messageId: "message_local-1", parentConversationRevisionId: older.id });
  const savedRun = localRunInput(selectedChatRecord(shared, undefined, records), "fresh");
  assert.deepEqual(savedRun.identity, { conversationId: launch.conversationId, conversationRevisionId: launch.id });
  assert.equal(savedRun.local, false);
});

test("Y3: a repeated experiment names unsaved input, and nothing for a saved revision", () => {
  const name = shared.conversations.find(({ id }) => id === launch.conversationId)!.name;
  assert.equal(localInputLabel(shared, selectedChatRecord(shared, { kind: "draft", draftId: draft.draftId }, records)), `Unsaved draft of ${name}`);
  assert.equal(localInputLabel(shared, selectedChatRecord(shared, { kind: "scratch", scratchId: scratch.scratchId }, records)), "Unsaved request");
  assert.equal(localInputLabel(shared, selectedChatRecord(shared, undefined, records)), undefined);
  // A draft whose request is gone from the project still says it is unsaved.
  const orphan = { ...draft, asset: { kind: "chat-request" as const, id: "conversation_gone" as ConversationId } };
  const orphanRecords = { ...records, draftById: (id: string) => (id === orphan.draftId ? orphan : undefined) };
  assert.equal(localInputLabel(shared, selectedChatRecord(shared, { kind: "draft", draftId: draft.draftId }, orphanRecords)), "Unsaved draft");
});

test("R2: a branch's parent is the nearest saved ancestor the app knows", () => {
  const scratches = [scratch];
  // A saved revision.
  assert.deepEqual(
    branchScratchParent(shared, scratches, { conversationId: launch.conversationId, conversationRevisionId: launch.id }),
    { kind: "saved-conversation-revision", revisionId: launch.id },
  );
  // A live run of a draft: this tab remembered its base.
  assert.deepEqual(
    branchScratchParent(shared, scratches, { conversationId: launch.conversationId, conversationRevisionId: "revision_fresh" as ConversationRevisionId }, { kind: "saved-conversation-revision", revisionId: launch.id }),
    { kind: "saved-conversation-revision", revisionId: launch.id },
  );
  // A run of a scratch, found by its local conversation.
  assert.deepEqual(
    branchScratchParent(shared, scratches, { conversationId: scratch.localConversationId, conversationRevisionId: "revision_other" as ConversationRevisionId }),
    { kind: "scratch", scratchId: scratch.scratchId },
  );
  // A saved trace of a draft run: unknown, so no parent.
  assert.equal(
    branchScratchParent(shared, scratches, { conversationId: launch.conversationId, conversationRevisionId: "revision_fresh" as ConversationRevisionId }),
    undefined,
  );
});

test("a remembered parent that no longer exists cannot strand a new branch", () => {
  const run = { conversationId: scratch.localConversationId, conversationRevisionId: "revision_local" as ConversationRevisionId };
  assert.equal(branchScratchParent(shared, [], run, { kind: "scratch", scratchId: scratch.scratchId }), undefined);
  assert.equal(branchScratchParent(shared, [], run, { kind: "saved-conversation-revision", revisionId: "revision_deleted" as ConversationRevisionId }), undefined);
});
