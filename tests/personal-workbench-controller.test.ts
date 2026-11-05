import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ChatPromptTemplate, ProjectFile, PromptTemplateMessages } from "../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { parseWorkbenchRecordJson, serializeWorkbenchRecord } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchPromptDraftV1 } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchMutationResult, WorkbenchRemovalResult, WorkbenchStorage } from "../packages/core/src/workbench-store.ts";
import { publishPromptDraft } from "../packages/core/src/workbench-publication.ts";
import { PersonalWorkbenchController } from "../app/workbench/personal-workbench-controller.ts";
import type { SharedWriteOutcome } from "../app/use-project-workspace.client.ts";

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const shared: ProjectFile = plan.shared;
const projectId = shared.projectId;
const seed = plan.drafts.find((draft) => draft.asset.kind === "chat-prompt")! as WorkbenchPromptDraftV1 & { asset: { kind: "chat-prompt" } };
const template = shared.promptTemplates.find(({ id }) => id === seed.asset.id) as ChatPromptTemplate;
const baseRevision = template.revisions.find(({ id }) => id === seed.base.revisionId)!;
const asset = seed.asset;
const base = seed.base;
const edited = (text: string): { messages: PromptTemplateMessages; variableDefaults: Record<string, string> } => ({
  messages: [{ role: "user", content: text }],
  variableDefaults: {},
});

class MemoryStorage implements WorkbenchStorage {
  files = new Map<string, string>();
  writes: string[] = [];
  failNext?: WorkbenchMutationResult;
  async list() {
    return [...this.files].map(([path, contents]) => ({ path, contents }));
  }
  async removeMigrationOperation(): Promise<WorkbenchRemovalResult> {
    return { kind: "blocked", reason: "not-removable", message: "No migration backups here." };
  }
  async mutate(path: string, expected: string | null, contents: string | null): Promise<WorkbenchMutationResult> {
    if (this.failNext) {
      const result = this.failNext;
      this.failNext = undefined;
      return result;
    }
    const actual = this.files.get(path) ?? null;
    if (actual !== expected) return { kind: "conflict", phase: "before-write", actualContents: actual };
    if (contents === null) this.files.delete(path);
    else this.files.set(path, contents);
    this.writes.push(`${contents === null ? "delete" : "write"} ${path}`);
    return { kind: "written" };
  }
}

/** Timers run only when the test says so. */
function manualTimers() {
  const queued = new Map<number, () => void>();
  let next = 0;
  return {
    setTimer(callback: () => void) { queued.set(++next, callback); return next; },
    clearTimer(timer: unknown) { queued.delete(timer as number); },
    run() { const callbacks = [...queued.values()]; queued.clear(); callbacks.forEach((callback) => callback()); },
  };
}

function controller(storage: WorkbenchStorage | null, overrides: Partial<ConstructorParameters<typeof PersonalWorkbenchController>[0]> = {}) {
  const timers = manualTimers();
  let ids = 0;
  const instance = new PersonalWorkbenchController({
    projectId, storage, seeds: [], onChange() {},
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    newDraftId: () => `draft_test-${++ids}`,
    now: () => "2026-10-31T15:00:00.000Z",
    ...overrides,
  });
  return { instance, timers };
}

/** The workspace's writeShared, against an in-memory document. */
function sharedWriter(initial: ProjectFile, result?: SharedWriteOutcome) {
  const state = { document: initial, calls: 0 };
  return {
    state,
    async write(update: (current: ProjectFile) => ProjectFile): Promise<SharedWriteOutcome> {
      state.calls += 1;
      if (result) return result;
      state.document = update(state.document);
      return { kind: "confirmed", project: state.document };
    },
  };
}

