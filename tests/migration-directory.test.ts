import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { browserMigrationStorage, browserWorkbenchStorage } from "../app/workbench-directory.client.ts";
import { inspectSharedProjectMigration, prepareSharedProjectMigration, stageSharedProjectMigration } from "../packages/core/src/migration-journal.ts";
import { openWorkbenchStore } from "../packages/core/src/workbench-store.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { ByteDirectory } from "./migration-directory-helpers.ts";
const source = new Uint8Array(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
test("browser staging writes protected untouched bytes and leaves shared and active state alone", async () => {
  const directory = new ByteDirectory();
  directory.seed("project.json", source);
  directory.seed(".workbench/selections.json", "existing selections");
  const prepared = await prepareSharedProjectMigration(source);
  const outcome = await stageSharedProjectMigration(browserMigrationStorage(directory), prepared);
  assert.deepEqual(directory.files.get(`.workbench/${prepared.files[0].path}`) ?? null, source);
  assert.equal(outcome.kind, "staged");
  assert.equal(directory.writes[0], ".workbench/.gitignore");
  assert.deepEqual(directory.files.get("project.json"), source);
  assert.equal(new TextDecoder().decode(directory.files.get(".workbench/selections.json")), "existing selections");
});
test("a foreign staged candidate blocks an ordinary workbench save", async () => {
  const directory = new ByteDirectory();
  const prepared = await prepareSharedProjectMigration(source);
  directory.seed(`.workbench/migrations/${prepared.operationId}/candidates/selections.json`, '{"projectId":"project_foreign"}');
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), prepared.projectId);
  assert.equal((await store.save(planSharedProjectMigration(source).selections)).kind, "blocked");
  assert.deepEqual(directory.writes, []);
});

test("every browser write failure or read-back mismatch preserves prior staged files", async () => {
  const prepared = await prepareSharedProjectMigration(source);
  for (const [index, file] of prepared.files.entries()) {
    for (const failure of ["write", "read-back", "read"]) {
      const directory = new ByteDirectory();
      directory.seed("project.json", source);
      const path = `.workbench/${file.path}`;
      if (failure === "write") directory.failPath = path;
      else directory.afterWrite = written => {
        if (written !== path) return;
        if (failure === "read-back") directory.seed(path, "corrupt");
        else directory.beforeRead = target => { if (target === path) throw new Error("injected read failure"); };
      };
      const result = await stageSharedProjectMigration(browserMigrationStorage(directory), prepared);
      assert.equal(result.kind, failure === "read-back" ? "conflict" : "failed", `${index} ${failure}`);
      for (const previous of prepared.files.slice(0, index)) assert.deepEqual(directory.files.get(`.workbench/${previous.path}`), previous.bytes);
      assert.deepEqual(directory.files.get("project.json"), source);
      assert.equal(directory.files.has(`.workbench/${prepared.files[index + 1]?.path}`), false);
    }
  }
});
test("staging refuses stale bytes, customized or unwritable protection and changed manifest", async () => {
  const prepared = await prepareSharedProjectMigration(source);
  for (const problem of ["protection", "ignore-write", "ignore-readback", "manifest", "stale"]) {
    const directory = new ByteDirectory();
    directory.seed("project.json", source);
    if (problem === "protection") directory.seed(".workbench/.gitignore", "# custom\n");
    if (problem === "ignore-write") directory.failPath = ".workbench/.gitignore";
    if (problem === "ignore-readback") directory.afterWrite = path => { if (path === ".workbench/.gitignore") directory.seed(path, ""); };
    if (problem === "manifest") directory.seed("project.json", "changed");
    if (problem === "stale") directory.seed(`.workbench/${prepared.files[0].path}`, "changed source");
    const result = await stageSharedProjectMigration(browserMigrationStorage(directory), prepared);
    assert.notEqual(result.kind, "staged", problem);
    assert.equal(directory.files.has(`.workbench/${prepared.files[1].path}`), false);
    if (problem === "protection") assert.equal(new TextDecoder().decode(directory.files.get(".workbench/.gitignore")), "# custom\n");
  }
});
test("restart inspection is read-only and repeat staging writes nothing twice", async () => {
  const directory = new ByteDirectory();
  directory.seed("project.json", source);
  const adapter = browserMigrationStorage(directory);
  await adapter.read();
  assert.equal(directory.directories.has(".workbench"), false);
  const prepared = await prepareSharedProjectMigration(source);
  assert.equal((await stageSharedProjectMigration(adapter, prepared)).kind, "staged");
  const count = directory.writes.length;
  assert.equal((await stageSharedProjectMigration(adapter, prepared)).kind, "staged");
  assert.equal(directory.writes.length, count);
});
test("staging rechecks protection, identity and manifest between writes", async () => {
  const prepared = await prepareSharedProjectMigration(source);
  for (const change of ["protection", "identity", "manifest"]) {
    const directory = new ByteDirectory();
    directory.seed("project.json", source);
    directory.afterWrite = path => {
      if (path !== `.workbench/${prepared.files[0].path}`) return;
      if (change === "protection") directory.seed(".workbench/.gitignore", "custom");
      else if (change === "identity") directory.seed(".workbench/drafts/draft_foreign.json", '{"projectId":"project_foreign"}');
      else directory.seed("project.json", "changed");
    };
    const result = await stageSharedProjectMigration(browserMigrationStorage(directory), prepared);
    assert.equal(result.kind, "blocked");
    if (result.kind === "blocked") assert.equal(result.reason, change === "identity" ? "foreign-project" : change === "manifest" ? "manifest-diverged" : "protection");
    assert.equal(directory.files.has(`.workbench/${prepared.files[1].path}`), false);
  }
});
test("unexpected or unreadable nested migration inventory blocks ordinary recovery writes", async () => {
  const directory = new ByteDirectory();
  const prepared = await prepareSharedProjectMigration(source);
  directory.seed(`.workbench/${prepared.files[1].path}`, "{bad");
  directory.beforeRead = path => { if (path.endsWith("journal.json")) throw new Error("unreadable inventory"); };
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), prepared.projectId);
  assert.equal((await store.save(planSharedProjectMigration(source).selections)).kind, "failed");
  assert.deepEqual(directory.writes, []);
});
test("same-host migration and recovery writers use one shared Web Lock", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const keys: string[] = [];
  let active = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (key: string, callback: () => Promise<unknown>) => {
    assert.equal(active++, 0);
    keys.push(key);
    try { return await callback(); } finally { active--; }
  } } } });
  try {
    const directory = new ByteDirectory();
    directory.seed("project.json", source);
    const prepared = await prepareSharedProjectMigration(source);
    const store = await openWorkbenchStore(browserWorkbenchStorage(directory), prepared.projectId);
    const outcomes = await Promise.all([stageSharedProjectMigration(browserMigrationStorage(directory), prepared), store.save(planSharedProjectMigration(source).selections)]);
    assert.deepEqual(outcomes.map(value => value.kind).sort(), ["saved", "staged"]);
    assert.deepEqual(keys, Array(2).fill(`inference-lens:workbench:${prepared.projectId}`));
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});


