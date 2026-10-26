import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { browserWorkbenchStorage } from "../app/workbench-directory.client.ts";
import type { FileSystemDirectoryHandleLike, FileSystemFileHandleLike } from "../app/project-directory.client.ts";
import { parseWorkbenchRecord, serializeWorkbenchRecord } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchRecordV1 } from "../packages/core/src/personal-workbench.ts";
import { openWorkbenchStore } from "../packages/core/src/workbench-store.ts";

class FileHandle implements FileSystemFileHandleLike {
  readonly kind = "file";
  readonly name: string;
  readonly path: string;
  readonly fs: Directory;
  constructor(name: string, path: string, fs: Directory) {
    this.name = name; this.path = path; this.fs = fs;
  }
  async getFile(): Promise<File> {
    const contents = this.fs.files.get(this.path) ?? "";
    return { text: async () => contents } as File;
  }
  async createWritable() {
    let pending = "";
    return {
      write: async (data: string) => { pending = data; },
      close: async () => {
        if (this.fs.failPath === this.path) throw new Error("injected write failure");
        this.fs.writes.push(this.path);
        this.fs.files.set(this.path, pending);
        this.fs.afterWrite?.(this.path);
      },
    };
  }
}

class Directory implements FileSystemDirectoryHandleLike {
  readonly kind = "directory";
  readonly name: string;
  readonly files: Map<string, string>;
  readonly directories: Set<string>;
  readonly writes: string[];
  failPath?: string;
  afterWrite?: (path: string) => void;
  readonly path: string;
  readonly root?: Directory;
  constructor(path = "", root?: Directory) {
    this.path = path; this.root = root;
    this.name = path.split("/").at(-1) || "project";
    this.files = root?.files ?? new Map();
    this.directories = root?.directories ?? new Set([""]);
    this.writes = root?.writes ?? [];
  }
  child(name: string) { return this.path ? `${this.path}/${name}` : name; }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const path = this.child(name);
    if (this.directories.has(path)) throw new DOMException("directory", "TypeMismatchError");
    if (!this.files.has(path)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.files.set(path, "");
    }
    return new FileHandle(name, path, this.root ?? this);
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const path = this.child(name);
    if (this.files.has(path)) throw new DOMException("file", "TypeMismatchError");
    if (!this.directories.has(path)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.directories.add(path);
    }
    return new Directory(path, this.root ?? this);
  }
  async *values() {
    for (const path of this.files.keys()) {
      if (dirname(path) === (this.path || ".")) yield new FileHandle(path.split("/").at(-1)!, path, this.root ?? this);
    }
    for (const path of this.directories) {
      if (path && dirname(path) === (this.path || ".")) yield new Directory(path, this.root ?? this);
    }
  }
  async removeEntry(name: string) {
    const path = this.child(name);
    if (!this.files.delete(path)) throw new DOMException("missing", "NotFoundError");
    this.writes.push(`delete:${path}`);
    (this.root ?? this).afterWrite?.(path);
  }
  seed(path: string, contents: string) {
    let parent = dirname(path);
    while (parent !== ".") { this.directories.add(parent); parent = dirname(parent); }
    this.files.set(path, contents);
  }
}

const projectId = "project_shared-assets-example";
function records(): WorkbenchRecordV1[] {
  const example = JSON.parse(readFileSync(new URL("../docs/examples/shared-assets-level-two/workbench-records.proposed.json", import.meta.url), "utf8"));
  return Object.values(example.records).map(record => parseWorkbenchRecord(record, projectId));
}
const pathFor = (record: WorkbenchRecordV1) => record.kind === "selections" ? "selections.json" : `drafts/${record.draftId}.json`;

test("browser recovery writes verified self-ignore before either prompt kind or selections", async () => {
  const directory = new Directory();
  directory.seed("project.json", "original shared bytes");
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  for (const record of records()) await store.save(record);
  assert.equal(directory.files.get(".workbench/.gitignore") ?? null, "*\n");
  assert.equal(directory.writes[0], ".workbench/.gitignore");
  for (const record of records()) {
    assert.equal(directory.files.get(`.workbench/${pathFor(record)}`), serializeWorkbenchRecord(record));
  }
  assert.equal(directory.files.get("project.json"), "original shared bytes");
});

test("opening recovery is read-only and loading a missing store stays empty", async () => {
  const directory = new Directory();
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  assert.deepEqual(store.records, []);
  assert.deepEqual(store.unavailable, []);
  assert.deepEqual([...directory.directories], [""]);
  assert.deepEqual(directory.writes, []);
});

test("load restores both prompt kinds and selections without consulting live bases", async () => {
  const directory = new Directory();
  for (const record of records()) directory.seed(`.workbench/${pathFor(record)}`, serializeWorkbenchRecord(record));
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  assert.deepEqual(store.records.map(item => item.record).sort((a, b) => pathFor(a).localeCompare(pathFor(b))), records().sort((a, b) => pathFor(a).localeCompare(pathFor(b))));
  assert.deepEqual(directory.writes, []);
});

