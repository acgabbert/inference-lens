import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { browserMigrationCompletionStorage, browserMigrationStorage, browserWorkbenchStorage } from "../app/workbench-directory.client.ts";
import { openProjectFolder, ProjectHandleInvalidatedError, ProjectManifestConflictError, saveProjectWorkspace } from "../app/project-workspace.client.ts";
import { prepareSharedProjectMigration, stageSharedProjectMigration } from "../packages/core/src/migration-journal.ts";
import type { PreparedSharedProjectMigration } from "../packages/core/src/migration-journal.ts";
import { completeSharedProjectMigration } from "../packages/core/src/migration-completion.ts";
import type { MigrationCompletionPlan, MigrationCompletionStorage } from "../packages/core/src/migration-completion.ts";
import { parseWorkbenchRecordJson, serializeWorkbenchRecord } from "../packages/core/src/personal-workbench.ts";
import { parseProjectJson } from "../packages/core/src/project.ts";
import { openWorkbenchStore } from "../packages/core/src/workbench-store.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { ByteDirectory } from "./migration-directory-helpers.ts";

const source = new Uint8Array(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const text = (bytes: Uint8Array | undefined) => bytes === undefined ? undefined : new TextDecoder().decode(bytes);

interface Staged {
  directory: ByteDirectory;
  prepared: PreparedSharedProjectMigration;
  shared: Uint8Array;
  /** Workbench-relative destination and the staged bytes it must receive, in journal order. */
  activations: { destination: string; bytes: Uint8Array }[];
}
async function staged(): Promise<Staged> {
  const directory = new ByteDirectory();
  directory.seed("project.json", source);
  const prepared = await prepareSharedProjectMigration(source);
  assert.equal((await stageSharedProjectMigration(browserMigrationStorage(directory), prepared)).kind, "staged");
  directory.writes = [];
  const root = `migrations/${prepared.operationId}/`;
  const candidates = prepared.files.filter(file => file.path.startsWith(`${root}candidates/`));
  // Journal order: selections first, then drafts.
  const activations = candidates.map(file => {
    const name = file.path.slice(`${root}candidates/`.length);
    return { destination: name === "selections.json" ? name : `drafts/${name}`, bytes: file.bytes };
  });
  assert.ok(activations.length > 1, "fixture must stage at least one draft");
  return { directory, prepared, shared: prepared.files[2].bytes, activations };
}
const adapter = (setup: Staged, onSharedAttempt = () => {}) => browserMigrationCompletionStorage(setup.directory, setup.prepared.projectId, onSharedAttempt);
const complete = (setup: Staged, storage: MigrationCompletionStorage = adapter(setup)) => completeSharedProjectMigration(storage, setup.prepared.projectId, setup.prepared.operationId);
function assertStagingUntouched(setup: Staged) {
  for (const file of setup.prepared.files) assert.deepEqual(setup.directory.files.get(`.workbench/${file.path}`), file.bytes, `${file.path} must be preserved`);
}
async function withDirectoryPicker<T>(directory: ByteDirectory, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { showDirectoryPicker: async () => directory } });
  try { return await run(); } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
async function openHandle(directory: ByteDirectory) {
  const opened = await withDirectoryPicker(directory, () => openProjectFolder());
  assert.ok(opened);
  return opened;
}

test("browser completion writes the exact shared manifest, then each absent candidate, byte for byte", async () => {
  const setup = await staged();
  const outcome = await complete(setup);
  assert.equal(text(setup.directory.files.get("project.json")), text(setup.shared));
  assert.deepEqual(setup.directory.files.get("project.json"), setup.shared);
  for (const item of setup.activations) assert.deepEqual(setup.directory.files.get(`.workbench/${item.destination}`), item.bytes, item.destination);
  assert.deepEqual(setup.directory.writes, ["project.json", ...setup.activations.map(item => `.workbench/${item.destination}`)]);
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.equal(outcome.shared, "confirmed-shared");
    assert.equal(outcome.personal.status, "complete");
    assert.deepEqual(outcome.personal.activated, setup.activations.map(item => item.destination));
  }
  assertStagingUntouched(setup);
});

test("repeated browser completion writes nothing and stays complete", async () => {
  const setup = await staged();
  await complete(setup);
  const writes = setup.directory.writes.length;
  const again = await complete(setup);
  assert.equal(setup.directory.writes.length, writes);
  assert.equal(again.kind === "completed" && again.personal.status, "complete");
});

