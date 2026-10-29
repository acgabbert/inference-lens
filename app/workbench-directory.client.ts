"use client";

import { WORKBENCH_GITIGNORE_CONTENTS } from "../packages/core/src/personal-workbench.ts";
import { assertWorkbenchRecordPath, FOREIGN_PROJECT_MESSAGE, hasForeignWorkbenchIdentity } from "../packages/core/src/workbench-store.ts";
import type { WorkbenchFile, WorkbenchStorage } from "../packages/core/src/workbench-store.ts";
import { assertMigrationPath, hasForeignMigrationIdentity, sameMigrationBytes } from "../packages/core/src/migration-journal.ts";
import type { MigrationFile, MigrationPayload, MigrationStageOutcome, MigrationStorage } from "../packages/core/src/migration-journal.ts";
import type { ProjectId } from "../packages/core/src/run-kernel/types.ts";
import type { FileSystemDirectoryHandleLike } from "./project-directory.client.ts";

/** Browser filesystem boundary; opening it performs no I/O. */
export function browserWorkbenchStorage(directory: FileSystemDirectoryHandleLike): WorkbenchStorage {
  return {
    list: () => list(directory),
    async mutate(path, expectedContents, contents, projectId) {
      assertWorkbenchRecordPath(path);
      return coordinateProjectWrites(projectId, async () => {
        const inventory = await list(directory);
        if (inventory.some(file => "error" in file && file.path.startsWith("migrations"))) throw new Error("Migration inventory is unavailable; workbench writes are blocked.");
        if (hasForeignWorkbenchIdentity(inventory, projectId)) {
          return { kind: "blocked", reason: "foreign-project", message: FOREIGN_PROJECT_MESSAGE };
        }
        const protectedDirectory = await protectWorkbench(directory);
        if (protectedDirectory.kind === "blocked") return protectedDirectory;
        const workbench = protectedDirectory;
        const [parent, name] = await recordLocation(workbench, path, false);
        const actualContents = parent ? await readFile(parent, name) : null;
        if (actualContents !== expectedContents) return { kind: "conflict", phase: "before-write", actualContents };
        if (contents === null) {
          if (parent && actualContents !== null) await parent.removeEntry(name);
        } else {
          const [destination] = await recordLocation(workbench, path, true);
          await writeFile(destination!, name, contents);
        }
        const [confirmedParent] = await recordLocation(workbench, path, false);
        const confirmed = confirmedParent ? await readFile(confirmedParent, name) : null;
        return confirmed === contents ? { kind: "written" } : { kind: "conflict", phase: "read-back", actualContents: confirmed };
      });
    },
  };
}

const PROTECTION_MESSAGE = "Workbench .gitignore must contain exactly '*\\n' before personal content can be written.";

