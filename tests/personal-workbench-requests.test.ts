import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { parseProjectFile } from "../packages/core/src/project.ts";
import type { ProjectConversationItem, ProjectFile } from "../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { parseWorkbenchRecordJson, serializeWorkbenchRecord } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchChatRequestDraftV1, WorkbenchScratchV1, WorkbenchSelectionsV1 } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchStorage, WorkbenchMutationResult } from "../packages/core/src/workbench-store.ts";
import { publishScratch } from "../packages/core/src/workbench-publication.ts";
import { PersonalWorkbenchController } from "../app/workbench/personal-workbench-controller.ts";
import type { SharedWriteOutcome } from "../app/use-project-workspace.client.ts";
import type { ConversationId, MessageId } from "../packages/core/src/run-kernel/types.ts";

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const shared: ProjectFile = parseProjectFile({ ...plan.shared, schemaVersion: 18 });
const projectId = shared.projectId;
const launch = shared.conversationRevisions.find(({ id }) => id === shared.defaults.conversationRevisionId)!;
const conversationId = launch.conversationId;

function literal(text: string, id = "message_local-1"): ProjectConversationItem[] {
  return [{ kind: "message", message: { id: id as MessageId, role: "user", content: [{ type: "text", text }] } }];
}

class MemoryStorage implements WorkbenchStorage {
  files = new Map<string, string>();
  writes: string[] = [];
  async list() {
    return [...this.files].map(([path, contents]) => ({ path, contents }));
  }
  async mutate(path: string, expected: string | null, contents: string | null): Promise<WorkbenchMutationResult> {
    const actual = this.files.get(path) ?? null;
    if (actual !== expected) return { kind: "conflict", phase: "before-write", actualContents: actual };
    if (contents === null) this.files.delete(path);
    else this.files.set(path, contents);
    this.writes.push(`${contents === null ? "delete" : "write"} ${path}`);
    return { kind: "written" };
  }
}

function controller(storage: WorkbenchStorage | null) {
  let ids = 0;
  return new PersonalWorkbenchController({
    projectId, storage, seeds: [], onChange() {},
    setTimer: () => 0, clearTimer() {},
    newDraftId: () => `draft_test-${++ids}`,
    newScratchId: () => `scratch_test-${++ids}`,
    newLocalConversationId: () => `conversation_local-${++ids}` as ConversationId,
    now: () => "2026-11-04T15:00:00.000Z",
  });
}

function sharedWriter(initial: ProjectFile) {
  const state = { document: initial, calls: 0 };
  return {
    state,
    async write(update: (current: ProjectFile) => ProjectFile): Promise<SharedWriteOutcome> {
      state.calls += 1;
      state.document = update(state.document);
      return { kind: "confirmed", project: state.document };
    },
  };
}

function storedSelections(storage: MemoryStorage): WorkbenchSelectionsV1 | undefined {
  const contents = storage.files.get("selections.json");
  return contents ? parseWorkbenchRecordJson(contents, projectId) as WorkbenchSelectionsV1 : undefined;
}

test("editing a saved revision makes a request draft and selects it", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  assert.equal(instance.chatSelection, undefined);
  const draft = instance.updateChatRequestDraft(launch, literal("Edited."));
  assert.equal(draft?.asset.id, conversationId);
  assert.deepEqual(instance.chatSelection, { kind: "draft", draftId: draft!.draftId });
  await instance.flush();
  const stored = parseWorkbenchRecordJson(storage.files.get(`drafts/${draft!.draftId}.json`)!, projectId) as WorkbenchChatRequestDraftV1;
  assert.deepEqual(stored.edited.items, literal("Edited."));
  assert.equal(stored.base.revisionId, launch.id);
  assert.deepEqual(storedSelections(storage)?.chat?.selectedInput, { kind: "draft", draftId: draft!.draftId });
});

test("an edit back to the base items drops the draft and selects the saved revision", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  const draft = instance.updateChatRequestDraft(launch, literal("Edited."))!;
  instance.updateChatRequestDraft(launch, structuredClone(launch.items), { draftId: draft.draftId });
  assert.equal(instance.draftFor({ kind: "chat-request", id: conversationId }), undefined);
  assert.deepEqual(instance.chatSelection, { kind: "saved-conversation-revision", revisionId: launch.id });
});

test("saving a request draft appends a child revision and moves only the personal selection", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  instance.updateChatRequestDraft(launch, literal("Saved text."));
  const writer = sharedWriter(shared);
  const outcome = await instance.publishChatRequestDraft(conversationId, shared, (update) => writer.write(update));
  assert.equal(outcome.kind, "published");
  const revision = writer.state.document.conversationRevisions.at(-1)!;
  assert.ok(outcome.kind === "published" && outcome.revisionId === revision.id);
  assert.equal(revision.parentRevisionId, launch.id);
  assert.deepEqual(revision.items, literal("Saved text."));
  assert.equal(writer.state.document.defaults.conversationRevisionId, launch.id);
  assert.equal(instance.draftFor({ kind: "chat-request", id: conversationId }), undefined);
  assert.deepEqual(instance.chatSelection, { kind: "saved-conversation-revision", revisionId: revision.id });
  await instance.flush();
  assert.equal([...storage.files.keys()].filter((path) => path.startsWith("drafts/")).length, 0);
});