test("existing selections and a competing draft are preserved while other candidates activate", async () => {
  const setup = await staged();
  const [selections, draft, ...rest] = setup.activations;
  const existing = parseWorkbenchRecordJson(text(selections.bytes)!, setup.prepared.projectId);
  const existingBytes = new TextEncoder().encode(serializeWorkbenchRecord({ ...existing, decision: undefined, chat: { execution: { options: { temperature: 0.1 } } } } as typeof existing));
  assert.notDeepEqual(existingBytes, selections.bytes);
  setup.directory.seed(`.workbench/${selections.destination}`, existingBytes);
  const competing = new TextEncoder().encode(JSON.stringify(JSON.parse(text(draft.bytes)!)));
  setup.directory.seed(`.workbench/${draft.destination}`, competing);
  const outcome = await complete(setup);
  assert.deepEqual(setup.directory.files.get(`.workbench/${selections.destination}`), existingBytes);
  assert.deepEqual(setup.directory.files.get(`.workbench/${draft.destination}`), competing);
  for (const item of rest) assert.deepEqual(setup.directory.files.get(`.workbench/${item.destination}`), item.bytes);
  assert.equal(outcome.kind === "completed" && outcome.personal.status, "recovery-pending");
  assertStagingUntouched(setup);
});

test("a completion attempt invalidates the originating handle's saves without adopting v19", async () => {
  const setup = await staged();
  const opened = await openHandle(setup.directory);
  const outcome = await complete(setup, opened.handle.storage.migrationCompletion);
  assert.equal(outcome.kind === "completed" && outcome.shared, "confirmed-shared");
  await assert.rejects(saveProjectWorkspace(opened.handle, { ...opened.project, name: "Stale v15 save" }), ProjectHandleInvalidatedError);
  assert.deepEqual(setup.directory.files.get("project.json"), setup.shared);
});

test("an uncertain manifest write that left the source in place still invalidates the handle", async () => {
  const setup = await staged();
  const opened = await openHandle(setup.directory);
  setup.directory.failPath = "project.json";
  const outcome = await complete(setup, opened.handle.storage.migrationCompletion);
  setup.directory.failPath = undefined;
  assert.equal(outcome.kind === "completed" && outcome.shared, "uncertain");
  assert.deepEqual(setup.directory.files.get("project.json"), source);
  await assert.rejects(saveProjectWorkspace(opened.handle, { ...opened.project, name: "Stale v15 save" }), ProjectHandleInvalidatedError);
  assert.deepEqual(setup.directory.files.get("project.json"), source);
});

test("recognizing an already-written shared manifest invalidates the handle", async () => {
  const setup = await staged();
  const opened = await openHandle(setup.directory);
  setup.directory.seed("project.json", setup.shared);
  const outcome = await complete(setup, opened.handle.storage.migrationCompletion);
  assert.equal(outcome.kind === "completed" && outcome.shared, "confirmed-shared");
  assert.equal(setup.directory.writes.includes("project.json"), false);
  await assert.rejects(saveProjectWorkspace(opened.handle, { ...opened.project, name: "Stale v15 save" }), ProjectHandleInvalidatedError);
});

test("a stale plan writes nothing and leaves the handle able to save", async () => {
  const setup = await staged();
  const opened = await openHandle(setup.directory);
  const storage = opened.handle.storage.migrationCompletion;
  const draft = setup.activations[1];
  const outcome = await complete(setup, {
    read: () => storage.read(),
    execute: plan => {
      // Another origin writes a draft between the preview read and the coordinated write.
      setup.directory.seed(`.workbench/${draft.destination}`, draft.bytes);
      return storage.execute(plan);
    },
  });
  assert.deepEqual(outcome, { kind: "stale-plan" });
  assert.deepEqual(setup.directory.writes, []);
  assert.deepEqual(setup.directory.files.get("project.json"), source);
  await saveProjectWorkspace(opened.handle, { ...opened.project, name: "Still v15" });
  assert.equal(parseProjectJson(text(setup.directory.files.get("project.json"))!).name, "Still v15");
});

test("missing or customized protection blocks before any write and is never repaired", async () => {
  for (const protection of ["missing", "customized"]) {
    const setup = await staged();
    const opened = await openHandle(setup.directory);
    if (protection === "missing") setup.directory.files.delete(".workbench/.gitignore");
    else setup.directory.seed(".workbench/.gitignore", "# custom\n");
    const outcome = await complete(setup, opened.handle.storage.migrationCompletion);
    assert.equal(outcome.kind, "blocked", protection);
    if (outcome.kind === "blocked") assert.equal(outcome.reason, "protection", protection);
    assert.deepEqual(setup.directory.writes, [], protection);
    assert.equal(text(setup.directory.files.get(".workbench/.gitignore")), protection === "missing" ? undefined : "# custom\n");
    await saveProjectWorkspace(opened.handle, { ...opened.project, name: "Still v15" });
  }
});