test("corrupt, unknown-version and misnamed records remain unavailable without blocking good records", async () => {
  const directory = new Directory();
  directory.seed(".workbench/drafts/draft_broken.json", "{unfinished");
  directory.seed(".workbench/drafts/draft_future.json", JSON.stringify({ schemaVersion: 99, projectId, kind: "draft" }));
  const draft = records().find(record => record.kind === "draft")!;
  directory.seed(".workbench/drafts/draft_wrong-name.json", serializeWorkbenchRecord(draft));
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  assert.equal(store.unavailable.length, 3);
  assert.equal(store.writeBlocked, false);
  assert.equal((await store.save(records().find(record => record.kind === "selections")!)).kind, "saved");
  assert.equal(directory.files.get(".workbench/drafts/draft_broken.json"), "{unfinished");
  assert.equal((await store.delete("drafts/draft_broken.json")).kind, "blocked");
});

test("a foreign project blocks all mutations, including when its record is an unknown version", async () => {
  const directory = new Directory();
  directory.seed(".workbench/drafts/draft_foreign.json", JSON.stringify({ schemaVersion: 99, projectId: "project_someone-else" }));
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  assert.equal(store.writeBlocked, true);
  assert.equal((await store.save(records()[0])).kind, "blocked");
  assert.deepEqual(directory.writes, []);
});

test("a foreign record arriving after open blocks writes and deletion", async () => {
  for (const deletion of [false, true]) {
    const directory = new Directory();
    const record = records()[0];
    directory.seed(`.workbench/${pathFor(record)}`, serializeWorkbenchRecord(record));
    const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
    directory.seed(".workbench/drafts/draft_foreign.json", JSON.stringify({ projectId: "project_foreign" }));
    assert.equal((await (deletion ? store.delete(pathFor(record)) : store.save(record))).kind, "blocked");
    assert.equal(directory.files.get(`.workbench/${pathFor(record)}`), serializeWorkbenchRecord(record));
  }
});

test("failed or customized ignore policy prevents personal writes and preserves the policy", async () => {
  for (const existing of [undefined, "# custom\n"]) {
    const directory = new Directory();
    if (existing) directory.seed(".workbench/.gitignore", existing);
    else directory.failPath = ".workbench/.gitignore";
    const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
    assert.notEqual((await store.save(records()[0])).kind, "saved");
    assert.equal(directory.files.has(`.workbench/${pathFor(records()[0])}`), false);
    if (existing) assert.equal(directory.files.get(".workbench/.gitignore"), existing);
  }
});

test("self-ignore read-back is checked before any personal content is created", async () => {
  const directory = new Directory();
  directory.afterWrite = path => { if (path === ".workbench/.gitignore") directory.files.set(path, ""); };
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  assert.notEqual((await store.save(records()[0])).kind, "saved");
  assert.equal(directory.files.has(`.workbench/${pathFor(records()[0])}`), false);
});

test("stale writes return disk and attempted content and stop only the affected record", async () => {
  const directory = new Directory();
  const record = records().find(item => item.kind === "draft")!;
  directory.seed(`.workbench/${pathFor(record)}`, serializeWorkbenchRecord(record));
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  const external = "external work remains untouched";
  directory.files.set(`.workbench/${pathFor(record)}`, external);
  const outcome = await store.save(record);
  assert.equal(outcome.kind, "conflict");
  if (outcome.kind === "conflict") {
    assert.equal(outcome.actualContents, external);
    assert.equal(outcome.attemptedContents, serializeWorkbenchRecord(record));
    assert.equal(outcome.phase, "before-write");
  }
  assert.equal((await store.save(record)).kind, "blocked");
  assert.equal((await store.save(records().find(item => item.kind === "selections")!)).kind, "saved");
  assert.equal(directory.files.get(`.workbench/${pathFor(record)}`), external);
});

test("mismatched record read-back is a conflict and never advances expected contents", async () => {
  const directory = new Directory();
  const record = records()[0];
  directory.afterWrite = path => { if (path.endsWith(pathFor(record))) directory.files.set(path, "concurrent edit"); };
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  const outcome = await store.save(record);
  assert.equal(outcome.kind, "conflict");
  if (outcome.kind === "conflict") {
    assert.equal(outcome.phase, "read-back");
    assert.equal(outcome.actualContents, "concurrent edit");
  }
  assert.equal((await store.save(record)).kind, "blocked");
});

test("deletes check expected bytes and confirm absence, and preserve concurrent replacements", async () => {
  for (const conflict of ["none", "before", "after"] as const) {
    const directory = new Directory();
    const record = records()[0];
    const path = pathFor(record);
    directory.seed(`.workbench/${path}`, serializeWorkbenchRecord(record));
    const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
    if (conflict === "before") directory.files.set(`.workbench/${path}`, "external work");
    if (conflict === "after") directory.afterWrite = changed => { if (changed === `.workbench/${path}`) directory.files.set(changed, "external work"); };
    const outcome = await store.delete(path);
    assert.equal(outcome.kind, conflict === "none" ? "deleted" : "conflict");
    assert.equal(directory.files.get(`.workbench/${path}`) ?? null, conflict === "none" ? null : "external work");
  }
});

