import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseProjectJson, PROJECT_SCHEMA_VERSION, ProjectValidationError } from "../packages/core/src/project.ts";
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
  const withDraft = parseProjectJson(legacy);
  assert.ok(withDraft.promptTemplates.some((template) => template.draft));
  assert.throws(() => serializeProjectManifest(withDraft), ProjectValidationError);
});