test("every manifest write boundary failure stops before activation and never rolls back", async () => {
  for (const failure of ["write", "read-back", "read-error"]) {
    const setup = await staged();
    if (failure === "write") setup.directory.failPath = "project.json";
    else setup.directory.afterWrite = path => {
      if (path !== "project.json") return;
      if (failure === "read-back") setup.directory.seed(path, "torn");
      // One failed read-back; core's later reinspection reads normally.
      else setup.directory.beforeRead = target => { if (target === path) { setup.directory.beforeRead = undefined; throw new Error("injected read failure"); } };
    };
    const outcome = await complete(setup);
    assert.equal(outcome.kind, "completed", failure);
    if (outcome.kind === "completed") {
      assert.equal(outcome.shared, "uncertain", failure);
      assert.equal(outcome.personal.status, "stopped", failure);
      assert.equal(outcome.personal.stopped?.destination, "project.json", failure);
      assert.equal(outcome.personal.stopped?.phase, failure === "write" ? "write" : "read-back", failure);
      assert.deepEqual(outcome.personal.activated, []);
    }
    for (const item of setup.activations) assert.equal(setup.directory.files.has(`.workbench/${item.destination}`), false, `${failure} ${item.destination}`);
    const expected = failure === "write" ? source : failure === "read-back" ? new TextEncoder().encode("torn") : setup.shared;
    assert.deepEqual(setup.directory.files.get("project.json"), expected, failure);
    assertStagingUntouched(setup);
  }
});

test("every activation boundary failure keeps the shared manifest and earlier records and reports the path", async () => {
  const prototype = await staged();
  for (const [index, target] of prototype.activations.entries()) {
    for (const failure of ["write", "read-back", "read-error"]) {
      const setup = await staged();
      const path = `.workbench/${target.destination}`;
      if (failure === "write") setup.directory.failPath = path;
      else setup.directory.afterWrite = written => {
        if (written !== path) return;
        if (failure === "read-back") setup.directory.seed(path, "torn");
        else setup.directory.beforeRead = read => { if (read === path) { setup.directory.beforeRead = undefined; throw new Error("injected read failure"); } };
      };
      const outcome = await complete(setup);
      const label = `${target.destination} ${failure}`;
      assert.equal(outcome.kind, "completed", label);
      if (outcome.kind === "completed") {
        assert.equal(outcome.shared, "confirmed-shared", label);
        assert.equal(outcome.personal.status, "stopped", label);
        assert.equal(outcome.personal.stopped?.destination, target.destination, label);
        assert.equal(outcome.personal.stopped?.phase, failure === "write" ? "write" : "read-back", label);
        assert.deepEqual(outcome.personal.activated, setup.activations.slice(0, index).map(item => item.destination), label);
      }
      assert.deepEqual(setup.directory.files.get("project.json"), setup.shared, label);
      for (const earlier of setup.activations.slice(0, index)) assert.deepEqual(setup.directory.files.get(`.workbench/${earlier.destination}`), earlier.bytes, label);
      for (const later of setup.activations.slice(index + 1)) assert.equal(setup.directory.files.has(`.workbench/${later.destination}`), false, label);
      assertStagingUntouched(setup);
    }
  }
});

test("each activation rechecks protection, identity, staging, manifest and active inventory", async () => {
  for (const change of ["protection", "identity", "staging", "manifest", "competitor"]) {
    const setup = await staged();
    const [first, second] = setup.activations;
    const stagedPath = `.workbench/${setup.prepared.files[3].path}`;
    setup.directory.afterWrite = path => {
      if (path !== `.workbench/${first.destination}`) return;
      if (change === "protection") setup.directory.seed(".workbench/.gitignore", "# custom\n");
      else if (change === "identity") setup.directory.seed(".workbench/drafts/draft_foreign.json", '{"projectId":"project_foreign"}');
      else if (change === "staging") setup.directory.seed(stagedPath, "damaged");
      else if (change === "manifest") setup.directory.seed("project.json", "later edit");
      else setup.directory.seed(`.workbench/${second.destination}`, "another writer");
    };
    const outcome = await complete(setup);
    assert.equal(outcome.kind, "completed", change);
    if (outcome.kind === "completed") {
      assert.equal(outcome.personal.status, "stopped", change);
      assert.equal(outcome.personal.stopped?.destination, second.destination, change);
      assert.equal(outcome.personal.stopped?.phase, "before-write", change);
    }
    assert.deepEqual(setup.directory.writes, ["project.json", `.workbench/${first.destination}`], change);
    if (change === "competitor") assert.equal(text(setup.directory.files.get(`.workbench/${second.destination}`)), "another writer");
  }
});

