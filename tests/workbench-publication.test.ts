import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseProjectFile, ProjectValidationError } from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { parseWorkbenchRecord } from "../packages/core/src/personal-workbench.ts";
import type {
  WorkbenchChatRequestDraftV1,
  WorkbenchDecisionRequestDraftV1,
  WorkbenchDraftV1,
  WorkbenchPromptDraftV1,
  WorkbenchScratchV1,
} from "../packages/core/src/personal-workbench.ts";
import {
  clearPublication,
  completePublication,
  publishChatRequestDraft,
  publishDecisionRequestDraft,
  publishPromptDraft,
  publishScratch,
  reconcilePublication,
} from "../packages/core/src/workbench-publication.ts";

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
// I1: owners keep ProjectFile; a personal session's document carries no template draft.
const project: ProjectFile = parseProjectFile({ ...plan.shared, schemaVersion: 18 });
const projectId = project.projectId;
const createdAt = "2026-10-31T13:00:00.000Z";
const chatPromptDraft = plan.drafts.find(draft => draft.asset.kind === "chat-prompt")!;
const decisionPromptDraft = plan.drafts.find(draft => draft.asset.kind === "decision-prompt")!;
const chatChild = project.conversationRevisions.find(({ id }) => id === "revision_chat-2")!;
const useRevision = project.decisionRequestRevisions.find(({ id }) => id === "decision-revision_use")!;
const inlineRevision = project.decisionRequestRevisions.find(({ id }) => id === "decision-revision_inline")!;
assert.ok(chatPromptDraft && decisionPromptDraft && chatChild && useRevision && inlineRevision?.kind === "inline");

type ChatItem = WorkbenchChatRequestDraftV1["edited"]["items"][number];
type LiteralMessage = Extract<ChatItem, { kind: "message" }>["message"];
const literalItem = (message: Partial<LiteralMessage> = {}): ChatItem => ({
  kind: "message",
  message: { id: "message_local", role: "user", content: [{ type: "text", text: "Try latency instead." }], ...message } as LiteralMessage,
});
const literalItems = [literalItem()];

const chatRequestDraft = parseWorkbenchRecord({
  schemaVersion: 1, kind: "draft", projectId, draftId: "draft_chat-request",
  asset: { kind: "chat-request", id: "conversation_example" },
  base: { revisionId: chatChild.id, snapshot: chatChild },
  edited: { items: literalItems },
}) as WorkbenchChatRequestDraftV1;

const decisionRequestDraft = parseWorkbenchRecord({
  schemaVersion: 1, kind: "draft", projectId, draftId: "draft_decision-request",
  asset: { kind: "decision-request", id: "decision-request_example" },
  base: { revisionId: useRevision.id, snapshot: useRevision },
  edited: { kind: "template-use", templateId: "template_decision", templateRevisionId: "template-revision_decision-1", overrides: { ticket: "latency" } },
}) as WorkbenchDecisionRequestDraftV1;

function scratch(scratchId: string, request: WorkbenchScratchV1["request"]): WorkbenchScratchV1 {
  return parseWorkbenchRecord({
    schemaVersion: 1, kind: "scratch", projectId, scratchId, createdAt,
    localConversationId: `conversation_local-${scratchId}`, request,
  }) as WorkbenchScratchV1;
}

/** What the owner writes and reads back before the shared write (protocol step 1). */
function withIntent<R extends WorkbenchDraftV1 | WorkbenchScratchV1>(record: R, intent: unknown): R {
  return parseWorkbenchRecord({ ...record, publishing: intent }) as R;
}

function refusal(message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ProjectValidationError, String(error));
    assert.match(error.message, message);
    return true;
  };
}

