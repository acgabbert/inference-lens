import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROJECT_SCHEMA_VERSION, ProjectValidationError } from "../packages/core/src/project.ts";
import { readProjectManifest, serializeProjectManifest } from "../app/workbench/project-manifest.ts";

const legacy = readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url), "utf8");

test("a personal session reads a legacy manifest in memory, lifting its prompt drafts out", () => {
  const read = readProjectManifest(legacy, "personal");
  assert.deepEqual(read.format, { kind: "legacy", sourceVersion: 15 });
  assert.equal(read.project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.ok(read.project.promptTemplates.every((template) => !("draft" in template) || template.draft === undefined));
  assert.deepEqual(read.personalSeeds.map(({ asset }) => asset.kind).sort(), ["chat-prompt", "decision-prompt"]);
});

test("a personal session writes v19 and reads it back as the same in-memory document", () => {
  const { project } = readProjectManifest(legacy, "personal");
  const written = serializeProjectManifest(project, "personal");
  assert.equal(JSON.parse(written).schemaVersion, 19);
  const reread = readProjectManifest(written, "personal");
  assert.deepEqual(reread.format, { kind: "shared" });
  assert.deepEqual(reread.personalSeeds, []);
  assert.deepEqual(reread.project, project);
});

test("a stray template draft is a loud error in a personal session, not a shared leak", () => {
  const withDraft = readProjectManifest(legacy, "legacy").project;
  assert.ok(withDraft.promptTemplates.some((template) => template.draft));
  assert.throws(() => serializeProjectManifest(withDraft, "personal"), ProjectValidationError);
});

test("a legacy session still refuses v19, as today's builds do", () => {
  const written = serializeProjectManifest(readProjectManifest(legacy, "personal").project, "personal");
  assert.throws(() => readProjectManifest(written, "legacy"), ProjectValidationError);
  const read = readProjectManifest(legacy, "legacy");
  assert.deepEqual(read.format, { kind: "legacy", sourceVersion: 15 });
  assert.equal(JSON.parse(serializeProjectManifest(read.project, "legacy")).schemaVersion, PROJECT_SCHEMA_VERSION);
});