test("an edit is held in memory at once and written after the debounce", async () => {
  const storage = new MemoryStorage();
  const { instance, timers } = controller(storage);
  await instance.open(shared);
  assert.deepEqual(instance.status, { kind: "ready", saving: false });
  instance.updatePromptDraft(asset, base, edited("Shorter."));
  assert.deepEqual(instance.draftFor(asset)?.edited, edited("Shorter."));
  assert.equal(storage.files.size, 0);
  assert.deepEqual(instance.unsavedDrafts.map(({ persisted }) => persisted), [false]);
  timers.run();
  await instance.flush();
  const stored = parseWorkbenchRecordJson(storage.files.get("drafts/draft_test-1.json")!, projectId);
  assert.deepEqual(stored.kind === "draft" && stored.edited, edited("Shorter."));
  assert.deepEqual(instance.unsavedDrafts.map(({ persisted }) => persisted), [true]);
});

test("an edit back to the base content clears the draft, as a legacy draft did", async () => {
  const storage = new MemoryStorage();
  const { instance } = controller(storage);
  await instance.open(shared);
  instance.updatePromptDraft(asset, base, edited("Shorter."));
  await instance.flush();
  instance.updatePromptDraft(asset, base, { messages: structuredClone(baseRevision.messages), variableDefaults: structuredClone(baseRevision.variableDefaults) });
  assert.equal(instance.draftFor(asset), undefined);
  await instance.flush();
  assert.equal(storage.files.size, 0);
});

test("publication writes the intent first, then the shared revision, then deletes the draft", async () => {
  const storage = new MemoryStorage();
  const { instance } = controller(storage);
  await instance.open(shared);
  instance.updatePromptDraft(asset, base, edited("Published text."));
  const writer = sharedWriter(shared);
  const intentSeen: string[] = [];
  const outcome = await instance.publishPromptDraft(asset, shared, async (update) => {
    // Step 1 landed before the shared write was attempted.
    const onDisk = parseWorkbenchRecordJson(storage.files.get("drafts/draft_test-1.json")!, projectId);
    if (onDisk.kind === "draft" && onDisk.publishing) intentSeen.push(onDisk.publishing.revisionId);
    return writer.write(update);
  });
  assert.equal(outcome.kind, "published");
  assert.ok(outcome.kind === "published" && !outcome.keptEdits);
  const published = writer.state.document.promptTemplates.find(({ id }) => id === asset.id) as ChatPromptTemplate;
  assert.equal(published.currentRevisionId, intentSeen[0]);
  assert.deepEqual(published.revisions.at(-1)!.messages, edited("Published text.").messages);
  assert.equal(instance.draftFor(asset), undefined);
  assert.equal(storage.files.size, 0);
  assert.deepEqual(storage.writes, ["write drafts/draft_test-1.json", "delete drafts/draft_test-1.json"]);
});

test("edits made while the shared write is in flight stay as a draft on the published revision", async () => {
  const storage = new MemoryStorage();
  const { instance } = controller(storage);
  await instance.open(shared);
  instance.updatePromptDraft(asset, base, edited("First."));
  const writer = sharedWriter(shared);
  const outcome = await instance.publishPromptDraft(asset, shared, async (update) => {
    instance.updatePromptDraft(asset, base, edited("Second."));
    return writer.write(update);
  });
  assert.ok(outcome.kind === "published" && outcome.keptEdits);
  const draft = instance.draftFor(asset) as WorkbenchPromptDraftV1;
  assert.equal(draft.base.revisionId, outcome.revisionId);
  assert.deepEqual(draft.edited, edited("Second."));
  assert.equal(draft.publishing, undefined);
  await instance.flush();
  const stored = parseWorkbenchRecordJson(storage.files.get("drafts/draft_test-1.json")!, projectId);
  assert.ok(stored.kind === "draft" && stored.base.revisionId === outcome.revisionId && !stored.publishing);
});

test("a refused shared write keeps the draft and drops the intent", async () => {
  const storage = new MemoryStorage();
  const { instance } = controller(storage);
  await instance.open(shared);
  instance.updatePromptDraft(asset, base, edited("Kept."));
  const writer = sharedWriter(shared, { kind: "conflict", message: "project.json changed outside Inference Lens." });
  const outcome = await instance.publishPromptDraft(asset, shared, (update) => writer.write(update));
  assert.deepEqual(outcome, { kind: "conflict", message: "project.json changed outside Inference Lens." });
  const draft = instance.draftFor(asset)!;
  assert.deepEqual(draft.edited, edited("Kept."));
  assert.equal(draft.publishing, undefined);
  const stored = parseWorkbenchRecordJson(storage.files.get("drafts/draft_test-1.json")!, projectId);
  assert.ok(stored.kind === "draft" && !stored.publishing);
});