test("uncertain I/O failures block the affected record but allow other recovery", async () => {
  const directory = new Directory();
  const record = records().find(item => item.kind === "draft")!;
  directory.failPath = `.workbench/${pathFor(record)}`;
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  assert.equal((await store.save(record)).kind, "failed");
  directory.failPath = undefined;
  assert.equal((await store.save(record)).kind, "blocked");
  assert.equal((await store.save(records().find(item => item.kind === "selections")!)).kind, "saved");
});

test("stores with the same project ID in separate checkouts stay independent", async () => {
  const first = new Directory();
  const second = new Directory();
  const firstStore = await openWorkbenchStore(browserWorkbenchStorage(first), projectId);
  const secondStore = await openWorkbenchStore(browserWorkbenchStorage(second), projectId);
  await firstStore.save(records()[0]);
  assert.equal(second.files.size, 0);
  assert.deepEqual(secondStore.records, []);
});

test("record edits after save starts cannot mutate the frozen write", async () => {
  const directory = new Directory();
  const record = records().find(item => item.kind === "draft")!;
  const frozen = serializeWorkbenchRecord(record);
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  const pending = store.save(record);
  if (record.kind === "draft") record.edited.revisionName = "changed while saving";
  await pending;
  assert.equal(directory.files.get(`.workbench/${pathFor(record)}`), frozen);
});

test("unsafe paths and foreign input are rejected before filesystem mutation", async () => {
  const directory = new Directory();
  const storage = browserWorkbenchStorage(directory);
  for (const path of ["../project.json", "drafts/../../outside.json", "drafts/draft_x.json/evil", "drafts\\draft_x.json", ".gitignore", "drafts/draft_x.json\n"]) {
    await assert.rejects(() => storage.mutate(path, null, "{}", projectId), /path|name/i);
  }
  const store = await openWorkbenchStore(storage, projectId);
  const record = { ...records()[0], projectId: "project_foreign" } as WorkbenchRecordV1;
  await assert.rejects(() => store.save(record), /different project/);
  assert.deepEqual(directory.writes, []);
});

test("same-host concurrent stores serialize the check, write and read-back", async () => {
  const directory = new Directory();
  const first = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  const second = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  const outcomes = await Promise.all([first.save(records()[0]), second.save(records()[0])]);
  assert.deepEqual(outcomes.map(item => item.kind).sort(), ["conflict", "saved"]);
});

test("queued saves use the confirmed preceding bytes and can delete the latest record", async () => {
  const directory = new Directory();
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  const first = records().find(record => record.kind === "draft")!;
  const next = structuredClone(first);
  if (next.kind === "draft") next.edited.revisionName = "second edit";
  const outcomes = await Promise.all([store.save(first), store.save(next)]);
  assert.deepEqual(outcomes.map(outcome => outcome.kind), ["saved", "saved"]);
  assert.equal(directory.files.get(`.workbench/${pathFor(next)}`), serializeWorkbenchRecord(next));
  assert.equal((await store.delete(pathFor(next))).kind, "deleted");
});

test("unreadable records remain individually unavailable and a failed inventory never creates a store", async () => {
  const calls: string[] = [];
  const store = await openWorkbenchStore({
    async list() { return [{ path: "drafts/draft_unreadable.json", error: "permission denied" }]; },
    async mutate(path) { calls.push(path); return { kind: "written" }; },
  }, projectId);
  assert.deepEqual(store.unavailable, [{ path: "drafts/draft_unreadable.json", message: "permission denied" }]);
  assert.equal((await store.delete("drafts/draft_unreadable.json")).kind, "blocked");
  assert.deepEqual(calls, []);
  await assert.rejects(() => openWorkbenchStore({
    async list() { throw new Error("inventory unavailable"); },
    async mutate() { throw new Error("must not mutate"); },
  }, projectId), /inventory unavailable/);
});

test("the browser adapter requests a Web Lock around the whole filesystem mutation", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const names: string[] = [];
  let active = false;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    request: async (name: string, callback: () => Promise<unknown>) => {
      names.push(name); active = true;
      try { return await callback(); } finally { active = false; }
    },
  } } });
  try {
    const directory = new Directory();
    directory.afterWrite = () => assert.equal(active, true);
    const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
    await store.save(records()[0]);
    assert.equal(names.length, 1);
    assert.ok(names[0].includes(projectId));
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("actual browser store output is ignored by Git without a bundle policy", async () => {
  const directory = new Directory();
  const store = await openWorkbenchStore(browserWorkbenchStorage(directory), projectId);
  for (const record of records()) await store.save(record);
  const repository = mkdtempSync(join(tmpdir(), "inference-lens-store-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  try {
    git("init", "--quiet");
    writeFileSync(join(repository, "project.json"), "{}\n");
    for (const [path, contents] of directory.files) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      writeFileSync(join(repository, path), contents);
    }
    assert.ok(directory.files.size >= 4, "the adapter must have written actual records");
    git("add", ".");
    assert.equal(git("ls-files").trim(), "project.json");
    for (const path of directory.files.keys()) assert.equal(git("check-ignore", path).trim(), path);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});