function isMissing(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function readFile(directory: FileSystemDirectoryHandleLike, name: string): Promise<string | null> {
  try { return await (await (await directory.getFileHandle(name)).getFile()).text(); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

async function writeFile(directory: FileSystemDirectoryHandleLike, name: string, contents: string): Promise<void> {
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
  await writable.write(contents);
  await writable.close();
}

async function recordLocation(workbench: FileSystemDirectoryHandleLike, path: string, create: boolean): Promise<[FileSystemDirectoryHandleLike | null, string]> {
  if (path === "selections.json") return [workbench, path];
  const name = path.slice("drafts/".length);
  try { return [await workbench.getDirectoryHandle("drafts", { create }), name]; }
  catch (error) { if (!create && isMissing(error)) return [null, name]; throw error; }
}

async function list(directory: FileSystemDirectoryHandleLike): Promise<WorkbenchFile[]> {
  let workbench: FileSystemDirectoryHandleLike;
  try { workbench = await directory.getDirectoryHandle(".workbench"); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const files: WorkbenchFile[] = [];
  async function collect(parent: FileSystemDirectoryHandleLike, prefix: string): Promise<void> {
    for await (const entry of parent.values()) {
      if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
      const path = `${prefix}${entry.name}`;
      try { files.push({ path, contents: await (await entry.getFile()).text() }); }
      catch (error) { files.push({ path, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  await collect(workbench, "");
  let drafts: FileSystemDirectoryHandleLike | undefined;
  try { drafts = await workbench.getDirectoryHandle("drafts"); }
  catch (error) { if (!isMissing(error)) throw error; }
  if (drafts) await collect(drafts, "drafts/");
  for (const file of await listMigrationFiles(directory)) {
    files.push("bytes" in file ? { path: file.path, contents: new TextDecoder().decode(file.bytes) } : file);
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// Web Locks coordinate tabs/windows. The fallback covers callers in this realm;
// cross-host and unsupported-browser races remain best-effort detection only.
const queues = new Map<string, Promise<unknown>>();
/**
 * The per-project same-host write scope. Workbench records, migration staging
 * and browser manifest saves all run inside it, so none can land between
 * another's check and its write.
 */
export function coordinateProjectWrites<T>(projectId: ProjectId, operation: () => Promise<T>): Promise<T> {
  const key = `inference-lens:workbench:${projectId}`;
  const pending = queues.get(key) ?? Promise.resolve();
  const next = pending.then(async () => {
    if (typeof navigator !== "undefined" && navigator.locks) return await navigator.locks.request(key, operation);
    return operation();
  });
  const settled = next.catch(() => {});
  queues.set(key, settled);
  void next.finally(() => { if (queues.get(key) === settled) queues.delete(key); }).catch(() => {});
  return next;
}

/** Byte-preserving migration capability; creation performs no I/O. */
export function browserMigrationStorage(directory: FileSystemDirectoryHandleLike): MigrationStorage {
  return {
    async read() {
      const active = await list(directory);
      const files: MigrationFile[] = active.filter(file => !file.path.startsWith("migrations/")).map(file =>
        "contents" in file ? { path: file.path, bytes: new TextEncoder().encode(file.contents) } : file);
      files.push(...await listMigrationFiles(directory));
      return { manifest: await readBytes(directory, "project.json"), files };
    },
    async stage(projectId, files) {
      // Freeze before queuing behind another writer.
      const payloads = structuredClone(files);
      validateMigrationBatch(payloads);
      if (hasForeignMigrationIdentity(payloads, projectId)) return { kind: "blocked", reason: "foreign-project", message: FOREIGN_PROJECT_MESSAGE };
      return coordinateProjectWrites(projectId, async (): Promise<MigrationStageOutcome> => {
        let path = payloads[0].path;
        try {
          for (const file of payloads) {
            path = file.path;
            const inventory = await list(directory);
            if (inventory.some(entry => "error" in entry && entry.path.startsWith("migrations"))) throw new Error("Migration inventory is unavailable.");
            const migrationFiles = inventory.map(entry => "contents" in entry ? { path: entry.path, bytes: new TextEncoder().encode(entry.contents) } : entry);
            if (hasForeignMigrationIdentity(migrationFiles, projectId)) return { kind: "blocked", reason: "foreign-project", message: FOREIGN_PROJECT_MESSAGE };
            if (!sameMigrationBytes(await readBytes(directory, "project.json"), payloads[0].bytes)) return { kind: "blocked", reason: "manifest-diverged", message: "Manifest no longer matches migration source." };
            const protectedDirectory = await protectWorkbench(directory);
            if (protectedDirectory.kind === "blocked") return protectedDirectory;
            const [parent, name] = await migrationLocation(protectedDirectory, file.path, false);
            const actual = parent ? await readBytes(parent, name) : null;
            if (actual !== null) {
              if (!sameMigrationBytes(actual, file.bytes)) return { kind: "conflict", path, phase: "before-write", actualBytes: actual };
              continue;
            }
            const [destination] = await migrationLocation(protectedDirectory, file.path, true);
            const writable = await (await destination!.getFileHandle(name, { create: true })).createWritable();
            await writable.write(file.bytes);
            await writable.close();
            const confirmed = await readBytes(destination!, name);
            if (!sameMigrationBytes(confirmed, file.bytes)) return { kind: "conflict", path, phase: "read-back", actualBytes: confirmed };
          }
          return { kind: "staged" };
        } catch (error) { return { kind: "failed", path, message: error instanceof Error ? error.message : String(error) }; }
      });
    },
  };
}

async function protectWorkbench(directory: FileSystemDirectoryHandleLike): Promise<FileSystemDirectoryHandleLike | { kind: "blocked"; reason: "protection"; message: string }> {
  try {
    const workbench = await directory.getDirectoryHandle(".workbench", { create: true });
    let ignore = await readFile(workbench, ".gitignore");
    if (ignore === null) {
      await writeFile(workbench, ".gitignore", WORKBENCH_GITIGNORE_CONTENTS);
      ignore = await readFile(workbench, ".gitignore");
    }
    if (ignore !== WORKBENCH_GITIGNORE_CONTENTS) return { kind: "blocked", reason: "protection", message: PROTECTION_MESSAGE };
    return workbench;
  } catch (error) { return { kind: "blocked", reason: "protection", message: `Could not protect recovery directory: ${error instanceof Error ? error.message : String(error)}` }; }
}
async function readBytes(directory: FileSystemDirectoryHandleLike, name: string): Promise<Uint8Array | null> {
  try { return new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer()); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}
async function migrationLocation(workbench: FileSystemDirectoryHandleLike, path: string, create: boolean): Promise<[FileSystemDirectoryHandleLike | null, string]> {
  const parts = assertMigrationPath(path).split("/");
  const name = parts.pop()!;
  let parent = workbench;
  try { for (const part of parts) parent = await parent.getDirectoryHandle(part, { create }); }
  catch (error) { if (!create && isMissing(error)) return [null, name]; throw error; }
  return [parent, name];
}
/** Enumerate fixed-depth migration inventory, retaining unexpected entries for review. */
async function listMigrationFiles(directory: FileSystemDirectoryHandleLike): Promise<MigrationFile[]> {
  let migrations: FileSystemDirectoryHandleLike;
  try { migrations = await (await directory.getDirectoryHandle(".workbench")).getDirectoryHandle("migrations"); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const files: MigrationFile[] = [];
  async function collect(parent: FileSystemDirectoryHandleLike, prefix: string, depth: number) {
    for await (const entry of parent.values()) {
      const path = `${prefix}/${entry.name}`;
      if (entry.kind === "directory" && depth < 2 && (depth === 0 || entry.name === "candidates")) {
        await collect(entry, path, depth + 1);
      } else if (entry.kind === "file") {
        try { files.push({ path, bytes: new Uint8Array(await (await entry.getFile()).arrayBuffer()) }); }
        catch (error) { files.push({ path, error: error instanceof Error ? error.message : String(error) }); }
      } else files.push({ path, error: "Unexpected migration directory." });
    }
  }
  await collect(migrations, "migrations", 0);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function validateMigrationBatch(files: MigrationPayload[]) {
  if (files.length < 4) throw new Error("Migration batch is incomplete.");
  const root = files[0].path.slice(0, files[0].path.lastIndexOf("/") + 1);
  const unique = new Set<string>();
  for (const file of files) {
    assertMigrationPath(file.path);
    if (!file.path.startsWith(root) || unique.has(file.path)) throw new Error("Invalid migration batch identity.");
    unique.add(file.path);
  }
  for (const [index, suffix] of ["source.project.json", "journal.json", "shared.project.json", "candidates/selections.json"].entries()) {
    if (files[index].path !== root + suffix) throw new Error("Invalid migration staging order.");
  }
}