test("an intent that cannot be recorded stops before the shared write", async () => {
  const storage = new MemoryStorage();
  const { instance } = controller(storage);
  await instance.open(shared);
  instance.updatePromptDraft(asset, base, edited("Kept."));
  await instance.flush();
  storage.failNext = { kind: "blocked", reason: "protection", message: "Workbench .gitignore must contain exactly '*\\n'." };
  const writer = sharedWriter(shared);
  const outcome = await instance.publishPromptDraft(asset, shared, (update) => writer.write(update));
  assert.equal(outcome.kind, "blocked");
  assert.equal(writer.state.calls, 0);
  assert.equal(instance.draftFor(asset)?.publishing, undefined);
});

/** A shared document in which `text` was published as `template-revision_<suffix>`. */
function publishedAs(suffix: string, text: string): ProjectFile {
  const result = publishPromptDraft(shared, { ...seed, edited: edited(text) } as WorkbenchPromptDraftV1, { idSuffix: suffix, createdAt: "2026-10-31T15:00:00.000Z" });
  assert.equal(result.kind, "publish");
  return result.kind === "publish" ? result.project : shared;
}

function interrupted(draftId: string, revisionId: string, text: string): string {
  return serializeWorkbenchRecord({
    ...seed, draftId, edited: edited(text),
    publishing: { revisionId, parentRevisionId: base.revisionId, content: edited(text) },
  } as WorkbenchPromptDraftV1);
}

test("opening settles an interrupted publication that landed by clearing the draft", async () => {
  const storage = new MemoryStorage();
  storage.files.set("drafts/draft_landed.json", interrupted("draft_landed", "template-revision_landed", "Landed."));
  const { instance } = controller(storage);
  await instance.open(publishedAs("landed", "Landed."));
  assert.equal(instance.draftFor(asset), undefined);
  assert.equal(storage.files.size, 0);
});

test("opening settles an interrupted publication that never landed by keeping the draft", async () => {
  const storage = new MemoryStorage();
  storage.files.set("drafts/draft_lost.json", interrupted("draft_lost", "template-revision_never", "Lost."));
  const { instance } = controller(storage);
  await instance.open(shared);
  assert.equal(instance.draftFor(asset)?.publishing, undefined);
  assert.deepEqual(instance.draftFor(asset)?.edited, edited("Lost."));
  const stored = parseWorkbenchRecordJson(storage.files.get("drafts/draft_lost.json")!, projectId);
  assert.ok(stored.kind === "draft" && !stored.publishing);
});

test("opening leaves a conflicting publication for review and does not write it", async () => {
  const storage = new MemoryStorage();
  const contents = interrupted("draft_conflicted", "template-revision_taken", "Mine.");
  storage.files.set("drafts/draft_conflicted.json", contents);
  const { instance } = controller(storage);
  await instance.open(publishedAs("taken", "Someone else's."));
  assert.deepEqual(instance.recovery.map(({ kind }) => kind), ["publication-conflict"]);
  assert.equal(storage.files.get("drafts/draft_conflicted.json"), contents);
  assert.equal(storage.writes.length, 0);
  const outcome = await instance.publishPromptDraft(asset, shared, sharedWriter(shared).write);
  assert.equal(outcome.kind, "conflict");
});

test("a session without a folder keeps lifted drafts in memory and publishes to the session document", async () => {
  const { instance } = controller(null, { seeds: [seed] });
  await instance.open(shared);
  assert.deepEqual(instance.status, { kind: "session" });
  assert.deepEqual(instance.draftFor(asset)?.edited, seed.edited);
  assert.deepEqual(instance.unsavedDrafts.map(({ persisted }) => persisted), [false]);
  const writer = sharedWriter(shared);
  const outcome = await instance.publishPromptDraft(asset, shared, (update) => writer.write(update));
  assert.equal(outcome.kind, "published");
  assert.equal(instance.draftFor(asset), undefined);
});

