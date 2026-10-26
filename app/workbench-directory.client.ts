"use client";

import { WORKBENCH_GITIGNORE_CONTENTS } from "../packages/core/src/personal-workbench.ts";
import { assertWorkbenchRecordPath, hasForeignWorkbenchIdentity } from "../packages/core/src/workbench-store.ts";
import type { WorkbenchFile, WorkbenchMutationResult, WorkbenchStorage } from "../packages/core/src/workbench-store.ts";
import type { ProjectId } from "../packages/core/src/run-kernel/types.ts";
import type { FileSystemDirectoryHandleLike } from "./project-directory.client.ts";

/** Browser filesystem boundary; opening it performs no I/O. */
export function browserWorkbenchStorage(directory: FileSystemDirectoryHandleLike): WorkbenchStorage {
  return {
    list: () => list(directory),
    async mutate(path, expectedContents, contents, projectId) {
      assertWorkbenchRecordPath(path);
      return coordinate(projectId, async () => {
        if (hasForeignWorkbenchIdentity(await list(directory), projectId)) {
          return { kind: "blocked", message: "Workbench belongs to a different project. Preserve it before reconciling." };
        }
        const workbench = await directory.getDirectoryHandle(".workbench", { create: true });
        let ignore = await readFile(workbench, ".gitignore");
        if (ignore === null) {
          await writeFile(workbench, ".gitignore", WORKBENCH_GITIGNORE_CONTENTS);
          ignore = await readFile(workbench, ".gitignore");
        }
        if (ignore !== WORKBENCH_GITIGNORE_CONTENTS) {
          throw new Error("Workbench .gitignore must contain exactly '*\\n' before personal content can be written.");
        }
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
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// Web Locks coordinate tabs/windows. The fallback covers callers in this realm;
// cross-host and unsupported-browser races remain best-effort detection only.
const queues = new Map<string, Promise<unknown>>();
function coordinate(projectId: ProjectId, operation: () => Promise<WorkbenchMutationResult>): Promise<WorkbenchMutationResult> {
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
