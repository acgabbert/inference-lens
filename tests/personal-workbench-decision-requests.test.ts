import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseProjectFile } from "../packages/core/src/project.ts";
import type { ProjectDecisionRequestRevision, ProjectFile } from "../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { parseWorkbenchRecordJson } from "../packages/core/src/personal-workbench.ts";
import type {
  WorkbenchDecisionRequestContent,
  WorkbenchDecisionRequestDraftV1,
  WorkbenchScratchV1,
  WorkbenchSelectionsV1,
} from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchStorage, WorkbenchMutationResult, WorkbenchRemovalResult } from "../packages/core/src/workbench-store.ts";
import { PersonalWorkbenchController } from "../app/workbench/personal-workbench-controller.ts";
import type { SharedWriteOutcome } from "../app/use-project-workspace.client.ts";
import type { ConversationId, DecisionRequestId, DecisionRequestRevisionId } from "../packages/core/src/run-kernel/types.ts";

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const shared: ProjectFile = parseProjectFile({ ...plan.shared, schemaVersion: 18 });
const projectId = shared.projectId;
const inline = shared.decisionRequestRevisions.find(({ id }) => id === "decision-revision_inline") as Extract<ProjectDecisionRequestRevision, { kind: "inline" }>;
const use = shared.decisionRequestRevisions.find(({ id }) => id === "decision-revision_use") as Extract<ProjectDecisionRequestRevision, { kind: "template-use" }>;
const decisionRequestId = inline.decisionRequestId as DecisionRequestId;

function inlineContent(ticket: string): WorkbenchDecisionRequestContent {
  return { kind: "inline", decision: structuredClone(inline.decision), values: { ...inline.values, ticket } };
}

const baseContent: WorkbenchDecisionRequestContent = { kind: "inline", decision: structuredClone(inline.decision), values: { ...inline.values } };

class MemoryStorage implements WorkbenchStorage {
  files = new Map<string, string>();
  writes: string[] = [];
  async list() {
    return [...this.files].map(([path, contents]) => ({ path, contents }));
  }
  async removeMigrationOperation(): Promise<WorkbenchRemovalResult> {
    return { kind: "blocked", reason: "not-removable", message: "No migration backups here." };
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

test("editing a saved decision revision makes a request draft and selects it", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  assert.equal(instance.decisionSelection, undefined);
  const draft = instance.updateDecisionRequestDraft(inline, inlineContent("Edited ticket"));
  assert.equal(draft?.asset.id, decisionRequestId);
  assert.deepEqual(instance.decisionSelection, { kind: "draft", draftId: draft!.draftId });
  await instance.flush();
  const stored = parseWorkbenchRecordJson(storage.files.get(`drafts/${draft!.draftId}.json`)!, projectId) as WorkbenchDecisionRequestDraftV1;
  assert.deepEqual(stored.edited, inlineContent("Edited ticket"));
  assert.equal(stored.base.revisionId, inline.id);
  assert.deepEqual(storedSelections(storage)?.decision?.selectedInput, { kind: "draft", draftId: draft!.draftId });
});

test("the chat and decision selections are kept apart", async () => {
  const instance = controller(new MemoryStorage());
  await instance.open(shared);
  const chatRevision = shared.defaults.conversationRevisionId!;
  instance.selectChat({ kind: "saved-conversation-revision", revisionId: chatRevision });
  instance.selectDecision({ kind: "saved-decision-request-revision", revisionId: inline.id });
  assert.deepEqual(instance.chatSelection, { kind: "saved-conversation-revision", revisionId: chatRevision });
  instance.selectChat(undefined);
  assert.deepEqual(instance.decisionSelection, { kind: "saved-decision-request-revision", revisionId: inline.id });
  instance.selectDecision(undefined);
  assert.equal(instance.decisionSelection, undefined);
});

test("an edit back to the base content drops the decision draft and selects the saved revision", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  const draft = instance.updateDecisionRequestDraft(inline, inlineContent("Edited"))!;
  await instance.flush();
  const again = instance.updateDecisionRequestDraft(inline, baseContent, { draftId: draft.draftId });
  assert.equal(again, undefined);
  assert.deepEqual(instance.decisionSelection, { kind: "saved-decision-request-revision", revisionId: inline.id });
  await instance.flush();
  assert.equal(storage.files.has(`drafts/${draft.draftId}.json`), false);
});

