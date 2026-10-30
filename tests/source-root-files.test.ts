import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listSourceRootFiles,
  readSourceRootCatalog,
  readSourceRootFiles,
  resolveSourceFileReadRequest,
  SOURCE_FILE_MAX_BYTES,
  SOURCE_ROOTS_VARIABLE,
  WorkbenchRequestError,
} from "../services/api/src/index.ts";

/** A catalog beside two roots and a secret outside both. */
function withRoots(run: (environment: Record<string, string>, directory: string) => Promise<void>) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "source-roots-"));
    try {
      mkdirSync(join(directory, "prompts", "flows", "support"), { recursive: true });
      mkdirSync(join(directory, "prompts", ".git"), { recursive: true });
      writeFileSync(join(directory, "secret.md"), "outside");
      writeFileSync(join(directory, "prompts", "agent.md"), "﻿Hello {{ $json.name }}\r\n");
      writeFileSync(join(directory, "prompts", "flows", "support", "system.txt"), "Support");
      writeFileSync(join(directory, "prompts", "flows", "notes.json"), "{}");
      writeFileSync(join(directory, "prompts", ".hidden.md"), "hidden");
      writeFileSync(join(directory, "prompts", ".git", "config.md"), "git");
      writeFileSync(join(directory, "prompts", "big.md"), "x".repeat(SOURCE_FILE_MAX_BYTES + 1));
      writeFileSync(join(directory, "prompts", "latin1.md"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      symlinkSync(join(directory, "secret.md"), join(directory, "prompts", "escape.md"));
      symlinkSync(join(directory, "prompts", "agent.md"), join(directory, "prompts", "alias.md"));
      symlinkSync(join(directory, "prompts", "flows"), join(directory, "prompts", "linked-dir.md"));
      writeFileSync(join(directory, "catalog.json"), JSON.stringify({
        schemaVersion: 1,
        roots: [
          { name: "prompts", path: "./prompts", label: "Agent prompts" },
          { name: "gone", path: join(directory, "missing") },
        ],
      }));
      await run({ [SOURCE_ROOTS_VARIABLE]: join(directory, "catalog.json") }, directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("an unconfigured service declares no roots; a broken catalog is named, never silently empty", () => {
  assert.deepEqual(readSourceRootCatalog({}), { available: false, roots: [] });
  const missing = readSourceRootCatalog({ [SOURCE_ROOTS_VARIABLE]: join(tmpdir(), "definitely-not-here.json") });
  assert.equal(missing.available, false);
  assert.match(missing.problem!, /INFERENCE_LENS_SOURCE_ROOTS names a catalog that could not be read/);

  const directory = mkdtempSync(join(tmpdir(), "source-roots-bad-"));
  try {
    writeFileSync(join(directory, "catalog.json"), JSON.stringify({ schemaVersion: 1, roots: [{ name: "Bad", path: "x" }] }));
    const invalid = readSourceRootCatalog({ [SOURCE_ROOTS_VARIABLE]: join(directory, "catalog.json") });
    assert.match(invalid.problem!, /INFERENCE_LENS_SOURCE_ROOTS names an invalid catalog\. roots\.0\.name/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relative root paths resolve against the catalog's directory", withRoots(async (environment, directory) => {
  const source = readSourceRootCatalog(environment);
  assert.equal(source.available, true);
  assert.deepEqual(source.roots.map(({ name, label, path }) => ({ name, label, path })), [
    { name: "prompts", label: "Agent prompts", path: join(directory, "prompts") },
    { name: "gone", label: undefined, path: join(directory, "missing") },
  ]);
}));

test("reads are confined to the root, size-limited, strict UTF-8 and BOM-free", withRoots(async (environment) => {
  const source = readSourceRootCatalog(environment);
  const results = await readSourceRootFiles(source, [
    { root: "prompts", path: "agent.md" },
    { root: "prompts", path: "flows/support/system.txt" },
    { root: "prompts", path: "alias.md" },
    { root: "prompts", path: "escape.md" },
    { root: "prompts", path: "../secret.md" },
    { root: "prompts", path: "missing.md" },
    { root: "prompts", path: "big.md" },
    { root: "prompts", path: "latin1.md" },
    { root: "prompts", path: "linked-dir.md" },
    { root: "nowhere", path: "agent.md" },
    { root: "gone", path: "agent.md" },
  ]);
  assert.deepEqual(results.map((result) => (result.ok ? { ok: true, text: result.text } : { ok: false, reason: result.reason })), [
    { ok: true, text: "Hello {{ $json.name }}\r\n" },
    { ok: true, text: "Support" },
    { ok: true, text: "Hello {{ $json.name }}\r\n" },
    { ok: false, reason: "outside-root" },
    { ok: false, reason: "invalid-path" },
    { ok: false, reason: "missing" },
    { ok: false, reason: "too-large" },
    { ok: false, reason: "not-utf8" },
    { ok: false, reason: "not-a-file" },
    { ok: false, reason: "unknown-root" },
    { ok: false, reason: "root-unavailable" },
  ]);
  for (const result of results) {
    if (!result.ok) assert.ok(result.message.length > 0);
  }
  // A host path never reaches a page, not even in a message.
  assert.doesNotMatch(JSON.stringify(results), /source-roots-/);
}));

test("listing offers only .md and .txt files inside the root, sorted, without hidden entries", withRoots(async (environment) => {
  const source = readSourceRootCatalog(environment);
  assert.deepEqual(await listSourceRootFiles(source, "prompts"), {
    files: ["agent.md", "alias.md", "big.md", "flows/support/system.txt", "latin1.md"],
    truncated: false,
  });
  assert.deepEqual(await listSourceRootFiles(source, "prompts", { maxFiles: 2 }), { files: ["agent.md", "alias.md"], truncated: true });
  await assert.rejects(() => listSourceRootFiles(source, "nowhere"), (error: unknown) =>
    error instanceof WorkbenchRequestError && error.status === 404);
  await assert.rejects(() => listSourceRootFiles(source, "gone"), (error: unknown) =>
    error instanceof WorkbenchRequestError && error.status === 404 && /not available/.test(error.message));
}));

test("a read request is a bounded batch of root and path strings", () => {
  assert.deepEqual(resolveSourceFileReadRequest({ files: [{ root: "prompts", path: "a.md" }] }), { files: [{ root: "prompts", path: "a.md" }] });
  for (const bad of [null, {}, { files: "a" }, { files: [{ root: "prompts" }] }, { files: [{ root: 1, path: "a.md" }] }, { files: Array.from({ length: 201 }, () => ({ root: "p", path: "a.md" })) }]) {
    assert.throws(() => resolveSourceFileReadRequest(bad), WorkbenchRequestError, JSON.stringify(bad)?.slice(0, 60));
  }
});