test("records carried from a session into a new folder are written there", async () => {
  const storage = new MemoryStorage();
  const { instance } = controller(storage, { seeds: [seed] });
  await instance.open(shared);
  assert.deepEqual([...storage.files.keys()], [`drafts/${seed.draftId}.json`]);
  assert.deepEqual(instance.unsavedDrafts.map(({ persisted }) => persisted), [true]);
});

test("only work with no folder counts as what a replacement would lose (Z3)", async () => {
  const session = controller(null, { seeds: [seed] });
  await session.instance.open(shared);
  assert.equal(session.instance.sessionOnlyWorkCount, 1);

  // A folder's queued write is not counted: the outgoing session flushes it.
  const storage = new MemoryStorage();
  const folder = controller(storage);
  await folder.instance.open(shared);
  folder.instance.updatePromptDraft(asset, base, edited("Queued."));
  assert.equal(folder.instance.sessionOnlyWorkCount, 0);
});

test("a workbench that belongs to another project blocks the controller", async () => {
  const storage = new MemoryStorage();
  storage.files.set("selections.json", JSON.stringify({ schemaVersion: 1, kind: "selections", projectId: "project_other" }));
  const { instance } = controller(storage);
  await instance.open(shared);
  assert.equal(instance.status.kind, "blocked");
  const outcome = await instance.publishPromptDraft(asset, shared, sharedWriter(shared).write);
  assert.equal(outcome.kind, "blocked");
});

// Step 6a, V2: records carried out of a pre-v19 session into the upgraded folder.
const activatedDraft = { ...seed, draftId: "draft_migrated-activated" } as WorkbenchPromptDraftV1;
const activatedPath = `drafts/${activatedDraft.draftId}.json`;

function upgradedStorage(stored: WorkbenchPromptDraftV1 = activatedDraft) {
  const storage = new MemoryStorage();
  storage.files.set(`drafts/${stored.draftId}.json`, serializeWorkbenchRecord(stored));
  return storage;
}

test("after an upgrade, an unedited carried draft gives way to the draft completion activated", async () => {
  const storage = upgradedStorage();
  const { instance } = controller(storage, { seeds: [seed], upgrade: { activated: [activatedPath], lifted: [seed] } });
  await instance.open(shared);
  assert.deepEqual(instance.recovery, []);
  assert.equal(instance.draftFor(asset)?.draftId, activatedDraft.draftId);
  await instance.flush();
  assert.deepEqual(storage.writes, []);
});

test("after an upgrade, a carried draft edited in the session replaces the activated draft's content in place", async () => {
  const storage = upgradedStorage();
  const carried = { ...seed, edited: edited("Edited before the upgrade.") } as WorkbenchPromptDraftV1;
  const { instance } = controller(storage, { seeds: [carried], upgrade: { activated: [activatedPath], lifted: [seed] } });
  await instance.open(shared);
  await instance.flush();
  assert.deepEqual(instance.recovery, []);
  assert.deepEqual([...storage.files.keys()], [activatedPath]);
  const stored = parseWorkbenchRecordJson(storage.files.get(activatedPath)!, projectId);
  assert.deepEqual(stored.kind === "draft" && stored.edited, edited("Edited before the upgrade."));
});

test("after an upgrade, an edited carried draft that meets an older active draft stays in memory for recovery", async () => {
  const older = { ...seed, draftId: "draft_from-before", edited: edited("An older personal draft.") } as WorkbenchPromptDraftV1;
  const storage = upgradedStorage(older);
  const carried = { ...seed, edited: edited("Edited before the upgrade.") } as WorkbenchPromptDraftV1;
  const { instance } = controller(storage, { seeds: [carried], upgrade: { activated: [], lifted: [seed] } });
  await instance.open(shared);
  await instance.flush();
  assert.deepEqual(storage.writes, []);
  assert.equal(instance.draftFor(asset)?.draftId, older.draftId);
  assert.equal(instance.recovery.length, 1);
  const [item] = instance.recovery;
  assert.equal(item!.kind, "competing-draft");
  assert.deepEqual(item!.record && item!.record.kind === "draft" && item!.record.edited, edited("Edited before the upgrade."));
  assert.equal(instance.hasUnpersistedWork, true, "the session copy exists only in memory");
});

