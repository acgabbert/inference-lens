import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseLegacyProjectJson, parseProjectJson, PROJECT_SCHEMA_VERSION, ProjectValidationError } from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { readProjectManifest, serializeProjectManifest } from "../app/workbench/project-manifest.ts";

const legacy = readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url), "utf8");

test("the app reads a legacy manifest in memory, lifting its prompt drafts out", () => {
  const read = readProjectManifest(legacy);
  assert.deepEqual(read.format, { kind: "legacy", sourceVersion: 15 });
  assert.equal(read.project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.ok(read.project.promptTemplates.every((template) => !("draft" in template) || template.draft === undefined));
  assert.deepEqual(read.personalSeeds.map(({ asset }) => asset.kind).sort(), ["chat-prompt", "decision-prompt"]);
});

test("the app writes v19 and reads it back as the same in-memory document", () => {
  const { project } = readProjectManifest(legacy);
  const written = serializeProjectManifest(project);
  assert.equal(JSON.parse(written).schemaVersion, 19);
  const reread = readProjectManifest(written);
  assert.deepEqual(reread.format, { kind: "shared" });
  assert.deepEqual(reread.personalSeeds, []);
  assert.deepEqual(reread.project, project);
});

test("a stray template draft is a loud error, not a shared leak", () => {
  // The type rules a draft out of the shared document; this is the runtime backstop.
  const withDraft = { ...parseLegacyProjectJson(legacy), schemaVersion: PROJECT_SCHEMA_VERSION } as unknown as ProjectFile;
  assert.ok(withDraft.promptTemplates.some((template) => "draft" in template));
  assert.throws(() => serializeProjectManifest(withDraft), (error: unknown) => {
    assert.ok(error instanceof ProjectValidationError);
    assert.match(error.message, /Personal prompt drafts are not shared Project v19 fields/);
    return true;
  });
});

test("the v19-only parser refuses a legacy document and names the upgrade", () => {
  assert.throws(() => parseProjectJson(legacy), /schema v15 is an older format\. Inference Lens upgrades it to v19/);
});

test("an unsupported version lists every version this build opens, v19 included", () => {
  const { project } = readProjectManifest(legacy);
  const current = JSON.parse(serializeProjectManifest(project));
  for (const schemaVersion of [9, 20]) {
    assert.throws(() => readProjectManifest(JSON.stringify({ ...current, schemaVersion })), (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, new RegExp(`schema v${schemaVersion} is not supported`));
      assert.match(message, /opens schema v10, v11, v12, v13, v14, v15, v16, v17, v18, and v19/);
      assert.match(message, /upgrades v10–v18 to v19/);
      return true;
    });
  }
});