test("the host refuses plans that are not bound to the staged operation, before any write", async () => {
  const setup = await staged();
  const storage = adapter(setup);
  let captured: MigrationCompletionPlan | undefined;
  await complete(setup, { read: () => storage.read(), execute: async plan => { captured = plan; return { kind: "stale-plan" }; } });
  assert.ok(captured);
  const plan = captured;
  const encode = (value: string) => new TextEncoder().encode(value);
  const [selections, draft] = plan.activations;
  const tampered: [string, MigrationCompletionPlan][] = [
    ["project", { ...plan, projectId: "project_foreign" as MigrationCompletionPlan["projectId"] }],
    ["operation", { ...plan, operationId: `migration_${"0".repeat(64)}` }],
    ["source", { ...plan, source: encode("{}") }],
    ["shared", { ...plan, shared: encode("{}") }],
    ["bytes", { ...plan, activations: [{ ...selections, bytes: encode("{}") }] }],
    ["destination", { ...plan, activations: [{ ...draft, destination: "selections.json" }] }],
    ["path", { ...plan, activations: [{ ...draft, destination: "../project.json" }] }],
    ["candidate", { ...plan, activations: [{ ...draft, candidate: "journal.json" }] }],
    ["duplicate", { ...plan, activations: [draft, draft] }],
    ["occupied", { ...plan, activations: [selections], expected: { ...plan.expected, files: [...plan.expected.files, { path: "selections.json", bytes: selections.bytes }] } }],
  ];
  for (const [label, candidate] of tampered) {
    await assert.rejects(storage.execute(candidate), /completion plan/i, label);
    assert.deepEqual(setup.directory.writes, [], label);
  }
});

test("completion, recovery writes and ordinary saves from another handle share one Web Lock", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const keys: string[] = [];
  let active = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (key: string, callback: () => Promise<unknown>) => {
    assert.equal(active++, 0, "writers overlapped");
    keys.push(key);
    try { return await callback(); } finally { active--; }
  } } } });
  try {
    for (const order of ["save-first", "completion-first"]) {
      const setup = await staged();
      const completing = await openHandle(setup.directory);
      const other = await openHandle(setup.directory);
      const store = await openWorkbenchStore(browserWorkbenchStorage(setup.directory), setup.prepared.projectId);
      const save = () => saveProjectWorkspace(other.handle, { ...other.project, name: "Other handle" }).then((): unknown => "saved", (error: unknown) => error);
      const completion = () => complete(setup, completing.handle.storage.migrationCompletion);
      let saving: Promise<unknown>;
      let completingPromise: ReturnType<typeof completion>;
      if (order === "save-first") { saving = save(); completingPromise = completion(); }
      else { completingPromise = completion(); saving = save(); }
      // An ordinary recovery write joins the same queue; its own outcome depends on the interleaving.
      const recovery = store.save(planSharedProjectMigration(source).selections);
      const [saved, completed] = await Promise.all([saving, completingPromise, recovery]);
      const manifest = text(setup.directory.files.get("project.json"))!;
      if (saved === "saved") {
        // The v15 save landed first, so completion must not have replaced it or activated anything.
        assert.equal(parseProjectJson(manifest).name, "Other handle", order);
        assert.notEqual(completed.kind === "completed" && completed.shared, "confirmed-shared", order);
        // Selections may come from the interleaved recovery write; drafts only from completion.
        for (const item of setup.activations.slice(1)) assert.equal(setup.directory.files.has(`.workbench/${item.destination}`), false, order);
      } else {
        assert.ok(saved instanceof ProjectManifestConflictError, `${order}: ${String(saved)}`);
        assert.deepEqual(setup.directory.files.get("project.json"), setup.shared, order);
      }
    }
    assert.ok(keys.length >= 6, `${keys.length} coordinated writes`);
    assert.equal(new Set(keys).size, 1, "every writer uses the project's key");
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("actual browser completion output stages only the shared manifest in Git without any bundle ignore policy", async () => {
  const setup = await staged();
  assert.equal((await complete(setup)).kind, "completed");
  const repository = mkdtempSync(join(tmpdir(), "inference-lens-completion-git-"));
  try {
    for (const [path, bytes] of setup.directory.files) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      writeFileSync(join(repository, path), bytes);
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("add", "--all");
    assert.equal(git("diff", "--cached", "--name-only"), "project.json");
    assert.deepEqual(new Uint8Array(readFileSync(join(repository, "project.json"))), setup.shared);
    for (const item of setup.activations) assert.equal(git("check-ignore", `.workbench/${item.destination}`), `.workbench/${item.destination}`);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});
