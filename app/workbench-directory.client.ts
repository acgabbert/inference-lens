"use client";

import { WORKBENCH_GITIGNORE_CONTENTS } from "../packages/core/src/personal-workbench.ts";
import { assertWorkbenchRecordPath, FOREIGN_PROJECT_MESSAGE, hasForeignWorkbenchIdentity } from "../packages/core/src/workbench-store.ts";
import type { WorkbenchFile, WorkbenchStorage } from "../packages/core/src/workbench-store.ts";
import { assertMigrationPath, hasForeignMigrationIdentity, sameMigrationBytes } from "../packages/core/src/migration-journal.ts";
import type { MigrationFile, MigrationPayload, MigrationSnapshot, MigrationStageOutcome, MigrationStorage } from "../packages/core/src/migration-journal.ts";
import type {
  MigrationCompletionActivation, MigrationCompletionHostResult, MigrationCompletionPlan, MigrationCompletionStorage,
} from "../packages/core/src/migration-completion.ts";
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
  // Validated record paths have exactly one directory: drafts/ or scratch/.
  const [folder, name] = path.split("/") as [string, string];
  try { return [await workbench.getDirectoryHandle(folder, { create }), name]; }
  catch (error) { if (!create && isMissing(error)) return [null, name]; throw error; }
}

