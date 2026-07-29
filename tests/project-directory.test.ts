import assert from "node:assert/strict";
import test from "node:test";

import {
  listTracesFromDirectory,
  readTraceFromDirectory,
} from "../app/project-directory.client.ts";
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
} from "../app/project-directory.client.ts";

/**
 * The File System Access API is not available in Node, so the traversal is
 * driven against handles that implement only what it uses. The point of these
 * tests is the browser half of the traces contract that Rust implements
 * natively: what is skipped, what order results arrive in, and what an absent
 * traces directory means.
 */
function fileHandle(name: string, contents: string): FileSystemFileHandleLike {
  return {
    kind: "file",
    name,
    async getFile() {
      return { text: async () => contents } as File;
    },
    async createWritable() {
      throw new Error("not used");
    },
  };
}

function directoryHandle(
  name: string,
  entries: (FileSystemFileHandleLike | FileSystemDirectoryHandleLike)[],
): FileSystemDirectoryHandleLike {
  const handle: FileSystemDirectoryHandleLike = {
    kind: "directory",
    name,
    async *values() {
      for (const entry of entries) yield entry;
    },
    async getFileHandle(requested: string) {
      const match = entries.find(
        (entry) => entry.kind === "file" && entry.name === requested,
      );
      if (!match) throw new DOMException("missing", "NotFoundError");
      return match as FileSystemFileHandleLike;
    },
    async getDirectoryHandle(requested: string) {
      const match = entries.find(
        (entry) => entry.kind === "directory" && entry.name === requested,
      );
      if (!match) throw new DOMException("missing", "NotFoundError");
      return match as FileSystemDirectoryHandleLike;
    },
    async removeEntry() {
      throw new Error("not used");
    },
  };
  return handle;
}

function projectWith(
  entries: (FileSystemFileHandleLike | FileSystemDirectoryHandleLike)[],
): FileSystemDirectoryHandleLike {
  return directoryHandle("project", [directoryHandle("traces", entries)]);
}

test("lists trace artifacts by code point order", async () => {
  const directory = projectWith([
    fileHandle("run_second.json", "second"),
    fileHandle("run_first.json", "first"),
    fileHandle("run_third.json", "third"),
  ]);

  assert.deepEqual(await listTracesFromDirectory(directory), [
    { fileName: "run_first.json", contents: "first" },
    { fileName: "run_second.json", contents: "second" },
    { fileName: "run_third.json", contents: "third" },
  ]);
});

test("skips entries that are not trace artifacts", async () => {
  const directory = projectWith([
    fileHandle("run_kept.json", "kept"),
    fileHandle("notes.txt", "prose"),
    fileHandle(".hidden.json", "hidden"),
    fileHandle("-leading.json", "leading"),
    fileHandle(".json", "bare suffix"),
    directoryHandle("nested.json", []),
  ]);

  assert.deepEqual(await listTracesFromDirectory(directory), [
    { fileName: "run_kept.json", contents: "kept" },
  ]);
});

test("a project folder with no traces directory has no history yet", async () => {
  const directory = directoryHandle("project", []);

  assert.deepEqual(await listTracesFromDirectory(directory), []);
});

test("a traces directory that cannot be opened is a failure, not an empty list", async () => {
  const directory: FileSystemDirectoryHandleLike = {
    ...directoryHandle("project", []),
    async getDirectoryHandle() {
      throw new DOMException("denied", "NotAllowedError");
    },
  };

  await assert.rejects(
    () => listTracesFromDirectory(directory),
    /denied/,
    "a permission failure must not be reported as an empty project",
  );
});

test("reads one artifact by the name it was listed under", async () => {
  const directory = projectWith([fileHandle("renamed-by-hand.json", "kept")]);

  assert.equal(
    await readTraceFromDirectory(directory, "renamed-by-hand.json"),
    "kept",
  );
});

test("refuses names that could escape the traces directory", async () => {
  const directory = projectWith([fileHandle("run_a.json", "a")]);

  for (const escaping of [
    "../inference-lens.project.json",
    "nested/run_a.json",
    "/etc/passwd",
    "run_a.json/../../secret.json",
  ]) {
    await assert.rejects(
      () => readTraceFromDirectory(directory, escaping),
      /is not a run trace file name/,
      `${escaping} should be refused`,
    );
  }
});