test("a competing decision draft is kept as a scratch parented on its base", async () => {
  const instance = controller(new MemoryStorage());
  await instance.open(shared);
  const first = instance.updateDecisionRequestDraft(inline, inlineContent("First"))!;
  // The composer now edits another revision of the same request.
  const second = instance.updateDecisionRequestDraft(use, { kind: "template-use", templateId: use.templateId, templateRevisionId: use.templateRevisionId, overrides: { ticket: "Second" } })!;
  assert.notEqual(second.draftId, first.draftId);
  assert.equal(instance.draftById(first.draftId), undefined);
  const kept = instance.scratches.find(({ request }) => request.kind === "decision")!;
  assert.deepEqual(kept.request, { kind: "decision", content: inlineContent("First"), parent: { kind: "saved-decision-request-revision", revisionId: inline.id } });
  assert.deepEqual(instance.decisionSelection, { kind: "draft", draftId: second.draftId });
});

test("saving a decision draft appends a child revision, selects it and leaves the launch default", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  const draft = instance.updateDecisionRequestDraft(inline, inlineContent("Saved ticket"))!;
  const writer = sharedWriter(shared);
  const outcome = await instance.publishDecisionRequestDraft(decisionRequestId, shared, writer.write);
  assert.equal(outcome.kind, "published");
  assert.equal(writer.state.calls, 1);
  const published = writer.state.document.decisionRequestRevisions.find(({ id }) => id === (outcome as { revisionId: string }).revisionId)!;
  assert.equal(published.parentRevisionId, inline.id);
  assert.equal(published.decisionRequestId, decisionRequestId);
  assert.equal(writer.state.document.defaults.decisionRequestRevisionId, shared.defaults.decisionRequestRevisionId);
  assert.deepEqual(instance.decisionSelection, { kind: "saved-decision-request-revision", revisionId: published.id });
  assert.equal(instance.draftById(draft.draftId), undefined);
  await instance.flush();
  assert.equal(storage.files.has(`drafts/${draft.draftId}.json`), false);
  assert.deepEqual(storedSelections(storage)?.decision?.selectedInput, { kind: "saved-decision-request-revision", revisionId: published.id });
});

test("a decision scratch with no parent saves as a new named request", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  const scratch = instance.createDecisionScratch(inlineContent("New"), {});
  assert.deepEqual(instance.decisionSelection, { kind: "scratch", scratchId: scratch.scratchId });
  assert.equal(scratch.request.kind, "decision");
  const writer = sharedWriter(shared);
  const refused = await instance.publishScratch(scratch.scratchId, shared, writer.write);
  assert.equal(refused.kind, "failed");
  assert.equal(writer.state.calls, 0);
  const outcome = await instance.publishScratch(scratch.scratchId, shared, writer.write, "Routing v2");
  assert.equal(outcome.kind, "published");
  const revision = writer.state.document.decisionRequestRevisions.find(({ id }) => id === (outcome as { revisionId: string }).revisionId)!;
  const request = writer.state.document.decisionRequests.find(({ id }) => id === revision.decisionRequestId)!;
  assert.equal(request.name, "Routing v2");
  assert.equal(revision.parentRevisionId, undefined);
  assert.equal(writer.state.document.defaults.decisionRequestRevisionId, shared.defaults.decisionRequestRevisionId);
  assert.deepEqual(instance.decisionSelection, { kind: "saved-decision-request-revision", revisionId: revision.id });
  assert.equal(instance.scratch(scratch.scratchId), undefined);
});

test("discarding a decision draft or scratch returns the selection to its base or parent", async () => {
  const instance = controller(new MemoryStorage());
  await instance.open(shared);
  instance.updateDecisionRequestDraft(inline, inlineContent("Draft"));
  await instance.discardDecisionRequestDraft(decisionRequestId);
  assert.deepEqual(instance.decisionSelection, { kind: "saved-decision-request-revision", revisionId: inline.id });
  assert.equal(instance.draftFor({ kind: "decision-request", id: decisionRequestId }), undefined);

  const parented = instance.createDecisionScratch(inlineContent("Parented"), { parent: { kind: "saved-decision-request-revision", revisionId: use.id } });
  await instance.discardScratch(parented.scratchId);
  assert.deepEqual(instance.decisionSelection, { kind: "saved-decision-request-revision", revisionId: use.id });

  const chatRevision = shared.defaults.conversationRevisionId!;
  instance.selectChat({ kind: "saved-conversation-revision", revisionId: chatRevision });
  const root = instance.createDecisionScratch(inlineContent("Root"), {});
  await instance.discardScratch(root.scratchId);
  assert.equal(instance.decisionSelection, undefined);
  // A decision discard never moves the chat selection.
  assert.deepEqual(instance.chatSelection, { kind: "saved-conversation-revision", revisionId: chatRevision });
});