async function list(directory: FileSystemDirectoryHandleLike): Promise<WorkbenchFile[]> {
  const files: WorkbenchFile[] = await listActiveRecords(directory, async file => ({ contents: await file.text() }));
  for (const file of await listMigrationFiles(directory)) {
    files.push("bytes" in file ? { path: file.path, contents: new TextDecoder().decode(file.bytes) } : file);
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Share inventory traversal while leaving text versus raw-byte reads to the caller. */
async function listActiveRecords<T extends { contents: string } | { bytes: Uint8Array }>(
  directory: FileSystemDirectoryHandleLike,
  read: (file: File) => Promise<T>,
): Promise<({ path: string } & (T | { error: string }))[]> {
  let workbench: FileSystemDirectoryHandleLike;
  try { workbench = await directory.getDirectoryHandle(".workbench"); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const files: ({ path: string } & (T | { error: string }))[] = [];
  async function collect(parent: FileSystemDirectoryHandleLike, prefix: string): Promise<void> {
    for await (const entry of parent.values()) {
      if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
      const path = `${prefix}${entry.name}`;
      try { files.push({ path, ...await read(await entry.getFile()) }); }
      catch (error) { files.push({ path, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  await collect(workbench, "");
  for (const folder of ["drafts", "scratch"]) {
    let records: FileSystemDirectoryHandleLike | undefined;
    try { records = await workbench.getDirectoryHandle(folder); }
    catch (error) { if (!isMissing(error)) throw error; }
    if (records) await collect(records, `${folder}/`);
  }
  return files;
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
    read: () => readMigrationSnapshot(directory),
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

/**
 * Migration completion for one workspace handle. Only that handle's storage
 * factory constructs it: `onSharedAttempt` invalidates the handle's ordinary
 * manifest saves once the shared write is attempted or found already done.
 */
export function browserMigrationCompletionStorage(directory: FileSystemDirectoryHandleLike, projectId: ProjectId, onSharedAttempt: () => void): MigrationCompletionStorage {
  return {
    read: () => readMigrationSnapshot(directory),
    async execute(input) {
      // Freeze before queuing behind another writer.
      const plan = structuredClone(input);
      validateCompletionPlan(plan, projectId);
      return coordinateProjectWrites(projectId, () => executeCompletion(directory, plan, onSharedAttempt));
    },
  };
}

/** Binds every write to the staged operation, so a plan can never become an arbitrary path writer. */
function validateCompletionPlan(plan: MigrationCompletionPlan, projectId: ProjectId): void {
  const invalid = (reason: string) => new Error(`Invalid completion plan: ${reason}.`);
  if (plan.projectId !== projectId) throw invalid("it belongs to another project");
  const root = `migrations/${plan.operationId}/`;
  const expected = new Map(plan.expected.files.map(file => [file.path, file]));
  const staged = (path: string) => {
    const file = expected.get(`${root}${path}`);
    if (!file || !("bytes" in file)) throw invalid(`${path} is not staged in this operation`);
    return file.bytes;
  };
  assertMigrationPath(`${root}source.project.json`);
  if (!sameMigrationBytes(plan.source, staged("source.project.json"))) throw invalid("the source is not the staged source");
  if (!sameMigrationBytes(plan.shared, staged("shared.project.json"))) throw invalid("the shared manifest is not the staged snapshot");
  if (!sameMigrationBytes(plan.expected.manifest, plan.source) && !sameMigrationBytes(plan.expected.manifest, plan.shared)) throw invalid("the manifest matches neither snapshot");
  const destinations = new Set<string>();
  for (const activation of plan.activations) {
    if (!activation.candidate.startsWith("candidates/")) throw invalid(`${activation.candidate} is not a candidate`);
    assertMigrationPath(`${root}${activation.candidate}`);
    const name = activation.candidate.slice("candidates/".length);
    const destination = name === "selections.json" ? name : `drafts/${name}`;
    if (activation.destination !== destination) throw invalid(`${activation.candidate} does not activate at ${activation.destination}`);
    assertWorkbenchRecordPath(destination);
    if (!sameMigrationBytes(activation.bytes, staged(activation.candidate))) throw invalid(`${activation.candidate} is not the staged bytes`);
    if (destinations.has(destination) || expected.has(destination)) throw invalid(`${destination} is not absent`);
    destinations.add(destination);
  }
}

type CompletionStop = NonNullable<Extract<MigrationCompletionHostResult, { kind: "executed" }>["stopped"]>;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Runs inside the project's write scope. Everything before the first content
 * write only reads, so a failure there throws with nothing attempted.
 */
async function executeCompletion(directory: FileSystemDirectoryHandleLike, plan: MigrationCompletionPlan, onSharedAttempt: () => void): Promise<MigrationCompletionHostResult> {
  const current = await readMigrationSnapshot(directory);
  if (!sameSnapshot(current, plan.expected)) return { kind: "stale-plan" };
  if (hasForeignMigrationIdentity(current.files, plan.projectId)) throw new Error(FOREIGN_PROJECT_MESSAGE);
  if (!await isWorkbenchProtected(directory)) return { kind: "blocked", reason: "protection", message: PROTECTION_MESSAGE };
  let manifest: "written" | "already-shared" = "already-shared";
  if (sameMigrationBytes(current.manifest, plan.source)) {
    // The expected-source check immediately before replacement; nothing has been written yet.
    if (!sameMigrationBytes(await readBytes(directory, "project.json"), plan.source)) return { kind: "stale-plan" };
    onSharedAttempt();
    const stopped = await replaceManifest(directory, plan.shared);
    if (stopped) return { kind: "executed", manifest: "failed", activated: [], stopped };
    manifest = "written";
  } else onSharedAttempt();
  const activated: MigrationCompletionActivation[] = [];
  for (const activation of plan.activations) {
    const stopped = await activate(directory, plan, activation, activated);
    if (stopped) return { kind: "executed", manifest, activated: activated.map(item => item.destination), stopped };
    activated.push(activation);
  }
  return { kind: "executed", manifest, activated: activated.map(item => item.destination) };
}

async function replaceManifest(directory: FileSystemDirectoryHandleLike, shared: Uint8Array): Promise<CompletionStop | undefined> {
  let phase: CompletionStop["phase"] = "write";
  try {
    const writable = await (await directory.getFileHandle("project.json")).createWritable();
    await writable.write(shared);
    await writable.close();
    phase = "read-back";
    if (!sameMigrationBytes(await readBytes(directory, "project.json"), shared)) return { destination: "project.json", phase, message: "Manifest read-back does not match the shared snapshot." };
    return undefined;
  } catch (error) { return { destination: "project.json", phase, message: errorMessage(error) }; }
}

/** Creates one absent record after rechecking everything the shared write and earlier activations established. */
async function activate(directory: FileSystemDirectoryHandleLike, plan: MigrationCompletionPlan, activation: MigrationCompletionActivation, activated: MigrationCompletionActivation[]): Promise<CompletionStop | undefined> {
  const { destination } = activation;
  let phase: CompletionStop["phase"] = "before-write";
  try {
    const expected: MigrationSnapshot = {
      manifest: plan.shared,
      files: [...plan.expected.files, ...activated.map(item => ({ path: item.destination, bytes: item.bytes }))],
    };
    if (!sameSnapshot(await readMigrationSnapshot(directory), expected)) return { destination, phase, message: "The project or its recovery files changed during completion." };
    if (!await isWorkbenchProtected(directory)) return { destination, phase, message: PROTECTION_MESSAGE };
    const [parent, name] = await recordLocation(await directory.getDirectoryHandle(".workbench"), destination, true);
    if (await readBytes(parent!, name) !== null) return { destination, phase, message: "The destination appeared during completion." };
    phase = "write";
    const writable = await (await parent!.getFileHandle(name, { create: true })).createWritable();
    await writable.write(activation.bytes);
    await writable.close();
    phase = "read-back";
    if (!sameMigrationBytes(await readBytes(parent!, name), activation.bytes)) return { destination, phase, message: "Read-back does not match the staged candidate." };
    return undefined;
  } catch (error) { return { destination, phase, message: errorMessage(error) }; }
}

/** Exact inventory equality by path; an unreadable entry matches only another unreadable entry. */
function sameSnapshot(left: MigrationSnapshot, right: MigrationSnapshot): boolean {
  if (!sameMigrationBytes(left.manifest, right.manifest) || left.files.length !== right.files.length) return false;
  const files = new Map(right.files.map(file => [file.path, file]));
  return files.size === right.files.length && left.files.every(file => {
    const other = files.get(file.path);
    if (!other) return false;
    return "bytes" in file ? "bytes" in other && sameMigrationBytes(file.bytes, other.bytes) : !("bytes" in other);
  });
}

/** Completion never creates or repairs protection; successful staging already established it. */
async function isWorkbenchProtected(directory: FileSystemDirectoryHandleLike): Promise<boolean> {
  try { return await readFile(await directory.getDirectoryHandle(".workbench"), ".gitignore") === WORKBENCH_GITIGNORE_CONTENTS; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}

async function readMigrationSnapshot(directory: FileSystemDirectoryHandleLike): Promise<MigrationSnapshot> {
  const files: MigrationFile[] = await listActiveRecords(directory, async file => ({ bytes: new Uint8Array(await file.arrayBuffer()) }));
  files.push(...await listMigrationFiles(directory));
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { manifest: await readBytes(directory, "project.json"), files };
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