test("a prompt draft publishes as the template's new current revision and freezes its content", () => {
  const result = publishPromptDraft(project, chatPromptDraft, { idSuffix: "published", createdAt });
  assert.equal(result.kind, "publish");
  if (result.kind !== "publish") return;
  assert.deepEqual(result.intent, {
    revisionId: "template-revision_published",
    parentRevisionId: chatPromptDraft.base.revisionId,
    content: chatPromptDraft.edited,
  });
  const template = result.project.promptTemplates.find(({ id }) => id === "template_chat")!;
  assert.equal(template.currentRevisionId, "template-revision_published");
  assert.deepEqual(template.revisions.at(-1), {
    id: "template-revision_published", createdAt, name: "More detail",
    messages: [{ role: "user", content: "Explain {{topic}} with examples." }],
    variableDefaults: { topic: "draft-only topic" },
  });
  assert.equal(template.draft, undefined);
  // Pins, launch defaults and other assets stay put.
  assert.deepEqual(result.project.defaults, project.defaults);
  assert.deepEqual(result.project.conversationRevisions, project.conversationRevisions);
  // The intent is a valid record field, and the input record is untouched.
  assert.equal(withIntent(chatPromptDraft, result.intent).publishing?.revisionId, "template-revision_published");
  assert.equal(chatPromptDraft.publishing, undefined);
});

test("a decision prompt draft publishes the same way", () => {
  const result = publishPromptDraft(project, decisionPromptDraft, { idSuffix: "published", createdAt });
  assert.equal(result.kind, "publish");
  if (result.kind !== "publish") return;
  const template = result.project.promptTemplates.find(({ id }) => id === "template_decision")!;
  assert.equal(template.kind, "decision");
  assert.equal(template.currentRevisionId, "template-revision_published");
  assert.equal(reconcilePublication(result.project, withIntent(decisionPromptDraft, result.intent)), "published");
});

test("a draft whose content equals its base is unchanged and writes nothing", () => {
  const base = project.promptTemplates.find(({ id }) => id === "template_chat")!.revisions[0]!;
  assert.ok("messages" in base);
  const clean = { ...chatPromptDraft, edited: { messages: base.messages, variableDefaults: base.variableDefaults } } as WorkbenchPromptDraftV1;
  assert.deepEqual(publishPromptDraft(project, clean), { kind: "unchanged" });
  const sameItems = { ...chatRequestDraft, edited: { items: chatChild.items } };
  assert.deepEqual(publishChatRequestDraft(project, sameItems), { kind: "unchanged" });
  assert.ok(useRevision.kind === "template-use");
  const sameDecision = { ...decisionRequestDraft, edited: { kind: "template-use", templateId: useRevision.templateId, templateRevisionId: useRevision.templateRevisionId, overrides: useRevision.overrides } } as WorkbenchDecisionRequestDraftV1;
  assert.deepEqual(publishDecisionRequestDraft(project, sameDecision), { kind: "unchanged" });
});

test("a request draft appends a child of its base and moves no launch default", () => {
  const chat = publishChatRequestDraft(project, chatRequestDraft, { idSuffix: "published", createdAt });
  assert.equal(chat.kind, "publish");
  if (chat.kind !== "publish") return;
  assert.deepEqual(chat.project.conversationRevisions.at(-1), {
    id: "revision_published", conversationId: "conversation_example", parentRevisionId: chatChild.id, items: literalItems, createdAt,
  });
  assert.equal(chat.project.defaults.conversationRevisionId, project.defaults.conversationRevisionId);
  assert.deepEqual(chat.intent, { revisionId: "revision_published", parentRevisionId: chatChild.id, content: { items: literalItems } });

  const decision = publishDecisionRequestDraft(project, decisionRequestDraft, { idSuffix: "published", createdAt });
  assert.equal(decision.kind, "publish");
  if (decision.kind !== "publish") return;
  assert.deepEqual(decision.project.decisionRequestRevisions.at(-1), {
    id: "decision-revision_published", decisionRequestId: "decision-request_example", parentRevisionId: useRevision.id, createdAt,
    kind: "template-use", templateId: "template_decision", templateRevisionId: "template-revision_decision-1", overrides: { ticket: "latency" },
  });
  assert.equal(decision.project.defaults.decisionRequestRevisionId, project.defaults.decisionRequestRevisionId);

  // A local detach publishes the inline arm under the same request.
  const detached = publishDecisionRequestDraft(project, {
    ...decisionRequestDraft, edited: { kind: "inline", decision: inlineRevision.decision, values: { ticket: "" } },
  } as WorkbenchDecisionRequestDraftV1, { idSuffix: "detached", createdAt });
  assert.equal(detached.kind === "publish" && detached.project.decisionRequestRevisions.at(-1)?.kind, "inline");
});

