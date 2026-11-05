import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseProjectFile } from "../packages/core/src/project.ts";
import type { ChatPromptTemplate, ProjectFile } from "../packages/core/src/project.ts";
import { inspectSharedProjectMigrationCompletion } from "../packages/core/src/migration-completion.ts";
import { parseMigrationResolutions, prepareSharedProjectMigration } from "../packages/core/src/migration-journal.ts";
import type { MigrationSnapshot, PreparedSharedProjectMigration } from "../packages/core/src/migration-journal.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { parseWorkbenchRecordJson, serializeWorkbenchRecord } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchPromptDraftV1, WorkbenchRecordV1 } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchMutationResult, WorkbenchRemovalResult, WorkbenchStorage } from "../packages/core/src/workbench-store.ts";
import { PersonalWorkbenchController } from "../app/workbench/personal-workbench-controller.ts";
import type { SharedWriteOutcome } from "../app/use-project-workspace.client.ts";

/**
 * Step 6b-1: the personal controller's recovery inventory and reconcile
 * operations (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 6b decisions").
 */

const source = new Uint8Array(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const plan = planSharedProjectMigration(source);
const shared: ProjectFile = plan.shared;
const projectId = shared.projectId;
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const NOW = "2026-11-04T12:00:00.000Z";

/** Workbench files by relative path, as text; the migration snapshot reads them back as bytes. */
class MemoryStorage implements WorkbenchStorage {
  files = new Map<string, string>();
  writes: string[] = [];
  manifest: Uint8Array | null = null;
  failNext?: WorkbenchMutationResult;
  async list() {
    return [...this.files].map(([path, contents]) => ({ path, contents }));
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
  async removeMigrationOperation(operationId: string): Promise<WorkbenchRemovalResult> {
    const resolutions = this.files.get(`migrations/${operationId}/resolutions.json`);
    if (!resolutions || !parseMigrationResolutions(JSON.parse(resolutions)).backupRemovedAt) return { kind: "blocked", reason: "not-removable", message: "No intent." };
    const paths = [...this.files.keys()].filter((path) => path.startsWith(`migrations/${operationId}/`));
    for (const path of paths.sort((a, b) => Number(a.endsWith("resolutions.json")) - Number(b.endsWith("resolutions.json")))) {
      this.files.delete(path);
      this.writes.push(`delete ${path}`);
    }
    return { kind: "removed" };
  }
  migrations = {
    read: async (): Promise<MigrationSnapshot> => ({
      manifest: this.manifest,
      files: [...this.files].filter(([path]) => path !== ".gitignore").map(([path, contents]) => ({ path, bytes: encode(contents) })),
    }),
  };
  read(path: string): WorkbenchRecordV1 | undefined {
    const contents = this.files.get(path);
    return contents === undefined ? undefined : parseWorkbenchRecordJson(contents, projectId);
  }
}

interface Upgrade {
  storage: MemoryStorage;
  prepared: PreparedSharedProjectMigration;
  root: string;
  /** The migrated chat-prompt draft and the selections seed, as staged. */
  draft: { candidate: string; path: string; record: WorkbenchPromptDraftV1 };
  selections: { candidate: string; contents: string };
}

/** A folder an upgrade staged; `activate` puts the candidates where completion would. */
async function upgraded(options: { activate?: boolean } = {}): Promise<Upgrade> {
  const prepared = await prepareSharedProjectMigration(source);
  const root = `migrations/${prepared.operationId}/`;
  const storage = new MemoryStorage();
  for (const file of prepared.files) storage.files.set(file.path, decode(file.bytes));
  // The manifest has moved past the upgrade's output, as any later save does.
  storage.manifest = encode("{}");
  let draft: Upgrade["draft"] | undefined;
  let selections: Upgrade["selections"] | undefined;
  for (const file of prepared.files) {
    if (!file.path.startsWith(`${root}candidates/`)) continue;
    const candidate = file.path.slice(root.length);
    const contents = decode(file.bytes);
    const record = parseWorkbenchRecordJson(contents, projectId);
    if (record.kind === "selections") selections = { candidate, contents };
    else if (record.kind === "draft" && record.asset.kind === "chat-prompt" && !draft) {
      draft = { candidate, path: `drafts/${record.draftId}.json`, record: record as WorkbenchPromptDraftV1 };
    }
    if (options.activate) storage.files.set(candidate === "candidates/selections.json" ? "selections.json" : `drafts/${candidate.slice("candidates/".length)}`, contents);
  }
  assert.ok(draft && selections, "the fixture stages selections and a chat-prompt draft");
  return { storage, prepared, root, draft, selections };
}

function controller(storage: MemoryStorage, overrides: Partial<ConstructorParameters<typeof PersonalWorkbenchController>[0]> = {}) {
  let ids = 0;
  return new PersonalWorkbenchController({
    projectId, storage, migrations: storage.migrations, seeds: [], onChange() {},
    setTimer: () => 0, clearTimer: () => {},
    newDraftId: () => `draft_test-${++ids}`,
    now: () => NOW,
    ...overrides,
  });
}

function sharedWriter(initial: ProjectFile) {
  const state = { document: initial };
  return {
    state,
    async write(update: (current: ProjectFile) => ProjectFile): Promise<SharedWriteOutcome> {
      state.document = update(state.document);
      return { kind: "confirmed", project: state.document };
    },
  };
}

const rivalOf = (record: WorkbenchPromptDraftV1, draftId: string, revisionName: string) =>
  ({ ...record, draftId, edited: { ...record.edited, revisionName } }) as WorkbenchPromptDraftV1;
const resolutionsOf = (setup: Upgrade) => parseMigrationResolutions(JSON.parse(setup.storage.files.get(`${setup.root}resolutions.json`)!));
const find = (instance: PersonalWorkbenchController, kind: string) => instance.recovery.find((item) => item.kind === kind);

test("opening records candidates completion activated as used, so later edits never bring them back", async () => {
  const setup = await upgraded({ activate: true });
  const instance = controller(setup.storage);
  await instance.open(shared);
  assert.deepEqual(instance.recovery, []);
  const recorded = resolutionsOf(setup);
  assert.deepEqual(recorded.resolutions.map(({ outcome }) => outcome), recorded.resolutions.map(() => "used"));
  assert.ok(recorded.resolutions.some(({ candidate }) => candidate === setup.draft.candidate));

  // Edit the migrated draft, then reopen: it is not a competing candidate.
  instance.updatePromptDraft(setup.draft.record.asset, setup.draft.record.base, { messages: [{ role: "user", content: "Edited after the upgrade." }], variableDefaults: {} });
  await instance.flush();
  const reopened = controller(setup.storage);
  await reopened.open(shared);
  assert.deepEqual(reopened.recovery, []);
  assert.deepEqual(reopened.migrationBackups.map(({ removable }) => removable), [true]);
});

test("a competing candidate offers Compare, Use this one and Discard; using it keeps the replaced draft in the operation", async () => {
  const setup = await upgraded();
  const rival = rivalOf(setup.draft.record, "draft_rival", "Mine from before");
  setup.storage.files.set("drafts/draft_rival.json", serializeWorkbenchRecord(rival));
  const instance = controller(setup.storage);
  await instance.open(shared);
  const item = instance.recovery.find((entry) => entry.kind === "migration-candidate" && entry.path === `${setup.root}${setup.draft.candidate}`)!;
  assert.ok(item, JSON.stringify(instance.recovery.map(({ kind, path }) => [kind, path])));
  assert.deepEqual(item.actions, ["compare", "use", "discard"]);
  const comparison = await instance.compareRecovery(item.id, shared);
  assert.deepEqual(comparison?.current?.record, rival);
  assert.deepEqual(comparison?.incoming.record, setup.draft.record);

  assert.deepEqual(await instance.useRecovery(item.id), { kind: "settled" });
  assert.equal(instance.draftFor(setup.draft.record.asset)?.draftId, setup.draft.record.draftId);
  assert.deepEqual(setup.storage.read(setup.draft.path), setup.draft.record);
  assert.equal(setup.storage.files.has("drafts/draft_rival.json"), false);
  const copy = `${setup.root}replaced/draft_rival.json`;
  assert.deepEqual(setup.storage.read(copy), rival);
  assert.ok(instance.migrationBackups[0].files.includes(copy), "removal must disclose the replaced draft");
  const resolution = resolutionsOf(setup).resolutions.find(({ candidate }) => candidate === setup.draft.candidate);
  assert.deepEqual(resolution, { candidate: setup.draft.candidate, outcome: "used", settledAt: NOW, replacedCopy: copy });
  // Copy first, then the candidate, then the rival's deletion, then the resolution.
  const order = setup.storage.writes.filter((entry) => [`write ${copy}`, `write ${setup.draft.path}`, "delete drafts/draft_rival.json"].includes(entry) || entry.endsWith("resolutions.json"));
  assert.deepEqual(order, [`write ${copy}`, `write ${setup.draft.path}`, "delete drafts/draft_rival.json", `write ${setup.root}resolutions.json`]);
  assert.equal(instance.recovery.some((entry) => entry.id === item.id), false);
});

test("discarding every candidate settles the operation, and its backup can then be removed", async () => {
  const setup = await upgraded();
  const instance = controller(setup.storage);
  await instance.open(shared);
  const candidates = instance.recovery.filter((item) => item.kind === "migration-candidate");
  assert.ok(candidates.length > 1);
  assert.deepEqual(instance.migrationBackups.map(({ removable }) => removable), [false]);
  assert.equal((await instance.removeMigrationBackup(setup.prepared.operationId)).kind, "blocked");
  for (const item of candidates) assert.deepEqual(await instance.discardRecovery(item.id), { kind: "settled" });
  assert.equal(instance.draftFor(setup.draft.record.asset), undefined, "discarding never activates");
  assert.deepEqual(resolutionsOf(setup).resolutions.map(({ outcome }) => outcome), candidates.map(() => "discarded"));
  assert.deepEqual(instance.migrationBackups.map(({ removable }) => removable), [true]);

  assert.deepEqual(await instance.removeMigrationBackup(setup.prepared.operationId), { kind: "settled" });
  assert.equal([...setup.storage.files.keys()].some((path) => path.startsWith(setup.root)), false);
  assert.deepEqual(instance.migrationBackups, []);
  assert.equal(setup.storage.writes.at(-1), `delete ${setup.root}resolutions.json`);
});

test("a selections candidate that met existing selections offers only Compare and Discard (W2)", async () => {
  const setup = await upgraded();
  setup.storage.files.set("selections.json", serializeWorkbenchRecord({ schemaVersion: 1, kind: "selections", projectId }));
  const instance = controller(setup.storage);
  await instance.open(shared);
  const item = instance.recovery.find((entry) => entry.kind === "migration-candidate" && entry.path.endsWith("candidates/selections.json"))!;
  assert.deepEqual(item.actions, ["compare", "discard"]);
  assert.equal((await instance.useRecovery(item.id)).kind, "failed");
});

test("Use this one on a session copy moves the active draft to replaced/, which reopens as a replaced draft (W1)", async () => {
  const storage = new MemoryStorage();
  const older = rivalOf(plan.drafts.find((draft) => draft.asset.kind === "chat-prompt")! as WorkbenchPromptDraftV1, "draft_older", "Older");
  storage.files.set("drafts/draft_older.json", serializeWorkbenchRecord(older));
  const carried = rivalOf(older, "draft_session", "From this session");
  const instance = controller(storage, { seeds: [carried], upgrade: { activated: [], lifted: [] } });
  await instance.open(shared);
  const item = find(instance, "competing-draft")!;
  assert.deepEqual(item.actions, ["compare", "use", "discard"]);
  assert.equal(instance.hasUnpersistedWork, true);
  assert.deepEqual(await instance.useRecovery(item.id), { kind: "settled" });
  assert.equal(instance.draftFor(older.asset)?.draftId, "draft_session");
  assert.deepEqual(storage.read("drafts/draft_session.json"), carried);
  assert.deepEqual(storage.read("replaced/draft_older.json"), older);
  assert.equal(storage.files.has("drafts/draft_older.json"), false);
  assert.equal(instance.hasUnpersistedWork, false);

  const reopened = controller(storage);
  await reopened.open(shared);
  const replaced = find(reopened, "replaced-draft")!;
  assert.deepEqual(replaced.actions, ["compare", "use", "discard"]);
  assert.deepEqual(replaced.record, older);
  assert.deepEqual(await reopened.discardRecovery(replaced.id), { kind: "settled" });
  assert.equal(storage.files.has("replaced/draft_older.json"), false);
  assert.equal(reopened.draftFor(older.asset)?.draftId, "draft_session");
});

test("Use this one on a replaced draft with the active draft's own ID swaps them without losing either", async () => {
  const storage = new MemoryStorage();
  const active = rivalOf(plan.drafts.find((draft) => draft.asset.kind === "chat-prompt")! as WorkbenchPromptDraftV1, "draft_same", "Active");
  const earlier = rivalOf(active, "draft_same", "Replaced earlier");
  storage.files.set("drafts/draft_same.json", serializeWorkbenchRecord(active));
  storage.files.set("replaced/draft_same.json", serializeWorkbenchRecord(earlier));
  const instance = controller(storage);
  await instance.open(shared);
  const item = find(instance, "replaced-draft")!;
  assert.deepEqual(await instance.useRecovery(item.id), { kind: "settled" });
  const now = instance.draftFor(active.asset)!;
  assert.equal(now.draftId, "draft_test-1");
  assert.deepEqual({ ...now, draftId: earlier.draftId }, earlier);
  assert.deepEqual(storage.read("replaced/draft_same.json"), active);
  assert.equal(storage.files.has("drafts/draft_same.json"), false);
});

test("two drafts for one prompt on disk: the second is a stored competitor, and Discard deletes only it", async () => {
  const storage = new MemoryStorage();
  const base = plan.drafts.find((draft) => draft.asset.kind === "chat-prompt")! as WorkbenchPromptDraftV1;
  storage.files.set("drafts/draft_a.json", serializeWorkbenchRecord(rivalOf(base, "draft_a", "A")));
  storage.files.set("drafts/draft_b.json", serializeWorkbenchRecord(rivalOf(base, "draft_b", "B")));
  const instance = controller(storage);
  await instance.open(shared);
  const item = find(instance, "competing-draft")!;
  assert.equal(item.path, "drafts/draft_b.json");
  assert.deepEqual(item.record, rivalOf(base, "draft_b", "B"));
  assert.equal(instance.hasUnpersistedWork, false, "a stored competitor is already on disk");
  assert.deepEqual(await instance.discardRecovery(item.id), { kind: "settled" });
  assert.deepEqual([...storage.files.keys()], ["drafts/draft_a.json"]);
});

test("an orphaned prompt draft is saved as a new prompt with its content, never rebased", async () => {
  const storage = new MemoryStorage();
  const base = plan.drafts.find((draft) => draft.asset.kind === "chat-prompt")! as WorkbenchPromptDraftV1 & { asset: { kind: "chat-prompt" } };
  const orphan = { ...base, draftId: "draft_orphan", base: { revisionId: "template-revision_gone", snapshot: { ...base.base.snapshot, id: "template-revision_gone" } } } as WorkbenchPromptDraftV1;
  storage.files.set("drafts/draft_orphan.json", serializeWorkbenchRecord(orphan));
  const instance = controller(storage);
  await instance.open(shared);
  const item = find(instance, "orphaned-draft")!;
  assert.deepEqual(item.actions, ["compare", "save-as-new", "discard"]);
  const comparison = await instance.compareRecovery(item.id, shared);
  assert.equal(comparison?.current?.label, "Base revision");
  const writer = sharedWriter(shared);
  assert.deepEqual(await instance.saveRecoveryAsNew(item.id, "Recovered prompt", shared, writer.write), { kind: "settled" });
  const created = writer.state.document.promptTemplates.find(({ name }) => name === "Recovered prompt") as ChatPromptTemplate;
  assert.ok(created);
  assert.notEqual(created.id, base.asset.id);
  assert.deepEqual(created.revisions[0].messages, (orphan.edited as { messages: unknown }).messages);
  const original = writer.state.document.promptTemplates.find(({ id }) => id === base.asset.id) as ChatPromptTemplate;
  assert.equal(original.revisions.length, (shared.promptTemplates.find(({ id }) => id === base.asset.id) as ChatPromptTemplate).revisions.length);
  assert.equal(storage.files.has("drafts/draft_orphan.json"), false);
  assert.deepEqual(instance.recovery, []);
});

test("a publication conflict can be kept as a draft, which clears the intent and keeps the edits", async () => {
  const storage = new MemoryStorage();
  const base = plan.drafts.find((draft) => draft.asset.kind === "chat-prompt")! as WorkbenchPromptDraftV1 & { asset: { kind: "chat-prompt" } };
  const template = shared.promptTemplates.find(({ id }) => id === base.asset.id) as ChatPromptTemplate;
  const taken = parseProjectFile({
    ...shared,
    promptTemplates: shared.promptTemplates.map((entry) => entry.id !== template.id ? entry : {
      ...template,
      currentRevisionId: "template-revision_taken",
      revisions: [...template.revisions, { id: "template-revision_taken", createdAt: NOW, messages: [{ role: "user", content: "Someone else's." }], variableDefaults: {} }],
    }),
  });
  const mine = { ...base, draftId: "draft_mine", edited: { messages: [{ role: "user", content: "Mine." }], variableDefaults: {} } } as WorkbenchPromptDraftV1;
  storage.files.set("drafts/draft_mine.json", serializeWorkbenchRecord({
    ...mine, publishing: { revisionId: "template-revision_taken", parentRevisionId: base.base.revisionId, content: mine.edited },
  } as WorkbenchPromptDraftV1));
  const instance = controller(storage);
  await instance.open(taken);
  const item = find(instance, "publication-conflict")!;
  assert.deepEqual(item.actions, ["compare", "keep-as-draft", "discard"]);
  const comparison = await instance.compareRecovery(item.id, taken);
  assert.deepEqual((comparison?.current?.record as { messages: unknown }).messages, [{ role: "user", content: "Someone else's." }]);
  assert.deepEqual(await instance.keepRecoveryAsDraft(item.id), { kind: "settled" });
  const stored = storage.read("drafts/draft_mine.json")!;
  assert.ok(stored.kind === "draft" && !stored.publishing);
  assert.deepEqual(stored.kind === "draft" && stored.edited, mine.edited);
  assert.deepEqual(instance.recovery, []);
});

test("a failed write is retried explicitly, after the path is re-read", async () => {
  const storage = new MemoryStorage();
  const base = plan.drafts.find((draft) => draft.asset.kind === "chat-prompt")! as WorkbenchPromptDraftV1 & { asset: { kind: "chat-prompt" } };
  const instance = controller(storage);
  await instance.open(shared);
  storage.failNext = { kind: "blocked", reason: "protection", message: "Workbench .gitignore is missing." };
  instance.updatePromptDraft(base.asset, base.base, { messages: [{ role: "user", content: "Kept." }], variableDefaults: {} });
  await instance.flush();
  const item = find(instance, "write-failed")!;
  assert.deepEqual(item.actions, ["retry"]);
  assert.deepEqual(await instance.retryRecovery(item.id, shared), { kind: "settled" });
  assert.deepEqual(instance.recovery, []);
  const stored = storage.read("drafts/draft_test-1.json")!;
  assert.deepEqual(stored.kind === "draft" && stored.edited, { messages: [{ role: "user", content: "Kept." }], variableDefaults: {} });
});

test("concurrent discards persist every candidate decision", async () => {
  const setup = await upgraded();
  const instance = controller(setup.storage);
  await instance.open(shared);
  const items = instance.recovery.filter((item) => item.kind === "migration-candidate");
  const results = await Promise.all(items.map((item) => instance.discardRecovery(item.id)));
  assert.deepEqual(results, items.map(() => ({ kind: "settled" })));
  assert.deepEqual(resolutionsOf(setup).resolutions.map(({ candidate }) => candidate).sort(),
    items.map((item) => item.candidate).sort());
});

for (const afterWrite of [false, true]) {
  test(`Retry records restored candidates after a failure ${afterWrite ? "after" : "before"} writing`, async () => {
    const setup = await upgraded({ activate: true });
    const mutate = setup.storage.mutate.bind(setup.storage);
    setup.storage.mutate = async (...args) => {
      setup.storage.mutate = mutate;
      if (afterWrite) await mutate(...args);
      throw new Error("temporary write failure");
    };
    const instance = controller(setup.storage);
    await instance.open(shared);
    const item = find(instance, "write-failed")!;
    assert.deepEqual(await instance.retryRecovery(item.id, shared), { kind: "settled" });
    assert.deepEqual(instance.recovery, []);
    assert.ok(resolutionsOf(setup).resolutions.some(({ candidate }) => candidate === setup.draft.candidate));
  });
}

test("Finish upgrade skips a settled draft after its active copy is discarded", async () => {
  const setup = await upgraded({ activate: true });
  setup.storage.manifest = setup.prepared.files[2].bytes;
  const instance = controller(setup.storage);
  await instance.open(shared);
  await instance.discardDraft(setup.draft.record.asset);
  const inspection = await inspectSharedProjectMigrationCompletion(await setup.storage.migrations.read(), projectId, setup.prepared.operationId);
  assert.equal(inspection.kind, "shared-written");
  assert.deepEqual(inspection.candidates.filter(({ disposition }) => disposition === "activate"), []);
});

test("using a candidate preserves the unrelated asset occupying its draft ID", async () => {
  const setup = await upgraded();
  const occupant = { ...setup.draft.record, asset: { ...setup.draft.record.asset, id: "template_other" } } as WorkbenchPromptDraftV1;
  setup.storage.files.set(setup.draft.path, serializeWorkbenchRecord(occupant));
  const instance = controller(setup.storage);
  await instance.open(shared);
  const item = instance.recovery.find((entry) => entry.path === setup.root + setup.draft.candidate)!;
  assert.deepEqual(await instance.useRecovery(item.id), { kind: "settled" });
  assert.deepEqual(setup.storage.read(setup.draft.path), occupant);
  assert.deepEqual(instance.draftFor(occupant.asset), occupant);
  assert.equal(instance.draftFor(setup.draft.record.asset)?.draftId, "draft_test-1");
});

test("another edit of a conflicted draft keeps the explicit conflict choices", async () => {
  const setup = await upgraded({ activate: true });
  const instance = controller(setup.storage);
  await instance.open(shared);
  const base = setup.draft.record as WorkbenchPromptDraftV1 & { asset: { kind: "chat-prompt" } };
  const external = rivalOf(base, base.draftId, "External change");
  setup.storage.files.set(setup.draft.path, serializeWorkbenchRecord(external));
  for (const content of ["first edit", "second edit"]) {
    instance.updatePromptDraft(base.asset, base.base, { messages: [{ role: "user", content }], variableDefaults: {} });
    await instance.flush();
  }
  assert.deepEqual(instance.recovery.map(({ kind }) => kind), ["record-conflict"]);
  assert.deepEqual(await instance.useRecovery(instance.recovery[0].id), { kind: "settled" });
  assert.deepEqual(setup.storage.read(`replaced/${base.draftId}.json`), external);
});

test("Compare on a deletion that met an external edit shows this window's side as deleted", async () => {
  const setup = await upgraded({ activate: true });
  const instance = controller(setup.storage);
  await instance.open(shared);
  const base = setup.draft.record as WorkbenchPromptDraftV1 & { asset: { kind: "chat-prompt" } };
  const external = rivalOf(base, base.draftId, "External change");
  setup.storage.files.set(setup.draft.path, serializeWorkbenchRecord(external));
  await instance.discardDraft(base.asset);
  const item = find(instance, "record-conflict")!;
  assert.ok(item, "the deletion conflicts with the edit on disk");
  assert.deepEqual(await instance.compareRecovery(item.id, shared), {
    incoming: { label: "This window: deleted", record: undefined },
    current: { label: "On disk", record: external },
  });
  assert.deepEqual(setup.storage.read(setup.draft.path), external);
});

test("Retry after an IO failure detects a subsequent external edit", async () => {
  const setup = await upgraded({ activate: true });
  const instance = controller(setup.storage);
  await instance.open(shared);
  const base = setup.draft.record as WorkbenchPromptDraftV1 & { asset: { kind: "chat-prompt" } };
  const mutate = setup.storage.mutate.bind(setup.storage);
  setup.storage.mutate = async () => { throw new Error("write failed"); };
  instance.updatePromptDraft(base.asset, base.base, { messages: [{ role: "user", content: "Mine" }], variableDefaults: {} });
  await instance.flush();
  setup.storage.mutate = mutate;
  const external = rivalOf(base, base.draftId, "External change");
  setup.storage.files.set(setup.draft.path, serializeWorkbenchRecord(external));
  const result = await instance.retryRecovery(find(instance, "write-failed")!.id, shared);
  assert.deepEqual(setup.storage.read(setup.draft.path), external);
  assert.equal(result.kind, "blocked");
  assert.deepEqual(instance.recovery.map(({ kind }) => kind), ["record-conflict"]);
});
