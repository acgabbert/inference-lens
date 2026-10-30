import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import { createProjectFile, createPromptTemplate, updatePromptTemplateDraft, parseProjectJson, PROJECT_SCHEMA_VERSION } from "../packages/core/src/project.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { serializeSharedProjectFile } from "../packages/core/src/shared-project.ts";
import { legacyContent } from "./project-kind-helpers.ts";
import { prepareSharedProjectMigration, stageSharedProjectMigration, inspectSharedProjectMigration, parseMigrationJournal, serializeMigrationJournal } from "../packages/core/src/migration-journal.ts";
import type { MigrationStorage, MigrationPayload, MigrationSnapshot } from "../packages/core/src/migration-journal.ts";

const source = () => new Uint8Array(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
class Storage implements MigrationStorage {
  manifest: Uint8Array = source();
  files = new Map<string, Uint8Array>();
  async read(): Promise<MigrationSnapshot> { return { manifest: this.manifest, files: [...this.files].map(([path, bytes]) => ({ path, bytes })) }; }
  async stage(_projectId: string, files: MigrationPayload[]) {
    for (const file of files) this.files.set(file.path, new Uint8Array(file.bytes));
    return { kind: "staged" as const };
  }
}
test("staging preserves the exact raw backup bytes without changing the manifest", async () => {
  const storage = new Storage();
  const prepared = await prepareSharedProjectMigration(storage.manifest);
  await stageSharedProjectMigration(storage, prepared);
  assert.deepEqual(storage.files.get(`migrations/${prepared.operationId}/source.project.json`) ?? null, storage.manifest);
});
test("verified staging classifies restart as ready rather than absent", async () => {
  const storage = new Storage();
  const prepared = await prepareSharedProjectMigration(storage.manifest);
  await storage.stage(prepared.projectId, prepared.files);
  assert.equal((await inspectSharedProjectMigration(await storage.read(), prepared.projectId, prepared.operationId)).kind, "ready");
});

test("all staging interruption boundaries remain inspectable and explicit retry is idempotent", async () => {
  const prepared = await prepareSharedProjectMigration(source());
  for (let count = 0; count <= prepared.files.length; count++) {
    const storage = new Storage();
    await storage.stage(prepared.projectId, prepared.files.slice(0, count));
    const actual = await inspectSharedProjectMigration(await storage.read(), prepared.projectId, prepared.operationId);
    assert.equal(actual.kind, count === 0 ? "none" : count === 1 ? "incomplete-intent" : count < prepared.files.length ? "incomplete" : "ready", `boundary ${count}`);
    assert.equal((await stageSharedProjectMigration(storage, prepared)).kind, "staged");
    assert.equal(storage.files.size, prepared.files.length);
    assert.equal((await inspectSharedProjectMigration(await storage.read(), prepared.projectId, prepared.operationId)).kind, "ready");
  }
});
test("every altered, truncated, missing-source or unavailable output requires review", async () => {
  const prepared = await prepareSharedProjectMigration(source());
  for (const file of prepared.files) {
    for (const alteration of ["truncate", "unreadable"]) {
      const storage = new Storage();
      await storage.stage(prepared.projectId, prepared.files);
      const snapshot = await storage.read();
      snapshot.files = snapshot.files.map(item => item.path === file.path ? alteration === "truncate" ? { path: item.path, bytes: new Uint8Array([123]) } : { path: item.path, error: "read failed" } : item);
      assert.equal((await inspectSharedProjectMigration(snapshot, prepared.projectId, prepared.operationId)).kind, "needs-review", `${file.path} ${alteration}`);
    }
  }
  const storage = new Storage();
  await storage.stage(prepared.projectId, prepared.files.slice(1));
  assert.equal((await inspectSharedProjectMigration(await storage.read(), prepared.projectId, prepared.operationId)).kind, "needs-review");
});
test("manifest comparisons distinguish original, published, reformatted and partial bytes", async () => {
  const storage = new Storage();
  const prepared = await prepareSharedProjectMigration(source());
  await storage.stage(prepared.projectId, prepared.files);
  storage.manifest = prepared.files[2].bytes;
  assert.equal((await inspectSharedProjectMigration(await storage.read(), prepared.projectId, prepared.operationId)).kind, "shared-written");
  const alreadyWritten = await stageSharedProjectMigration(storage, prepared);
  assert.equal(alreadyWritten.kind, "blocked");
  if (alreadyWritten.kind === "blocked") assert.equal(alreadyWritten.reason, "shared-written");
  for (const manifest of [new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(source())))), new Uint8Array([123])]) {
    storage.manifest = manifest;
    assert.equal((await inspectSharedProjectMigration(await storage.read(), prepared.projectId, prepared.operationId)).kind, "manifest-diverged");
    assert.equal((await stageSharedProjectMigration(storage, prepared)).kind, "blocked");
  }
});
test("unexpected entries, duplicate files and foreign identities never become ready", async () => {
  const storage = new Storage();
  const prepared = await prepareSharedProjectMigration(source());
  await storage.stage(prepared.projectId, prepared.files);
  const complete = await storage.read();
  for (const extra of [
    { path: `migrations/${prepared.operationId}/unexpected`, bytes: new Uint8Array() },
    prepared.files[0],
    { path: "drafts/draft_foreign.json", bytes: new TextEncoder().encode('{"schemaVersion":99,"projectId":"project_foreign"}') },
    { path: "migrations", error: "inventory unreadable" },
  ]) {
    const actual = await inspectSharedProjectMigration({ ...complete, files: [...complete.files, extra] }, prepared.projectId, prepared.operationId);
    assert.equal(actual.kind, extra.path.includes("foreign") ? "foreign-project" : "needs-review");
  }
});
test("payloads are captured before queuing and modified preparations cannot be staged", async () => {
  const storage = new Storage();
  const prepared = await prepareSharedProjectMigration(source());
  const original = new Uint8Array(prepared.files[0].bytes);
  const pending = stageSharedProjectMigration(storage, prepared);
  prepared.files[0].bytes.fill(0);
  assert.equal((await pending).kind, "staged");
  assert.deepEqual(storage.files.get(prepared.files[0].path), original);
  assert.equal((await stageSharedProjectMigration(storage, prepared)).kind, "failed");
});