test("publication refuses orphaned bases, pending intents, foreign records and invalid pins", () => {
  const orphan = { ...chatRequestDraft, base: { revisionId: "revision_gone", snapshot: { ...chatChild, id: "revision_gone" } } } as WorkbenchChatRequestDraftV1;
  assert.throws(() => publishChatRequestDraft(project, orphan), refusal(/base revision no longer exists/));
  const foreignBase = { ...decisionRequestDraft, asset: { kind: "decision-request", id: "decision-request_other" } } as WorkbenchDecisionRequestDraftV1;
  assert.throws(() => publishDecisionRequestDraft(project, foreignBase), refusal(/base revision no longer exists/));
  const missingTemplate = { ...chatPromptDraft, asset: { kind: "chat-prompt", id: "template_gone" } } as WorkbenchPromptDraftV1;
  assert.throws(() => publishPromptDraft(project, missingTemplate), refusal(/template no longer exists/));
  const wrongKind = { ...chatPromptDraft, asset: { kind: "chat-prompt", id: "template_decision" } } as WorkbenchPromptDraftV1;
  assert.throws(() => publishPromptDraft(project, wrongKind), refusal(/template no longer exists/));

  const pending = withIntent(chatRequestDraft, { revisionId: "revision_pending", parentRevisionId: chatChild.id, content: { items: literalItems } });
  assert.throws(() => publishChatRequestDraft(project, pending), refusal(/pending publication/));
  assert.throws(() => publishChatRequestDraft(project, { ...chatRequestDraft, projectId: "project_other" }), refusal(/different project/));

  const missingPin = { ...decisionRequestDraft, edited: { ...decisionRequestDraft.edited, templateRevisionId: "template-revision_gone" } } as WorkbenchDecisionRequestDraftV1;
  assert.throws(() => publishDecisionRequestDraft(project, missingPin), ProjectValidationError);
});

test("reconciliation compares frozen content, never an ID alone", () => {
  const result = publishChatRequestDraft(project, chatRequestDraft, { idSuffix: "published", createdAt });
  assert.ok(result.kind === "publish");
  const record = withIntent(chatRequestDraft, result.intent);
  assert.equal(reconcilePublication(result.project, record), "published");
  // The shared write never landed.
  assert.equal(reconcilePublication(project, record), "not-published");

  const replaced = (change: Partial<ProjectFile["conversationRevisions"][number]>) => parseProjectFile({
    ...result.project,
    conversationRevisions: result.project.conversationRevisions.map(revision => revision.id === "revision_published" ? { ...revision, ...change } : revision),
  });
  const otherItems = [literalItem({ content: [{ type: "text", text: "Someone else's." }] })];
  assert.equal(reconcilePublication(replaced({ items: otherItems }), record), "conflict");
  assert.equal(reconcilePublication(replaced({ parentRevisionId: "revision_chat-1" }), record), "conflict");

  // A template revision with the intended ID in another template is a conflict.
  const prompt = publishPromptDraft(project, chatPromptDraft, { idSuffix: "published", createdAt });
  assert.ok(prompt.kind === "publish");
  const promptRecord = withIntent(chatPromptDraft, prompt.intent);
  assert.equal(reconcilePublication(prompt.project, promptRecord), "published");
  assert.equal(reconcilePublication(project, promptRecord), "not-published");
  const elsewhere = publishPromptDraft(project, decisionPromptDraft, { idSuffix: "published", createdAt });
  assert.ok(elsewhere.kind === "publish");
  assert.equal(reconcilePublication(elsewhere.project, promptRecord), "conflict");
  // A later rename of the published revision is a label change, not new content.
  const renamed = parseProjectFile({
    ...prompt.project,
    promptTemplates: prompt.project.promptTemplates.map(template => template.id !== "template_chat" ? template : {
      ...template, revisions: template.revisions.map(revision => revision.id === "template-revision_published" ? { ...revision, name: "Renamed" } : revision),
    }),
  });
  assert.equal(reconcilePublication(renamed, promptRecord), "published");

  assert.throws(() => reconcilePublication(project, chatRequestDraft), refusal(/no pending publication/));
});

