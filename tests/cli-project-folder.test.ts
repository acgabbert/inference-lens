import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startHeadlessEvaluation } from "../packages/cli/src/evaluation-run.ts";
import { openNodeProjectFolder, ProjectFolderError } from "../packages/cli/src/project-folder.ts";
import { createInProcessTransport } from "../packages/cli/src/transport.ts";
import { serializeProjectFile } from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { headlessProject } from "./fixtures/headless/project.ts";
import { recordingProvider } from "./fixtures/headless/recording-provider.ts";

const KEY_VARIABLE = "INFERENCE_LENS_CONNECTION_HEADLESS_DEFAULT_API_KEY";

/** The v19 file the app writes for this project (step 8, Z2). */
function upgraded(project: ProjectFile): string {
  return serializeProjectFile(project);
}

async function folderWith(contents: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "inference-lens-cli-folder-"));
  const directory = path.join(root, "fixture.inference-lens");
  await mkdir(directory);
  await writeFile(path.join(directory, "project.json"), contents);
  return directory;
}

/** The Level 2 examples: a v15 file with two template drafts, and its v19 upgrade. */
const example = (name: string) =>
  readFile(new URL(`../docs/examples/shared-assets-level-two/${name}`, import.meta.url), "utf8");

test("an upgraded v19 folder opens with its shared definitions", async () => {
  const project = headlessProject({ endpoint: "http://127.0.0.1:9/v1" });
  const folder = await openNodeProjectFolder(await folderWith(upgraded(project)));
  assert.equal(folder.project.projectId, project.projectId);
  assert.deepEqual(folder.project.conversationRevisions, project.conversationRevisions);
  assert.deepEqual(folder.project.evaluationSuites, project.evaluationSuites);
  assert.deepEqual(folder.project.defaults, project.defaults);
});

test("a headless evaluation runs on a v19 folder and leaves project.json byte-identical", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await folderWith(upgraded(headlessProject({ endpoint: provider.endpoint })));
  const before = await readFile(path.join(directory, "project.json"), "utf8");

  const outcome = await startHeadlessEvaluation({
    projectDirectory: directory,
    environment: { [KEY_VARIABLE]: "sk-cli-folder" },
    transport: createInProcessTransport({ containerized: false }),
  }).done;

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.exitCode, 0);
  assert.equal(await readFile(path.join(directory, "project.json"), "utf8"), before);
});

test("a pre-v19 folder opens through the migration plan, in memory, without its drafts or an upgrade", async () => {
  const contents = await example("project-v15.json");
  assert.ok(JSON.parse(contents).promptTemplates.some((template: { draft?: unknown }) => template.draft));
  const directory = await folderWith(contents);
  const folder = await openNodeProjectFolder(directory);
  assert.deepEqual(folder.project, planSharedProjectMigration(new TextEncoder().encode(contents)).shared);
  assert.ok(folder.project.promptTemplates.every((template) => !("draft" in template)));
  assert.equal(await readFile(path.join(directory, "project.json"), "utf8"), contents);
});

test("a newer project is refused with every version this build opens", async () => {
  const shared = JSON.parse(await example("project-v19.proposed.json"));
  const directory = await folderWith(`${JSON.stringify({ ...shared, schemaVersion: 20 }, null, 2)}\n`);
  await assert.rejects(openNodeProjectFolder(directory), (error: unknown) => {
    assert.ok(error instanceof ProjectFolderError);
    assert.match(error.message, /opens schema v10, .*v18, and v19/);
    assert.match(error.message, /newer Inference Lens/);
    return true;
  });
});

test("a v19 file carrying a template draft is refused, not read as legacy", async () => {
  const legacy = JSON.parse(await example("project-v15.json"));
  const shared = JSON.parse(await example("project-v19.proposed.json"));
  const drafted = legacy.promptTemplates.find((template: { draft?: unknown }) => template.draft);
  const target = shared.promptTemplates.find((template: { id: string }) => template.id === drafted.id);
  target.draft = drafted.draft;
  const directory = await folderWith(`${JSON.stringify(shared, null, 2)}\n`);
  await assert.rejects(openNodeProjectFolder(directory), (error: unknown) => {
    assert.ok(error instanceof ProjectFolderError);
    assert.match(error.message, /Personal prompt drafts are not shared Project v19 fields/);
    return true;
  });
});
