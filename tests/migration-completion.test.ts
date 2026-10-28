import type { ProjectId } from "../packages/core/src/run-kernel/types.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareSharedProjectMigration, sameMigrationBytes } from "../packages/core/src/migration-journal.ts";
import type { MigrationSnapshot } from "../packages/core/src/migration-journal.ts";
import { completeSharedProjectMigration, inspectSharedProjectMigrationCompletion } from "../packages/core/src/migration-completion.ts";
import type { MigrationCompletionHostResult, MigrationCompletionPlan, MigrationCompletionStorage } from "../packages/core/src/migration-completion.ts";
import { parseWorkbenchRecordJson, serializeWorkbenchRecord } from "../packages/core/src/personal-workbench.ts";

const source = () => new Uint8Array(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (value: string) => new TextEncoder().encode(value);

interface Faults {
  manifest?: "error-before-write" | "error-after-write" | "read-back-mismatch";
  failActivation?: { destination: string; phase: "write" | "read-back" };
  unprotected?: boolean;
  beforeExecute?: (storage: Host) => void;
}
class Host implements MigrationCompletionStorage {
  manifest: Uint8Array | null = source();
  files = new Map<string, Uint8Array>();
  unreadable = new Set<string>();
  executions: MigrationCompletionPlan[] = [];
  faults: Faults;
  constructor(faults: Faults = {}) { this.faults = faults; }
  async read(): Promise<MigrationSnapshot> {
    return { manifest: this.manifest && new Uint8Array(this.manifest), files: [...this.files].map(([path, bytes]) => this.unreadable.has(path) ? { path, error: "unreadable" } : { path, bytes: new Uint8Array(bytes) }) };
  }
  async execute(plan: MigrationCompletionPlan): Promise<MigrationCompletionHostResult> {
    this.faults.beforeExecute?.(this);
    this.executions.push(plan);
    const current = await this.read();
    const same = current.files.length === plan.expected.files.length && sameMigrationBytes(current.manifest, plan.expected.manifest)
      && current.files.every((file, index) => { const other = plan.expected.files[index]; return other.path === file.path && ("bytes" in file ? "bytes" in other && sameMigrationBytes(file.bytes, other.bytes) : "error" in other); });
    if (!same) return { kind: "stale-plan" };
    if (this.faults.unprotected) return { kind: "blocked", reason: "protection", message: "Protection is missing." };
    let manifest: "written" | "already-shared" | "failed" = "already-shared";
    if (sameMigrationBytes(this.manifest, plan.source)) {
      if (this.faults.manifest === "error-before-write") return { kind: "executed", manifest: "failed", activated: [], stopped: { destination: "project.json", phase: "write", message: "write failed" } };
      this.manifest = new Uint8Array(plan.shared);
      if (this.faults.manifest === "error-after-write") return { kind: "executed", manifest: "failed", activated: [], stopped: { destination: "project.json", phase: "write", message: "interrupted" } };
      if (this.faults.manifest === "read-back-mismatch") { this.manifest = new Uint8Array(plan.shared).fill(32, 0, 1); return { kind: "executed", manifest: "failed", activated: [], stopped: { destination: "project.json", phase: "read-back", message: "mismatch" } }; }
      manifest = "written";
    }
    const activated: string[] = [];
    for (const item of plan.activations) {
      if (this.files.has(item.destination)) return { kind: "executed", manifest, activated, stopped: { destination: item.destination, phase: "before-write", message: "destination appeared" } };
      if (this.faults.failActivation?.destination === item.destination) {
        if (this.faults.failActivation.phase === "write") return { kind: "executed", manifest, activated, stopped: { destination: item.destination, phase: "write", message: "write failed" } };
        this.files.set(item.destination, new Uint8Array([0]));
        return { kind: "executed", manifest, activated, stopped: { destination: item.destination, phase: "read-back", message: "mismatch" } };
      }
      this.files.set(item.destination, new Uint8Array(item.bytes));
      activated.push(item.destination);
    }
    return { kind: "executed", manifest, activated };
  }
}
async function staged(faults: Faults = {}) {
  const host = new Host(faults);
  const prepared = await prepareSharedProjectMigration(source());
  for (const file of prepared.files) host.files.set(file.path, new Uint8Array(file.bytes));
  const root = `migrations/${prepared.operationId}/`;
  const bytes = (path: string) => prepared.files.find(file => file.path === `${root}${path}`)!.bytes;
  const journal = JSON.parse(text(bytes("journal.json")));
  const drafts: { draftId: string; assetId: string; candidate: string; destination: string }[] = journal.candidates.slice(1).map((item: { draftId: string; asset: { id: string }; path: string }) => ({ draftId: item.draftId, assetId: item.asset.id, candidate: item.path, destination: `drafts/${item.draftId}.json` }));
  return { host, prepared, root, bytes, drafts, shared: bytes("shared.project.json"), selections: bytes("candidates/selections.json") };
}
const complete = (host: Host, prepared: { projectId: ProjectId; operationId: string }) => completeSharedProjectMigration(host, prepared.projectId, prepared.operationId);
function assertCompleted(outcome: Awaited<ReturnType<typeof complete>>) {
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  if (outcome.kind !== "completed") throw new Error("unreachable");
  return outcome;
}
function assertStagingUntouched(setup: Awaited<ReturnType<typeof staged>>) {
  for (const file of setup.prepared.files) assert.deepEqual(setup.host.files.get(file.path), file.bytes, `${file.path} must be preserved`);
}

test("completion writes the exact shared manifest, then activates every absent candidate byte-for-byte", async () => {
  const setup = await staged();
  const outcome = assertCompleted(await complete(setup.host, setup.prepared));
  assert.equal(text(setup.host.manifest!), text(setup.shared));
  assert.equal(outcome.shared, "confirmed-shared");
  assert.equal(outcome.personal.status, "complete");
  assert.deepEqual(setup.host.files.get("selections.json"), setup.selections);
  for (const draft of setup.drafts) assert.deepEqual(setup.host.files.get(draft.destination), setup.bytes(draft.candidate));
  assertStagingUntouched(setup);
});

test("repeated explicit completion neither rewrites the manifest nor duplicates records", async () => {
  const setup = await staged();
  assertCompleted(await complete(setup.host, setup.prepared));
  const before = new Map(setup.host.files);
  const second = assertCompleted(await complete(setup.host, setup.prepared));
  assert.equal(second.shared, "confirmed-shared");
  assert.equal(second.personal.status, "complete");
  assert.deepEqual(setup.host.executions[1].activations, []);
  assert.deepEqual([...setup.host.files.keys()].sort(), [...before.keys()].sort());
  assert.equal(text(setup.host.manifest!), text(setup.shared));
});

test("restart with the shared manifest present and no active records activates only absent records", async () => {
  const setup = await staged();
  setup.host.manifest = new Uint8Array(setup.shared);
  setup.host.files.set(setup.drafts[0].destination, new Uint8Array(setup.bytes(setup.drafts[0].candidate)));
  const outcome = assertCompleted(await complete(setup.host, setup.prepared));
  assert.deepEqual(setup.host.executions[0].activations.map(item => item.destination).sort(), ["selections.json", setup.drafts[1].destination].sort());
  assert.equal(outcome.personal.status, "complete");
});

test("existing valid selections are preserved and never seeded over", async () => {
  const setup = await staged();
  const existing = parseWorkbenchRecordJson(text(setup.selections), setup.prepared.projectId);
  const different = encode(serializeWorkbenchRecord({ ...existing, decision: undefined, chat: { execution: { options: { temperature: 0.1 } } } } as typeof existing));
  assert.notDeepEqual(different, setup.selections);
  setup.host.files.set("selections.json", different);
  const outcome = assertCompleted(await complete(setup.host, setup.prepared));
  assert.deepEqual(setup.host.files.get("selections.json"), different);
  assert.equal(outcome.personal.candidates.find(item => item.kind === "selections")?.disposition, "existing-selections");
  assert.equal(outcome.personal.status, "complete");
  assert.deepEqual(setup.host.files.get(`migrations/${setup.prepared.operationId}/candidates/selections.json`), setup.selections);
});

test("a differing draft at the destination stays pending beside its staged candidate", async () => {
  const setup = await staged();
  const [first] = setup.drafts;
  const reformatted = encode(JSON.stringify(JSON.parse(text(setup.bytes(first.candidate)))));
  setup.host.files.set(first.destination, reformatted);
  const outcome = assertCompleted(await complete(setup.host, setup.prepared));
  assert.equal(outcome.shared, "confirmed-shared");
  assert.equal(outcome.personal.status, "recovery-pending");
  assert.deepEqual(setup.host.files.get(first.destination), reformatted);
  assert.equal(outcome.personal.candidates.find(item => item.candidate === first.candidate)?.disposition, "pending-draft");
  assert.deepEqual(setup.host.files.get(setup.drafts[1].destination), setup.bytes(setup.drafts[1].candidate));
  assertStagingUntouched(setup);
});

test("another active draft naming the same asset blocks activation without a duplicate", async () => {
  const setup = await staged();
  const [first] = setup.drafts;
  const competing = { ...JSON.parse(text(setup.bytes(first.candidate))), draftId: "draft_user-made" };
  setup.host.files.set("drafts/draft_user-made.json", encode(serializeWorkbenchRecord(competing)));
  const outcome = assertCompleted(await complete(setup.host, setup.prepared));
  assert.equal(outcome.personal.candidates.find(item => item.candidate === first.candidate)?.disposition, "pending-draft");
  assert.equal(setup.host.files.has(first.destination), false);
  assert.equal(outcome.personal.status, "recovery-pending");
});

test("corrupt selections are unavailable, preserved and never reported as satisfied", async () => {
  const setup = await staged();
  setup.host.files.set("selections.json", encode("{broken"));
  const outcome = assertCompleted(await complete(setup.host, setup.prepared));
  assert.deepEqual(setup.host.files.get("selections.json"), encode("{broken"));
  assert.equal(outcome.personal.candidates.find(item => item.kind === "selections")?.disposition, "unavailable");
  assert.notEqual(outcome.personal.status, "complete");
});

test("an unreadable active draft makes every absent draft candidate unavailable but leaves selections eligible", async () => {
  const setup = await staged();
  setup.host.files.set("drafts/draft_other.json", encode("{broken"));
  const outcome = assertCompleted(await complete(setup.host, setup.prepared));
  for (const draft of setup.drafts) {
    assert.equal(outcome.personal.candidates.find(item => item.candidate === draft.candidate)?.disposition, "unavailable");
    assert.equal(setup.host.files.has(draft.destination), false);
  }
  assert.deepEqual(setup.host.files.get("selections.json"), setup.selections);
  assert.notEqual(outcome.personal.status, "complete");
});

test("a snapshot that changes before the host writes returns stale-plan with no mutation", async () => {
  const setup = await staged({ beforeExecute: host => host.files.set("selections.json", encode("{late}")) });
  const outcome = await complete(setup.host, setup.prepared);
  assert.deepEqual(outcome, { kind: "stale-plan" });
  assert.deepEqual(setup.host.manifest, source());
  assert.deepEqual(setup.host.files.get("selections.json"), encode("{late}"));
});

test("a missing protection file blocks before any content write", async () => {
  const setup = await staged({ unprotected: true });
  const outcome = await complete(setup.host, setup.prepared);
  assert.equal(outcome.kind, "blocked");
  assert.equal(outcome.kind === "blocked" && outcome.reason, "protection");
  assert.equal(setup.host.executions.length, 1, "the host must be reached and refuse");
  assert.deepEqual(setup.host.manifest, source());
});

test("a manifest write error is uncertain even when the bytes landed, and nothing is activated or rolled back", async () => {
  for (const manifest of ["error-before-write", "error-after-write", "read-back-mismatch"] as const) {
    const setup = await staged({ manifest });
    const outcome = assertCompleted(await complete(setup.host, setup.prepared));
    assert.equal(outcome.shared, "uncertain", manifest);
    assert.notEqual(outcome.personal.status, "complete", manifest);
    assert.equal(setup.host.files.has("selections.json"), false, manifest);
    assertStagingUntouched(setup);
  }
});

test("an activation that fails stops the batch, keeps earlier activations and reports the path", async () => {
  const setup = await staged();
  setup.host.faults.failActivation = { destination: setup.drafts[0].destination, phase: "write" };
  const outcome = assertCompleted(await complete(setup.host, setup.prepared));
  assert.equal(outcome.shared, "confirmed-shared");
  assert.equal(outcome.personal.status, "stopped");
  assert.equal(outcome.personal.stopped?.destination, setup.drafts[0].destination);
  assert.deepEqual(setup.host.files.get("selections.json"), setup.selections);
  assert.equal(setup.host.files.has(setup.drafts[1].destination), false);
  assert.equal(text(setup.host.manifest!), text(setup.shared));
});

test("a read-back mismatch is reported from reinspection, never as a verified activation", async () => {
  const setup = await staged();
  setup.host.faults.failActivation = { destination: "selections.json", phase: "read-back" };
  const outcome = assertCompleted(await complete(setup.host, setup.prepared));
  assert.equal(outcome.personal.status, "stopped");
  assert.notEqual(outcome.personal.candidates.find(item => item.kind === "selections")?.disposition, "present");
  assert.equal(outcome.personal.activated.includes("selections.json"), false);
});

test("a manifest that matches neither snapshot is diverged and never committed or activated", async () => {
  for (const manifest of [encode(JSON.stringify(JSON.parse(text(source())))), new Uint8Array([123]), null]) {
    const setup = await staged();
    setup.host.manifest = manifest;
    const outcome = await complete(setup.host, setup.prepared);
    assert.equal(outcome.kind, "blocked");
    assert.equal(setup.host.executions.length, 0);
    assert.equal(setup.host.files.has("selections.json"), false);
  }
});

test("completion neither stages nor repairs: absent, incomplete or damaged operations block", async () => {
  const absent = await staged();
  for (const key of [...absent.host.files.keys()]) absent.host.files.delete(key);
  assert.equal((await complete(absent.host, absent.prepared)).kind, "blocked");
  const incomplete = await staged();
  incomplete.host.files.delete(`${incomplete.root}candidates/selections.json`);
  assert.equal((await complete(incomplete.host, incomplete.prepared)).kind, "blocked");
  const damaged = await staged();
  damaged.host.files.set(`${damaged.root}shared.project.json`, new Uint8Array([1]));
  damaged.host.manifest = new Uint8Array(damaged.shared);
  assert.equal((await complete(damaged.host, damaged.prepared)).kind, "blocked", "equal manifest bytes cannot repair damaged staging");
  for (const setup of [absent, incomplete, damaged]) assert.equal(setup.host.executions.length, 0);
  assert.equal(absent.host.files.size, 0);
});

test("a foreign project identity anywhere in the store blocks the operation", async () => {
  const setup = await staged();
  setup.host.files.set("drafts/draft_foreign.json", encode('{"schemaVersion":1,"projectId":"project_foreign"}'));
  const outcome = await complete(setup.host, setup.prepared);
  assert.equal(outcome.kind, "blocked");
  assert.equal(setup.host.executions.length, 0);
});

test("inspection is read-only and exposes per-candidate dispositions before completion", async () => {
  const setup = await staged();
  const snapshot = await setup.host.read();
  const inspection = await inspectSharedProjectMigrationCompletion(snapshot, setup.prepared.projectId, setup.prepared.operationId);
  assert.equal(inspection.kind, "ready");
  if (inspection.kind !== "ready") return;
  assert.deepEqual(inspection.candidates.map(item => item.disposition), ["activate", "activate", "activate"]);
  assert.deepEqual(inspection.candidates.map(item => item.destination), ["selections.json", ...setup.drafts.map(item => item.destination)]);
  assert.deepEqual(setup.host.manifest, source());
  assert.equal(setup.host.executions.length, 0);
});

test("unreadable inventory under the operation or a stale previous inspection is not trusted", async () => {
  const setup = await staged();
  setup.host.unreadable.add(`${setup.root}candidates/selections.json`);
  assert.equal((await complete(setup.host, setup.prepared)).kind, "blocked");
  assert.equal(setup.host.executions.length, 0);
});

test("the plan handed to the host is independent of later mutation of storage buffers", async () => {
  const setup = await staged();
  assertCompleted(await complete(setup.host, setup.prepared));
  const [plan] = setup.host.executions;
  const shared = new Uint8Array(plan.shared);
  setup.host.manifest!.fill(0);
  assert.deepEqual(plan.shared, shared);
});

test("no application or CLI code path references the completion capability", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const { join, relative } = await import("node:path");
  const root = new URL("..", import.meta.url).pathname;
  const allowed = new Set(["packages/core/src/migration-completion.ts"]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", "dist", "target", ".git", "tests", "docs"].includes(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(name) || allowed.has(relative(root, path))) continue;
      if (/migration-completion|completeSharedProjectMigration/.test(readFileSync(path, "utf8"))) offenders.push(relative(root, path));
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], "completion stays opt-in until reconciliation ships");
});