test("completing a publication deletes a settled record or keeps later edits on the new base", () => {
  const result = publishChatRequestDraft(project, chatRequestDraft, { idSuffix: "published", createdAt });
  assert.ok(result.kind === "publish");
  const record = withIntent(chatRequestDraft, result.intent);
  assert.equal(completePublication(result.project, record), undefined);

  const laterItems = [literalItem({ id: "message_later" })];
  const edited = withIntent({ ...chatRequestDraft, edited: { items: laterItems } } as WorkbenchChatRequestDraftV1, result.intent);
  const kept = completePublication(result.project, edited) as WorkbenchChatRequestDraftV1;
  assert.equal(kept.publishing, undefined);
  assert.equal(kept.base.revisionId, "revision_published");
  assert.deepEqual(kept.base.snapshot, result.project.conversationRevisions.at(-1));
  assert.deepEqual(kept.edited.items, laterItems);

  const prompt = publishPromptDraft(project, chatPromptDraft, { idSuffix: "published", createdAt });
  assert.ok(prompt.kind === "publish");
  const renamedWhileSaving = withIntent({ ...chatPromptDraft, edited: { ...chatPromptDraft.edited, revisionName: "Later" } } as WorkbenchPromptDraftV1, prompt.intent);
  const keptPrompt = completePublication(prompt.project, renamedWhileSaving) as WorkbenchPromptDraftV1;
  assert.equal(keptPrompt.base.revisionId, "template-revision_published");
  assert.equal(keptPrompt.base.snapshot.name, "More detail");

  // Completion requires the shared write to have landed.
  assert.throws(() => completePublication(project, record), refusal(/has not landed/));
  // Failure or a refused write keeps the draft and drops the intent.
  assert.deepEqual(clearPublication(record), chatRequestDraft);
});

test("a scratch with a local parent chain publishes as one child of its nearest saved ancestor", () => {
  const root = scratch("scratch_root", { kind: "chat", items: literalItems, parent: { kind: "saved-conversation-revision", revisionId: chatChild.id } });
  const middle = scratch("scratch_middle", { kind: "chat", items: literalItems, parent: { kind: "scratch", scratchId: "scratch_root" } });
  const leafItems = [literalItem({ id: "message_leaf" })];
  const leaf = scratch("scratch_leaf", { kind: "chat", items: leafItems, parent: { kind: "scratch", scratchId: "scratch_middle" } });

  const result = publishScratch(project, leaf, { scratches: [root, middle, leaf], name: "Ignored with a saved ancestor", idSuffix: "published", createdAt });
  assert.deepEqual(result.intent, {
    conversationId: "conversation_example", revisionId: "revision_published", parentRevisionId: chatChild.id, content: { items: leafItems },
  });
  assert.deepEqual(result.project.conversations, project.conversations);
  assert.deepEqual(result.project.conversationRevisions.at(-1), {
    id: "revision_published", conversationId: "conversation_example", parentRevisionId: chatChild.id, items: leafItems, createdAt,
  });
  assert.equal(result.project.defaults.conversationRevisionId, project.defaults.conversationRevisionId);
  // The scratch's local conversation never reaches the shared document.
  assert.doesNotMatch(JSON.stringify(result.project), /conversation_local-/);

  const record = withIntent(leaf, result.intent);
  assert.equal(reconcilePublication(result.project, record), "published");
  assert.equal(reconcilePublication(project, record), "not-published");
  assert.equal(completePublication(result.project, record), undefined);
  // Edits made while saving stay local, now parented on the published revision.
  const later = withIntent({ ...leaf, request: { ...leaf.request, items: literalItems } } as WorkbenchScratchV1, result.intent);
  assert.deepEqual(completePublication(result.project, later), {
    ...leaf, request: { ...leaf.request, items: literalItems, parent: { kind: "saved-conversation-revision", revisionId: "revision_published" } },
  });
});

