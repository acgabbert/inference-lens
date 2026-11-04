import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { browserMigrationCompletionStorage, browserMigrationStorage } from "../app/workbench-directory.client.ts";
import { findUnfinishedUpgrade, finishUpgrade, previewProjectMigration, upgradeProject } from "../app/workbench/project-migration.ts";
import type { ProjectMigrationPreview, ProjectMigrationStorage } from "../app/workbench/project-migration.ts";
import { prepareSharedProjectMigration, stageSharedProjectMigration } from "../packages/core/src/migration-journal.ts";
import { ByteDirectory } from "./migration-directory-helpers.ts";

const source = new Uint8Array(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const PROJECT_ID = "project_shared-assets-example";

function folder() {
  const directory = new ByteDirectory();
  directory.seed("project.json", source);
  const invalidations: number[] = [];
  const storage: ProjectMigrationStorage = {
    migration: browserMigrationStorage(directory),
    migrationCompletion: browserMigrationCompletionStorage(directory, PROJECT_ID as never, () => { invalidations.push(1); }),
  };
  return { directory, storage, invalidations };
}

async function previewOf(storage: ProjectMigrationStorage): Promise<ProjectMigrationPreview> {
  const outcome = await previewProjectMigration(storage);
  assert.equal(outcome.kind, "preview", JSON.stringify(outcome));
  return (outcome as { preview: ProjectMigrationPreview }).preview;
}

test("a preview names the source version and the drafts that move, and writes nothing", async () => {
  const { directory, storage } = folder();
  const preview = await previewOf(storage);
  assert.equal(preview.sourceVersion, 15);
  assert.equal(preview.staged, false);
  assert.deepEqual(preview.drafts.map(({ kind, name }) => ({ kind, name })), [
    { kind: "chat-prompt", name: "Explain a topic" },
    { kind: "decision-prompt", name: "Route ticket" },
  ]);
  assert.deepEqual([...directory.files.keys()], ["project.json"]);
});

test("Upgrade stages, writes v19 and activates the staged records", async () => {
  const { directory, storage } = folder();
  const outcome = await upgradeProject(storage, await previewOf(storage));
  assert.equal(outcome.kind, "upgraded", JSON.stringify(outcome));
  if (outcome.kind !== "upgraded") return;
  assert.equal(JSON.parse(new TextDecoder().decode(directory.files.get("project.json"))).schemaVersion, 19);
  assert.deepEqual(outcome.activated.sort(), [...outcome.activated].sort());
  assert.ok(outcome.activated.includes("selections.json"));
  assert.equal(outcome.activated.filter((path) => path.startsWith("drafts/draft_migrated-")).length, 2);
  for (const path of outcome.activated) assert.ok(directory.files.has(`.workbench/${path}`), path);
  assert.deepEqual(outcome.lifted.map((draft) => draft.asset.id), ["template_chat", "template_decision"]);
  assert.deepEqual(outcome.recovery.pending, []);
  const sources = [...directory.files.keys()].filter((path) => path.endsWith("/source.project.json"));
  assert.equal(sources.length, 1);
  assert.deepEqual(directory.files.get(sources[0]!), source);
  // Once v19, there is nothing left to finish.
  assert.equal(await findUnfinishedUpgrade(storage, PROJECT_ID as never), undefined);
});

test("a manifest changed after the preview is stale and nothing is written", async () => {
  const { directory, storage } = folder();
  const preview = await previewOf(storage);
  const edited = new TextEncoder().encode(`${new TextDecoder().decode(source)}\n`);
  assert.notDeepEqual(edited, source, "fixture edit must change the bytes");
  directory.seed("project.json", edited);
  const outcome = await upgradeProject(storage, preview);
  assert.equal(outcome.kind, "stale");
  assert.deepEqual([...directory.files.keys()], ["project.json"]);
  assert.deepEqual(directory.files.get("project.json"), edited);
});

test("an earlier staging is reported and continued without staging again", async () => {
  const { directory, storage } = folder();
  assert.equal((await stageSharedProjectMigration(storage.migration, await prepareSharedProjectMigration(source))).kind, "staged");
  const preview = await previewOf(storage);
  assert.equal(preview.staged, true);
  directory.writes = [];
  const outcome = await upgradeProject(storage, preview);
  assert.equal(outcome.kind, "upgraded");
  assert.ok(!directory.writes.some((path) => path.includes("/migrations/")), `no staging writes: ${directory.writes.join(", ")}`);
});

test("a failed manifest write is an inspection outcome, never an upgrade", async () => {
  const { directory, storage, invalidations } = folder();
  const preview = await previewOf(storage);
  directory.failPath = "project.json";
  const outcome = await upgradeProject(storage, preview);
  assert.equal(outcome.kind, "inspection", JSON.stringify(outcome));
  assert.equal(outcome.kind === "inspection" && outcome.shared, "uncertain");
  assert.deepEqual(directory.files.get("project.json"), source);
  assert.equal(invalidations.length, 1, "the attempted write invalidates the handle's ordinary saves");
});

test("an upgrade interrupted after the shared write is found and finished", async () => {
  const { directory, storage } = folder();
  const preview = await previewOf(storage);
  // The first activation fails after project.json is written.
  directory.afterWrite = (path) => {
    if (path === "project.json") directory.failPath = ".workbench/selections.json";
  };
  const interrupted = await upgradeProject(storage, preview);
  assert.equal(interrupted.kind, "upgraded", JSON.stringify(interrupted));
  assert.ok(interrupted.kind === "upgraded" && interrupted.recovery.stopped);
  directory.afterWrite = undefined;
  directory.failPath = undefined;
  // A failed browser write can leave an empty file; clear it as a user would.
  directory.files.delete(".workbench/selections.json");

  const unfinished = await findUnfinishedUpgrade(storage, PROJECT_ID as never);
  assert.equal(unfinished?.operationId, preview.operationId);
  assert.equal(unfinished?.remaining, 3);
  const finished = await finishUpgrade(storage, PROJECT_ID as never, preview.operationId);
  assert.equal(finished.kind, "upgraded", JSON.stringify(finished));
  assert.equal(finished.kind === "upgraded" && finished.activated.length, 3);
  assert.equal(await findUnfinishedUpgrade(storage, PROJECT_ID as never), undefined);
});
