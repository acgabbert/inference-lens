import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseProjectFile } from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import type { EvaluationSuite } from "../packages/core/src/evaluation-suites.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { parseWorkbenchRecordJson, serializeWorkbenchRecord } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchSuiteDraftV1 } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchMutationResult, WorkbenchRemovalResult, WorkbenchStorage } from "../packages/core/src/workbench-store.ts";
import { PersonalWorkbenchController } from "../app/workbench/personal-workbench-controller.ts";
import type { SharedWriteOutcome } from "../app/use-project-workspace.client.ts";

// Slice 2c-1: suite edits are a personal draft until an explicit save (C1, C4).

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const shared: ProjectFile = plan.shared;
const projectId = shared.projectId;
const suite = shared.evaluationSuites.find(({ id }) => id === "evaluation-suite_chat")!;
const asset = { kind: "suite" as const, id: suite.id };
const named = (name: string) => ({ ...suite, name }) as EvaluationSuite;

class MemoryStorage implements WorkbenchStorage {
  files = new Map<string, string>();
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
    return { kind: "written" };
  }
}

function controller(storage: WorkbenchStorage) {
  let ids = 0;
  return new PersonalWorkbenchController({
    projectId, storage, seeds: [], onChange() {},
    setTimer: () => 0, clearTimer() {},
    newDraftId: () => `draft_suite-${++ids}`,
    now: () => "2026-11-05T15:00:00.000Z",
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

function withSuite(source: ProjectFile, next: EvaluationSuite): ProjectFile {
  return parseProjectFile({ ...source, evaluationSuites: source.evaluationSuites.map(entry => entry.id === next.id ? next : entry) });
}

test("a suite edit is a personal draft that keeps the base it started from", async () => {
  const storage = new MemoryStorage();
  const instance = controller(storage);
  await instance.open(shared);
  instance.updateSuiteDraft(suite, named("First"));
  // The owner passes the suite as it reads now; the draft's base stays put.
  instance.updateSuiteDraft(named("First"), named("Second"));
  const draft = instance.draftFor(asset) as WorkbenchSuiteDraftV1;
  assert.deepEqual(draft.base.snapshot, suite);
  assert.equal(draft.edited.name, "Second");
  assert.deepEqual(instance.unsavedDrafts.map(({ asset: listed }) => listed), [asset]);
  await instance.flush();
  const stored = parseWorkbenchRecordJson(storage.files.get("drafts/draft_suite-1.json")!, projectId);
  assert.equal(stored.kind === "draft" && stored.asset.kind, "suite");

  // Edited back to the base: no draft.
  instance.updateSuiteDraft(named("Second"), suite);
  assert.equal(instance.draftFor(asset), undefined);
  await instance.flush();
  assert.equal(storage.files.size, 0);
});

test("Save replaces the shared suite and clears the draft", async () => {
  const instance = controller(new MemoryStorage());
  await instance.open(shared);
  instance.updateSuiteDraft(suite, named("Saved name"));
  const writer = sharedWriter(shared);
  const outcome = await instance.publishSuiteDraft(suite.id, shared, (update) => writer.write(update));
  assert.equal(outcome.kind, "published");
  assert.ok(outcome.kind === "published");
  assert.equal(outcome.revisionId, suite.id);
  assert.equal(writer.state.document.evaluationSuites.find(({ id }) => id === suite.id)!.name, "Saved name");
  assert.equal(instance.draftFor(asset), undefined);
});

test("a suite changed since the draft started is stale until the user overwrites (C4)", async () => {
  const instance = controller(new MemoryStorage());
  await instance.open(shared);
  instance.updateSuiteDraft(suite, named("Mine"));
  const theirs = withSuite(shared, named("Theirs"));
  const writer = sharedWriter(theirs);
  const stale = await instance.publishSuiteDraft(suite.id, theirs, (update) => writer.write(update));
  assert.equal(stale.kind, "stale");
  assert.equal(writer.state.calls, 0);
  assert.equal((instance.draftFor(asset) as WorkbenchSuiteDraftV1).edited.name, "Mine");

  const overwritten = await instance.publishSuiteDraft(suite.id, theirs, (update) => writer.write(update), { overwrite: true });
  assert.equal(overwritten.kind, "published");
  assert.equal(writer.state.document.evaluationSuites.find(({ id }) => id === suite.id)!.name, "Mine");
  assert.equal(instance.draftFor(asset), undefined);
});

test("a suite that changes while saving refuses the write and keeps the draft", async () => {
  const instance = controller(new MemoryStorage());
  await instance.open(shared);
  instance.updateSuiteDraft(suite, named("Mine"));
  // Another tab saves in between: the workspace re-applies the plan to the latest document.
  const writer = sharedWriter(withSuite(shared, named("Theirs")));
  const outcome = await instance.publishSuiteDraft(suite.id, shared, async (update) => {
    try {
      return await writer.write(update);
    } catch (error) {
      return { kind: "failed", message: (error as Error).message };
    }
  });
  assert.equal(outcome.kind, "failed");
  assert.ok(outcome.kind === "failed" && /changed this suite while it was saving/.test(outcome.message));
  const kept = instance.draftFor(asset) as WorkbenchSuiteDraftV1;
  assert.equal(kept.edited.name, "Mine");
  assert.equal(kept.publishing, undefined);
});

test("a draft whose suite was deleted is orphaned on open, and Save as new restores it", async () => {
  const storage = new MemoryStorage();
  const record: WorkbenchSuiteDraftV1 = {
    schemaVersion: 1, kind: "draft", projectId, draftId: "draft_kept", asset, base: { snapshot: suite }, edited: named("Kept"),
  } as WorkbenchSuiteDraftV1;
  storage.files.set("drafts/draft_kept.json", serializeWorkbenchRecord(record));
  const without = parseProjectFile({ ...shared, evaluationSuites: shared.evaluationSuites.filter(({ id }) => id !== suite.id) });
  const instance = controller(storage);
  await instance.open(without);
  const orphan = instance.recovery.find(({ kind }) => kind === "orphaned-draft");
  assert.ok(orphan);
  assert.match(orphan.message, /suite no longer exists/);
  assert.deepEqual(orphan.actions, ["compare", "save-as-new", "discard"]);

  const writer = sharedWriter(without);
  const outcome = await instance.saveRecoveryAsNew(orphan.id, "Restored cases", without, (update) => writer.write(update));
  assert.deepEqual(outcome, { kind: "settled" });
  const restored = writer.state.document.evaluationSuites.find(({ id }) => id === suite.id)!;
  assert.equal(restored.name, "Restored cases");
  assert.equal(instance.draftFor(asset), undefined);
  assert.equal(instance.recovery.length, 0);
  await instance.flush();
  assert.equal(storage.files.has("drafts/draft_kept.json"), false);
});

test("an interrupted suite save is settled on open: published content clears the draft", async () => {
  const storage = new MemoryStorage();
  const record = {
    schemaVersion: 1, kind: "draft", projectId, draftId: "draft_saving", asset,
    base: { snapshot: suite }, edited: named("Saving"), publishing: { content: named("Saving") },
  } as WorkbenchSuiteDraftV1;
  storage.files.set("drafts/draft_saving.json", serializeWorkbenchRecord(record));
  const landed = controller(storage);
  await landed.open(withSuite(shared, named("Saving")));
  assert.equal(landed.draftFor(asset), undefined);
  assert.equal(landed.recovery.length, 0);

  // The write never landed: the draft stays, without its intent.
  const notLanded = new MemoryStorage();
  notLanded.files.set("drafts/draft_saving.json", serializeWorkbenchRecord(record));
  const instance = controller(notLanded);
  await instance.open(shared);
  const kept = instance.draftFor(asset) as WorkbenchSuiteDraftV1;
  assert.equal(kept.edited.name, "Saving");
  assert.equal(kept.publishing, undefined);

  // Someone else's edit under the same suite: for review, not overwritten.
  const conflicted = new MemoryStorage();
  conflicted.files.set("drafts/draft_saving.json", serializeWorkbenchRecord(record));
  const review = controller(conflicted);
  await review.open(withSuite(shared, named("Third")));
  const item = review.recovery.find(({ kind }) => kind === "publication-conflict");
  assert.ok(item);
  const comparison = await review.compareRecovery(item.id, withSuite(shared, named("Third")));
  assert.equal(comparison?.current?.label, "Saved suite");
});