test("raw BOM, CRLF, Unicode and JSON order survive preparation byte-for-byte", async () => {
  const text = new TextDecoder().decode(source());
  const raw = new TextEncoder().encode(`\ufeff${text.replaceAll("\n", "\r\n")}`);
  const before = new Uint8Array(raw);
  const prepared = await prepareSharedProjectMigration(raw);
  raw.fill(0);
  assert.deepEqual(prepared.files[0].bytes, before);
  assert.notEqual(prepared.operationId, (await prepareSharedProjectMigration(source())).operationId);
  const plan = planSharedProjectMigration(before);
  assert.equal(new TextDecoder().decode(prepared.files[2].bytes), serializeSharedProjectFile(plan.shared));
  const journal = parseMigrationJournal(JSON.parse(new TextDecoder().decode(prepared.files[1].bytes)), prepared.projectId);
  assert.equal(serializeMigrationJournal(journal), new TextDecoder().decode(prepared.files[1].bytes));
  assert.deepEqual(journal.candidates.map(item => item.kind), ["selections", "draft", "draft"]);
  for (const [index, candidate] of journal.candidates.entries()) {
    const bytes = prepared.files[index + 3].bytes;
    assert.equal(candidate.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(candidate.byteLength, bytes.length);
  }
});
function legacyProject() {
  let project = createProjectFile({ name: "Legacy", idSuffix: "legacy", createdAt: "2026-10-25T12:00:00.000Z", request: {
    provider: "openai-compatible", endpoint: "https://example.com/v1", model: "example", messages: [{ role: "user", content: "Hello" }], capabilities: resolveProviderCapabilities("openai-compatible"),
  } });
  project = createPromptTemplate(project, { name: "Prompt", idSuffix: "legacy", revisionIdSuffix: "legacy", messages: [{ role: "user", content: "{{topic}}" }] });
  return updatePromptTemplateDraft(project, { templateId: "template_legacy", sourceRevisionId: "template-revision_legacy", messages: [{ role: "user", content: "Explain {{topic}}" }], variableDefaults: { topic: "" } });
}
for (const version of [10, 11, 12, 13, 14, 15, 16] as const) {
  test(`preparation and verified restart preserve legacy v${version}`, async () => {
    const current = legacyProject();
    const legacy: Record<string, unknown> = { ...(version < 15 ? legacyContent(current) : current), schemaVersion: version };
    if (version < 13) { delete legacy.decisionRequests; delete legacy.decisionRequestRevisions; }
    if (version < 16) delete legacy.environments;
    if (version === 10) {
      const target: Record<string, unknown> = { ...current.defaults.target };
      delete target.protocol;
      legacy.defaults = { ...current.defaults, target };
      legacy.connectionRequirements = current.connectionRequirements.map(requirement => ({ ...requirement, protocol: "openai-compatible-chat-completions" }));
    }
    const bytes = new TextEncoder().encode(JSON.stringify(legacy));
    const prepared = await prepareSharedProjectMigration(bytes);
    assert.deepEqual(prepared.files[0].bytes, bytes);
    assert.equal(JSON.parse(new TextDecoder().decode(prepared.files[1].bytes)).sourceVersion, version);
    assert.equal((await inspectSharedProjectMigration({ manifest: bytes, files: prepared.files }, prepared.projectId, prepared.operationId)).kind, "ready");
    assert.equal(PROJECT_SCHEMA_VERSION, 16);
    assert.ok(parseProjectJson(new TextDecoder().decode(bytes)).promptTemplates[0].draft);
    assert.throws(() => parseProjectJson(new TextDecoder().decode(prepared.files[2].bytes)), /schema v18 is not supported/);
  });
}
test("compact migration identities use UTF-16 code units and remain stable for long or unusual IDs", async () => {
  for (const id of ["template_" + "a".repeat(400), "template_../雪\ud800", "template_../雪\ud801"]) {
    const project = legacyProject();
    project.promptTemplates[0].id = id as `template_${string}`;
    const original = new TextEncoder().encode(JSON.stringify(project));
    const prepared = await prepareSharedProjectMigration(original);
    const record = JSON.parse(new TextDecoder().decode(prepared.files[4].bytes));
    const expected = createHash("sha256").update("inference-lens:migrated-draft:v1\0").update(Buffer.from(id, "utf16le")).digest("hex");
    assert.equal(record.draftId, `draft_migrated-${expected}`);
    assert.equal(record.asset.id, id);
    for (const file of prepared.files) for (const part of file.path.split("/")) assert.ok(Buffer.byteLength(part) < 255);
    const logical = planSharedProjectMigration(original).drafts[0];
    assert.notEqual(logical.draftId, record.draftId);
    assert.deepEqual({ ...record, draftId: logical.draftId }, logical);
    assert.deepEqual((await prepareSharedProjectMigration(original)).files, prepared.files);
  }
});
test("strict journals reject unknown fields, versions, duplicate identities and unsafe paths", async () => {
  const prepared = await prepareSharedProjectMigration(source());
  const journal = JSON.parse(new TextDecoder().decode(prepared.files[1].bytes));
  for (const change of [
    { ...journal, schemaVersion: 2 }, { ...journal, extra: "unknown" }, { ...journal, operationId: "migration_" + "0".repeat(64) },
    { ...journal, candidates: [...journal.candidates, journal.candidates[1]] },
    { ...journal, candidates: journal.candidates.slice(1) },
    { ...journal, source: { ...journal.source, byteLength: -1 } },
    { ...journal, candidates: [{ ...journal.candidates[0], path: "../../project.json" }, ...journal.candidates.slice(1)] },
  ]) assert.throws(() => parseMigrationJournal(change));
  assert.throws(() => parseMigrationJournal(journal, "project_foreign"), /different project/);
});
test("self-consistent edited journal descriptors still fail source reconstruction", async () => {
  const prepared = await prepareSharedProjectMigration(source());
  const files = structuredClone(prepared.files);
  const changed = JSON.parse(new TextDecoder().decode(files[4].bytes));
  changed.edited.variableDefaults = {};
  files[4].bytes = new TextEncoder().encode(JSON.stringify(changed));
  const journal = JSON.parse(new TextDecoder().decode(files[1].bytes));
  journal.candidates[1].sha256 = createHash("sha256").update(files[4].bytes).digest("hex");
  journal.candidates[1].byteLength = files[4].bytes.length;
  files[1].bytes = new TextEncoder().encode(serializeMigrationJournal(parseMigrationJournal(journal)));
  assert.equal((await inspectSharedProjectMigration({ manifest: source(), files }, prepared.projectId, prepared.operationId)).kind, "needs-review");
});

test("draft-free projects stage only selections and failed inspections never claim readiness", async () => {
  const project = legacyProject();
  delete project.promptTemplates[0].draft;
  const raw = new TextEncoder().encode(JSON.stringify(project));
  const prepared = await prepareSharedProjectMigration(raw);
  assert.equal(prepared.files.length, 4);
  assert.equal((await inspectSharedProjectMigration({ manifest: raw, files: prepared.files }, prepared.projectId, prepared.operationId)).kind, "ready");
  const storage = new Storage();
  storage.read = async () => { throw new Error("could not enumerate store"); };
  assert.equal((await stageSharedProjectMigration(storage, await prepareSharedProjectMigration(source()))).kind, "failed");
});

test("an operation directory replaced by a file requires review rather than appearing absent", async () => {
  const prepared = await prepareSharedProjectMigration(source());
  const files = [{ path: `migrations/${prepared.operationId}`, bytes: new TextEncoder().encode("unexpected file") }];
  assert.equal((await inspectSharedProjectMigration({ manifest: source(), files }, prepared.projectId, prepared.operationId)).kind, "needs-review");
});