test("a draft for the same request that is not the one being edited is kept as a scratch", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  const first = instance.updateChatRequestDraft(launch, literal("First draft."))!;
  // The composer edits the saved revision again, not the existing draft.
  const second = instance.updateChatRequestDraft(launch, literal("Second draft."))!;
  assert.notEqual(second.draftId, first.draftId);
  const kept = instance.scratches.find((scratch) => scratch.request.kind === "chat"
    && isDeepStrictEqual(scratch.request.items, literal("First draft.")));
  assert.ok(kept);
  assert.deepEqual(kept.request.kind === "chat" && kept.request.parent, { kind: "saved-conversation-revision", revisionId: launch.id });
});

test("a branch scratch is selected, edited, and discarded back to its parent", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  const scratch = instance.createChatScratch(literal("Branch."), {
    parent: { kind: "saved-conversation-revision", revisionId: launch.id },
    branchedFrom: { runId: "run_parent", messageId: "message_local-1" as MessageId },
  });
  assert.deepEqual(instance.chatSelection, { kind: "scratch", scratchId: scratch.scratchId });
  instance.updateChatScratch(scratch.scratchId, literal("Branch, edited."));
  await instance.flush();
  const stored = parseWorkbenchRecordJson(storage.files.get(`scratch/${scratch.scratchId}.json`)!, projectId) as WorkbenchScratchV1;
  assert.deepEqual(stored.request.kind === "chat" && stored.request.items, literal("Branch, edited."));
  assert.deepEqual(stored.branchedFrom, { runId: "run_parent", messageId: "message_local-1" });
  await instance.discardScratch(scratch.scratchId);
  assert.equal(instance.scratch(scratch.scratchId), undefined);
  assert.deepEqual(instance.chatSelection, { kind: "saved-conversation-revision", revisionId: launch.id });
  assert.equal(storage.files.has(`scratch/${scratch.scratchId}.json`), false);
});

test("discarding a parentless scratch returns to the launch default", async () => {
  const instance = controller(new MemoryStorage());
  await instance.open(shared);
  const scratch = instance.createChatScratch(literal("Loose."), {});
  await instance.discardScratch(scratch.scratchId);
  assert.equal(instance.chatSelection, undefined);
});

test("saving a scratch with a saved ancestor publishes a child in that request", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  const scratch = instance.createChatScratch(literal("Branch."), { parent: { kind: "saved-conversation-revision", revisionId: launch.id } });
  const writer = sharedWriter(shared);
  const outcome = await instance.publishScratch(scratch.scratchId, shared, (update) => writer.write(update));
  assert.equal(outcome.kind, "published");
  const revision = writer.state.document.conversationRevisions.at(-1)!;
  assert.equal(revision.conversationId, conversationId);
  assert.equal(revision.parentRevisionId, launch.id);
  assert.equal(writer.state.document.conversations.length, shared.conversations.length);
  assert.equal(instance.scratch(scratch.scratchId), undefined);
  assert.deepEqual(instance.chatSelection, { kind: "saved-conversation-revision", revisionId: revision.id });
});

test("saving a parentless scratch needs a name and creates a request", async () => {
  const instance = controller(new MemoryStorage());
  await instance.open(shared);
  const scratch = instance.createChatScratch(literal("New."), {});
  const writer = sharedWriter(shared);
  const unnamed = await instance.publishScratch(scratch.scratchId, shared, (update) => writer.write(update));
  assert.equal(unnamed.kind, "failed");
  assert.equal(writer.state.calls, 0);
  const outcome = await instance.publishScratch(scratch.scratchId, shared, (update) => writer.write(update), "Fresh request");
  assert.equal(outcome.kind, "published");
  assert.equal(writer.state.document.conversations.at(-1)!.name, "Fresh request");
  assert.equal(writer.state.document.defaults.conversationRevisionId, launch.id);
});

test("saving a scratch reparents its local children on the saved revision before it is cleared", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  const parent = instance.createChatScratch(literal("Parent."), {});
  const child = instance.createChatScratch(literal("Child."), { parent: { kind: "scratch", scratchId: parent.scratchId } });
  await instance.flush();
  storage.writes = [];
  const writer = sharedWriter(shared);
  const outcome = await instance.publishScratch(parent.scratchId, shared, (update) => writer.write(update), "Parent request");
  assert.ok(outcome.kind === "published");
  const rewritten = instance.scratch(child.scratchId)!;
  assert.deepEqual(rewritten.request.parent, { kind: "saved-conversation-revision", revisionId: outcome.revisionId });
  const childWrite = storage.writes.indexOf(`write scratch/${child.scratchId}.json`);
  const parentDelete = storage.writes.indexOf(`delete scratch/${parent.scratchId}.json`);
  assert.ok(childWrite >= 0 && parentDelete > childWrite, storage.writes.join(", "));
});

test("opening settles an interrupted scratch publication that landed", async () => {
  const storage = new MemoryStorage();
  const scratch: WorkbenchScratchV1 = {
    schemaVersion: 1, kind: "scratch", projectId, scratchId: "scratch_landed", createdAt: "2026-11-04T15:00:00.000Z",
    localConversationId: "conversation_local-landed" as ConversationId,
    request: { kind: "chat", items: literal("Landed."), parent: { kind: "saved-conversation-revision", revisionId: launch.id } },
  };
  const published = publishScratch(shared, scratch, { scratches: [], idSuffix: "landed", createdAt: "2026-11-04T15:00:00.000Z" });
  storage.files.set("scratch/scratch_landed.json", serializeWorkbenchRecord({ ...scratch, publishing: published.intent }));
  const instance = controller(storage);
  await instance.open(published.project);
  assert.equal(instance.scratch("scratch_landed"), undefined);
  assert.equal(storage.files.has("scratch/scratch_landed.json"), false);
  assert.deepEqual(instance.recovery, []);
});