test("upgrading preserves existing selections when carried selections collide", async () => {
  const storage = new MemoryStorage();
  const existing = structuredClone(plan.selections);
  existing.chat!.execution!.target!.model = "existing-personal-model";
  storage.files.set("selections.json", serializeWorkbenchRecord(existing));
  const carried = structuredClone(plan.selections);
  carried.chat!.execution!.target!.model = "session-personal-model";
  const { instance } = controller(storage, {
    seeds: [carried],
    upgrade: { activated: [], lifted: plan.drafts },
  });
  await instance.open(shared);
  const result = parseWorkbenchRecordJson(storage.files.get("selections.json")!, projectId);
  assert.equal(result.kind === "selections" && result.chat?.execution?.target?.model, "existing-personal-model");
  assert.deepEqual(instance.recovery.map((item) => item.record), [carried]);
  assert.equal(instance.hasUnpersistedWork, true);
});

test("upgrading carries selections over the record completion just activated", async () => {
  const storage = new MemoryStorage();
  storage.files.set("selections.json", serializeWorkbenchRecord(plan.selections));
  const carried = structuredClone(plan.selections);
  carried.chat!.execution!.target!.model = "session-personal-model";
  const { instance } = controller(storage, {
    seeds: [carried], upgrade: { activated: ["selections.json"], lifted: plan.drafts, stagedSelections: plan.selections },
  });
  await instance.open(shared);
  assert.deepEqual(parseWorkbenchRecordJson(storage.files.get("selections.json")!, projectId), carried);
  assert.deepEqual(instance.recovery, []);
});

test("upgrading identical selections creates no recovery copy or write", async () => {
  const storage = new MemoryStorage();
  storage.files.set("selections.json", serializeWorkbenchRecord(plan.selections));
  const { instance } = controller(storage, {
    seeds: [plan.selections], upgrade: { activated: [], lifted: plan.drafts },
  });
  await instance.open(shared);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(instance.recovery, []);
  assert.equal(instance.hasUnpersistedWork, false);
});

test("an activated draft edited before reopen keeps both writers' versions", async () => {
  const newer = { ...activatedDraft, edited: edited("Edited by another writer.") } as WorkbenchPromptDraftV1;
  const storage = upgradedStorage(newer);
  const carried = { ...seed, edited: edited("Edited before the upgrade.") } as WorkbenchPromptDraftV1;
  const { instance } = controller(storage, { seeds: [carried], upgrade: { activated: [activatedPath], lifted: [seed] } });
  await instance.open(shared);
  assert.deepEqual(instance.draftFor(asset)?.edited, newer.edited);
  assert.deepEqual(instance.recovery.map((item) => item.record), [carried]);
  assert.deepEqual(storage.writes, []);
});

test("activated selections edited before reopen preserve the newer record", async () => {
  const storage = new MemoryStorage();
  const newer = structuredClone(plan.selections);
  newer.chat!.execution!.target!.model = "another-writers-model";
  storage.files.set("selections.json", serializeWorkbenchRecord(newer));
  const carried = structuredClone(plan.selections);
  carried.chat!.execution!.target!.model = "session-model";
  const { instance } = controller(storage, {
    seeds: [carried],
    upgrade: { activated: ["selections.json"], lifted: plan.drafts, stagedSelections: plan.selections },
  });
  await instance.open(shared);
  assert.deepEqual(parseWorkbenchRecordJson(storage.files.get("selections.json")!, projectId), newer);
  assert.deepEqual(instance.recovery.map((item) => item.record), [carried]);
});