test("actual browser staging output stays out of Git without any bundle ignore policy", async () => {
  const directory = new ByteDirectory();
  directory.seed("project.json", source);
  const prepared = await prepareSharedProjectMigration(source);
  assert.equal((await stageSharedProjectMigration(browserMigrationStorage(directory), prepared)).kind, "staged");
  const repository = mkdtempSync(join(tmpdir(), "inference-lens-migration-git-"));
  try {
    for (const [path, bytes] of directory.files) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      writeFileSync(join(repository, path), bytes);
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("add", "--all");
    assert.equal(git("diff", "--cached", "--name-only"), "project.json");
    for (const file of prepared.files) assert.equal(git("check-ignore", `.workbench/${file.path}`), `.workbench/${file.path}`);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});
test("two independent checkout stores with one project identity retain separate staged files", async () => {
  const first = new ByteDirectory();
  const second = new ByteDirectory();
  for (const directory of [first, second]) directory.seed("project.json", source);
  const prepared = await prepareSharedProjectMigration(source);
  await stageSharedProjectMigration(browserMigrationStorage(first), prepared);
  assert.equal(second.directories.has(".workbench"), false);
  await stageSharedProjectMigration(browserMigrationStorage(second), prepared);
  first.seed(`.workbench/${prepared.files[2].path}`, "external work");
  assert.deepEqual(second.files.get(`.workbench/${prepared.files[2].path}`), prepared.files[2].bytes);
});

test("browser host refuses each stale staged file without replacing its bytes", async () => {
  const prepared = await prepareSharedProjectMigration(source);
  for (const target of prepared.files) {
    const directory = new ByteDirectory();
    directory.seed("project.json", source);
    directory.seed(`.workbench/${target.path}`, "external staged bytes");
    const result = await browserMigrationStorage(directory).stage(prepared.projectId, prepared.files);
    assert.equal(result.kind, "conflict");
    if (result.kind === "conflict") {
      assert.equal(result.path, target.path);
      assert.equal(result.phase, "before-write");
      assert.equal(new TextDecoder().decode(result.actualBytes!), "external staged bytes");
    }
    assert.equal(new TextDecoder().decode(directory.files.get(`.workbench/${target.path}`)), "external staged bytes");
  }
});
test("simultaneous same-host staging attempts share one immutable operation", async () => {
  const directory = new ByteDirectory();
  directory.seed("project.json", source);
  const prepared = await prepareSharedProjectMigration(source);
  const results = await Promise.all(Array.from({ length: 2 }, () => stageSharedProjectMigration(browserMigrationStorage(directory), prepared)));
  assert.deepEqual(results.map(result => result.kind), ["staged", "staged"]);
  for (const file of prepared.files) assert.equal(directory.writes.filter(path => path === `.workbench/${file.path}`).length, 1);
});
test("a partially written migration file is unparseable identity, not unavailable inventory", async () => {
  const directory = new ByteDirectory();
  directory.seed("project.json", source);
  const prepared = await prepareSharedProjectMigration(source);
  directory.seed(`.workbench/${prepared.files[0].path}`, source);
  // A write interrupted inside a multi-byte character; native hosts apply the same rule.
  directory.seed(`.workbench/${prepared.files[1].path}`, new Uint8Array([0x7b, 0x22, 0xe2, 0x82]));
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), prepared.projectId);
  assert.equal((await store.save(planSharedProjectMigration(source).selections)).kind, "saved");
  assert.equal((await inspectSharedProjectMigration(await browserMigrationStorage(directory).read(), prepared.projectId, prepared.operationId)).kind, "needs-review");
});