test("a scratch with no saved ancestor creates a named request", () => {
  const fresh = scratch("scratch_fresh", { kind: "chat", items: literalItems });
  assert.throws(() => publishScratch(project, fresh, { scratches: [fresh] }), refusal(/needs a name/));
  assert.throws(() => publishScratch(project, fresh, { scratches: [fresh], name: "  " }), refusal(/needs a name/));
  const chat = publishScratch(project, fresh, { scratches: [fresh], name: " Latency ", idSuffix: "fresh", createdAt });
  assert.deepEqual(chat.intent, { conversationId: "conversation_fresh", name: "Latency", revisionId: "revision_fresh", content: { items: literalItems } });
  assert.deepEqual(chat.project.conversations.at(-1), { id: "conversation_fresh", name: "Latency" });
  assert.deepEqual(chat.project.conversationRevisions.at(-1), { id: "revision_fresh", conversationId: "conversation_fresh", items: literalItems, createdAt });
  assert.equal(reconcilePublication(chat.project, withIntent(fresh, chat.intent)), "published");

  const content = { kind: "inline" as const, decision: inlineRevision.decision, values: { ticket: "late" } };
  const decisionRoot = scratch("scratch_decision-root", { kind: "decision", content });
  const decisionChild = scratch("scratch_decision-child", { kind: "decision", content, parent: { kind: "scratch", scratchId: "scratch_decision-root" } });
  const decision = publishScratch(project, decisionChild, { scratches: [decisionRoot], name: "Routing", idSuffix: "fresh", createdAt });
  assert.deepEqual(decision.intent, { decisionRequestId: "decision-request_fresh", name: "Routing", revisionId: "decision-revision_fresh", content });
  assert.deepEqual(decision.project.decisionRequests.at(-1), { id: "decision-request_fresh", name: "Routing" });
  assert.deepEqual(decision.project.decisionRequestRevisions.at(-1), { ...content, id: "decision-revision_fresh", decisionRequestId: "decision-request_fresh", createdAt });
  assert.equal(decision.project.defaults.decisionRequestRevisionId, project.defaults.decisionRequestRevisionId);
  assert.equal(reconcilePublication(decision.project, withIntent(decisionChild, decision.intent)), "published");
});

test("a scratch refuses a parent chain it cannot follow to a saved ancestor or a root", () => {
  const orphan = scratch("scratch_orphan", { kind: "chat", items: literalItems, parent: { kind: "scratch", scratchId: "scratch_missing" } });
  assert.throws(() => publishScratch(project, orphan, { scratches: [], name: "New" }), refusal(/parent scratch is missing/));
  const first = scratch("scratch_first", { kind: "chat", items: literalItems, parent: { kind: "scratch", scratchId: "scratch_second" } });
  const second = scratch("scratch_second", { kind: "chat", items: literalItems, parent: { kind: "scratch", scratchId: "scratch_first" } });
  assert.throws(() => publishScratch(project, first, { scratches: [first, second], name: "New" }), refusal(/loops/));
  const decisionParent = scratch("scratch_decision", { kind: "decision", content: decisionRequestDraft.edited });
  const crossed = scratch("scratch_crossed", { kind: "chat", items: literalItems, parent: { kind: "scratch", scratchId: "scratch_decision" } });
  assert.throws(() => publishScratch(project, crossed, { scratches: [decisionParent], name: "New" }), refusal(/different kind/));
  const goneAncestor = scratch("scratch_gone", { kind: "chat", items: literalItems, parent: { kind: "saved-conversation-revision", revisionId: "revision_gone" } });
  assert.throws(() => publishScratch(project, goneAncestor, { scratches: [] }), refusal(/saved ancestor no longer exists/));
  const pending = withIntent(scratch("scratch_pending", { kind: "chat", items: literalItems }), { conversationId: "conversation_p", name: "P", revisionId: "revision_p", content: { items: literalItems } });
  assert.throws(() => publishScratch(project, pending, { scratches: [], name: "New" }), refusal(/pending publication/));
});