test("a decision draft whose base is gone is marked orphaned on open", async () => {
  const storage = new MemoryStorage();
  const first = controller(storage);
  await first.open(shared);
  first.updateDecisionRequestDraft(inline, inlineContent("Kept"));
  await first.flush();
  const withoutBase = parseProjectFile({
    ...shared,
    decisionRequestRevisions: shared.decisionRequestRevisions
      .filter(({ id }) => id !== inline.id)
      .map((revision) => {
        const rest = { ...revision };
        delete rest.parentRevisionId;
        return rest;
      }),
  });
  const reopened = controller(storage);
  await reopened.open(withoutBase);
  assert.ok(reopened.recovery.some((item) => item.kind === "orphaned-draft" && item.asset?.kind === "decision-request"));
});

test("an interrupted decision scratch publication settles on open and selects the saved revision", async () => {
  const storage = new MemoryStorage();
  const first = controller(storage);
  await first.open(shared);
  const scratch = first.createDecisionScratch(inlineContent("Interrupted"), { parent: { kind: "saved-decision-request-revision", revisionId: inline.id } });
  await first.flush();
  let landed: ProjectFile | undefined;
  const outcome = await first.publishScratch(scratch.scratchId, shared, async (update) => {
    landed = update(shared);
    // The shared write landed, but this window closes before cleanup.
    first.close();
    return { kind: "confirmed", project: landed };
  });
  assert.equal(outcome.kind, "published");
  const stored = parseWorkbenchRecordJson(storage.files.get(`scratch/${scratch.scratchId}.json`)!, projectId) as WorkbenchScratchV1;
  assert.ok(stored.publishing);
  const reopened = controller(storage);
  await reopened.open(landed!);
  assert.equal(reopened.scratch(scratch.scratchId), undefined);
  assert.deepEqual(reopened.decisionSelection, {
    kind: "saved-decision-request-revision", revisionId: stored.publishing!.revisionId as DecisionRequestRevisionId,
  });
});

test("an edit back to the base deletes the stored draft after the debounce, without a flush", async () => {
  const storage = new MemoryStorage();
  const timers: Array<() => void> = [];
  const instance = new PersonalWorkbenchController({
    projectId, storage, seeds: [], onChange() {},
    setTimer: (callback) => timers.push(callback), clearTimer() {},
    newDraftId: () => "draft_debounced",
    now: () => "2026-11-04T15:00:00.000Z",
  });
  await instance.open(shared);
  const runTimers = async () => {
    for (const run of timers.splice(0)) run();
    // Let the store's queued writes settle.
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  const launchChat = shared.conversationRevisions.find(({ id }) => id === shared.defaults.conversationRevisionId)!;
  const chatItems = structuredClone(launchChat.items);
  instance.updateDecisionRequestDraft(inline, inlineContent("Edited"));
  await runTimers();
  assert.ok(storage.files.has("drafts/draft_debounced.json"));
  instance.updateDecisionRequestDraft(inline, baseContent, { draftId: "draft_debounced" });
  await runTimers();
  assert.equal(storage.files.has("drafts/draft_debounced.json"), false, "decision draft still on disk");
  // The chat arm shares the path.
  instance.updateChatRequestDraft(launchChat, [{ kind: "message", message: { id: "message_edited" as never, role: "user", content: [{ type: "text", text: "Edited" }] } }]);
  await runTimers();
  assert.ok(storage.files.has("drafts/draft_debounced.json"));
  instance.updateChatRequestDraft(launchChat, chatItems, { draftId: "draft_debounced" });
  await runTimers();
  assert.equal(storage.files.has("drafts/draft_debounced.json"), false, "chat draft still on disk");
});
