import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  inspectSharedProjectMigration,
  parseMigrationResolutions,
  prepareSharedProjectMigration,
} from "../packages/core/src/migration-journal.ts";
import type { MigrationFile, MigrationResolutionsV1, MigrationSnapshot, PreparedSharedProjectMigration } from "../packages/core/src/migration-journal.ts";
import { inspectSharedProjectMigrationCompletion } from "../packages/core/src/migration-completion.ts";
import {
  assessMigrationRecovery,
  markMigrationBackupRemoval,
  migrationReplacedCopyPath,
  removableMigrationOperation,
  settleMigrationCandidate,
} from "../packages/core/src/migration-recovery.ts";
import { parseWorkbenchRecordJson, serializeWorkbenchRecord } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchDraftV1 } from "../packages/core/src/personal-workbench.ts";

const source = new Uint8Array(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const NOW = "2026-11-04T12:00:00.000Z";

interface Fixture {
  prepared: PreparedSharedProjectMigration;
  root: string;
  shared: Uint8Array;
  /** Candidate path (relative to the operation) to its active destination and bytes. */
  candidates: { candidate: string; destination: string; bytes: Uint8Array }[];
}
async function fixture(): Promise<Fixture> {
  const prepared = await prepareSharedProjectMigration(source);
  const root = `migrations/${prepared.operationId}/`;
  const candidates = prepared.files.filter((file) => file.path.startsWith(`${root}candidates/`)).map((file) => {
    const candidate = file.path.slice(root.length);
    const name = candidate.slice("candidates/".length);
    return { candidate, destination: name === "selections.json" ? name : `drafts/${name}`, bytes: file.bytes };
  });
  assert.ok(candidates.length > 1, "fixture stages at least one draft");
  return { prepared, root, shared: prepared.files[2].bytes, candidates };
}
function snapshot(setup: Fixture, manifest: Uint8Array | null, active: MigrationFile[], extra: MigrationFile[] = []): MigrationSnapshot {
  return { manifest, files: [...setup.prepared.files.map((file) => ({ path: file.path, bytes: file.bytes })), ...extra, ...active] };
}
const activated = (setup: Fixture) => setup.candidates.map(({ destination, bytes }) => ({ path: destination, bytes }));
const draftCandidate = (setup: Fixture) => setup.candidates.find(({ candidate }) => candidate !== "candidates/selections.json")!;
const edited = (bytes: Uint8Array): Uint8Array => {
  const record = parseWorkbenchRecordJson(decode(bytes), undefined) as WorkbenchDraftV1;
  return encode(serializeWorkbenchRecord({ ...record, edited: { ...record.edited, revisionName: "Edited after the upgrade" } } as WorkbenchDraftV1));
};
const resolutionsFile = (setup: Fixture, value: unknown): MigrationFile => ({ path: `${setup.root}resolutions.json`, bytes: encode(JSON.stringify(value)) });

test("settling a candidate or keeping a replaced copy never reads as a damaged staging", async () => {
  const setup = await fixture();
  const draft = draftCandidate(setup);
  const resolutions = settleMigrationCandidate(undefined, {
    projectId: setup.prepared.projectId, operationId: setup.prepared.operationId,
    candidate: draft.candidate, outcome: "used", settledAt: NOW,
    replacedCopy: migrationReplacedCopyPath(setup.prepared.operationId, "draft_older"),
  });
  const extra = [
    resolutionsFile(setup, resolutions),
    { path: `${setup.root}replaced/draft_older.json`, bytes: draft.bytes },
  ];
  const before = snapshot(setup, source, [], extra);
  assert.equal((await inspectSharedProjectMigration(before, setup.prepared.projectId, setup.prepared.operationId)).kind, "ready");
  const after = snapshot(setup, setup.shared, activated(setup), extra);
  assert.equal((await inspectSharedProjectMigrationCompletion(after, setup.prepared.projectId, setup.prepared.operationId)).kind, "shared-written");
});

test("a replaced copy is a draft inside its own operation; selections never get one (W2)", () => {
  const operationId = `migration_${"a".repeat(64)}`;
  const base = { schemaVersion: 1, kind: "migration-resolutions", projectId: "project_example", operationId };
  const entry = { candidate: "candidates/selections.json", outcome: "used", settledAt: NOW };
  assert.throws(() => parseMigrationResolutions({ ...base, resolutions: [{ ...entry, replacedCopy: `migrations/${operationId}/replaced/selections.json` }] }), /replaced copy/i);
  assert.doesNotThrow(() => parseMigrationResolutions({ ...base, resolutions: [{ ...entry, replacedCopy: `migrations/${operationId}/replaced/draft_x.json` }] }));
});

test("candidates whose exact bytes are active are reported for recording as used, after the manifest moves on", async () => {
  const setup = await fixture();
  const diverged = encode(`${decode(setup.shared)} `);
  const inventory = await assessMigrationRecovery(snapshot(setup, diverged, activated(setup)), setup.prepared.projectId);
  assert.deepEqual(inventory.unreadable, []);
  const [operation] = inventory.operations;
  assert.equal(operation.operationId, setup.prepared.operationId);
  assert.deepEqual(operation.present.sort(), setup.candidates.map(({ candidate }) => candidate).sort());
  assert.deepEqual(operation.pending, []);
  assert.equal(removableMigrationOperation(operation), false, "present candidates are recorded before the backup can go");
});

test("a candidate recorded as used stays settled after its draft is edited or published", async () => {
  const setup = await fixture();
  const draft = draftCandidate(setup);
  let resolutions: MigrationResolutionsV1 | undefined;
  for (const { candidate } of setup.candidates) {
    resolutions = settleMigrationCandidate(resolutions, { projectId: setup.prepared.projectId, operationId: setup.prepared.operationId, candidate, outcome: "used", settledAt: NOW });
  }
  const others = activated(setup).filter(({ path }) => path !== draft.destination);
  for (const active of [[...others, { path: draft.destination, bytes: edited(draft.bytes) }], others]) {
    const [operation] = (await assessMigrationRecovery(snapshot(setup, encode("{}"), active, [resolutionsFile(setup, resolutions)]), setup.prepared.projectId)).operations;
    assert.deepEqual(operation.pending, []);
    assert.deepEqual(operation.present, []);
    assert.equal(removableMigrationOperation(operation), true);
  }
});

test("absent, competing and existing-selections candidates are pending; absent ones wait for Finish while the manifest is the upgrade's output", async () => {
  const setup = await fixture();
  const draft = draftCandidate(setup);
  const record = parseWorkbenchRecordJson(decode(draft.bytes), setup.prepared.projectId) as WorkbenchDraftV1;
  const otherSelections = encode(serializeWorkbenchRecord({ schemaVersion: 1, kind: "selections", projectId: setup.prepared.projectId }));
  const rival = encode(serializeWorkbenchRecord({ ...record, draftId: "draft_rival", edited: { ...record.edited, revisionName: "Rival" } } as WorkbenchDraftV1));
  const diverged = encode("{}");

  const absent = await assessMigrationRecovery(snapshot(setup, diverged, []), setup.prepared.projectId);
  assert.deepEqual(absent.operations[0].pending.map(({ candidate, state }) => [candidate, state]).sort(),
    setup.candidates.map(({ candidate }) => [candidate, "absent"]).sort());
  assert.equal(absent.operations[0].unfinished, false);

  const unfinished = await assessMigrationRecovery(snapshot(setup, setup.shared, []), setup.prepared.projectId);
  assert.equal(unfinished.operations[0].unfinished, true);
  assert.deepEqual(unfinished.operations[0].pending, []);

  const competing = await assessMigrationRecovery(snapshot(setup, diverged, [
    { path: "selections.json", bytes: otherSelections },
    { path: "drafts/draft_rival.json", bytes: rival },
  ]), setup.prepared.projectId);
  const pending = competing.operations[0].pending;
  const selections = pending.find(({ kind }) => kind === "selections")!;
  assert.equal(selections.state, "existing-selections");
  assert.equal(selections.competitor, "selections.json");
  const competitor = pending.find(({ candidate }) => candidate === draft.candidate)!;
  assert.equal(competitor.state, "competing");
  assert.equal(competitor.competitor, "drafts/draft_rival.json");
  assert.deepEqual(competitor.record, record);

  const occupied = await assessMigrationRecovery(snapshot(setup, diverged, [{ path: draft.destination, bytes: rival.slice(0) }].map((file) => ({
    ...file, bytes: encode(serializeWorkbenchRecord({ ...record, edited: { ...record.edited, revisionName: "Same id, other content" } } as WorkbenchDraftV1)),
  }))), setup.prepared.projectId);
  const same = occupied.operations[0].pending.find(({ candidate }) => candidate === draft.candidate)!;
  assert.equal(same.state, "competing");
  assert.equal(same.competitor, draft.destination);

  const unreadable = await assessMigrationRecovery(snapshot(setup, diverged, [{ path: "drafts/draft_broken.json", error: "denied" }]), setup.prepared.projectId);
  assert.equal(unreadable.operations[0].pending.find(({ candidate }) => candidate === draft.candidate)!.state, "unavailable");
});

test("settled candidates are no longer pending, and the backup is removable once nothing is", async () => {
  const setup = await fixture();
  let resolutions: MigrationResolutionsV1 | undefined;
  for (const { candidate } of setup.candidates) {
    resolutions = settleMigrationCandidate(resolutions, { projectId: setup.prepared.projectId, operationId: setup.prepared.operationId, candidate, outcome: "discarded", settledAt: NOW });
  }
  assert.throws(() => settleMigrationCandidate(resolutions, {
    projectId: setup.prepared.projectId, operationId: setup.prepared.operationId, candidate: setup.candidates[0].candidate, outcome: "used", settledAt: NOW,
  }), /once/);
  const [operation] = (await assessMigrationRecovery(snapshot(setup, encode("{}"), [], [resolutionsFile(setup, resolutions)]), setup.prepared.projectId)).operations;
  assert.deepEqual(operation.pending, []);
  assert.equal(removableMigrationOperation(operation), true);
  assert.deepEqual(operation.files.sort(), [...setup.prepared.files.map(({ path }) => path), `${setup.root}resolutions.json`].sort());
});

test("a removal intent reads as an interrupted removal, whatever is left of the operation", async () => {
  const setup = await fixture();
  const intent = markMigrationBackupRemoval(undefined, { projectId: setup.prepared.projectId, operationId: setup.prepared.operationId, at: NOW });
  assert.equal(intent.backupRemovedAt, NOW);
  const partial: MigrationSnapshot = { manifest: encode("{}"), files: [resolutionsFile(setup, intent), { path: `${setup.root}candidates/selections.json`, bytes: encode("leftover") }] };
  const [operation] = (await assessMigrationRecovery(partial, setup.prepared.projectId)).operations;
  assert.equal(operation.removing, true);
  assert.deepEqual(operation.pending, []);
  assert.equal(removableMigrationOperation(operation), true);
});

test("an operation that cannot be verified against its source is unreadable, and nothing is offered from it", async () => {
  const setup = await fixture();
  const tampered = snapshot(setup, encode("{}"), []);
  const draft = draftCandidate(setup);
  tampered.files = tampered.files.map((file) => file.path === `${setup.root}${draft.candidate}` ? { path: file.path, bytes: edited(draft.bytes) } : file);
  const inventory = await assessMigrationRecovery(tampered, setup.prepared.projectId);
  assert.deepEqual(inventory.operations, []);
  assert.equal(inventory.unreadable.length, 1);
  assert.equal(inventory.unreadable[0].path, `migrations/${setup.prepared.operationId}`);

  const badResolutions = snapshot(setup, encode("{}"), [], [{ path: `${setup.root}resolutions.json`, bytes: encode("{") }]);
  const unreadable = await assessMigrationRecovery(badResolutions, setup.prepared.projectId);
  assert.deepEqual(unreadable.operations, []);
  assert.equal(unreadable.unreadable[0].path, `${setup.root}resolutions.json`);
});
