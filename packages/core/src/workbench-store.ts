import { parseWorkbenchRecord, parseWorkbenchRecordJson, serializeWorkbenchRecord } from "./personal-workbench.ts";
import type { WorkbenchRecordV1 } from "./personal-workbench.ts";
import type { ProjectId } from "./run-kernel/types.ts";

export type WorkbenchFile = { path: string; contents: string } | { path: string; error: string };
export type WorkbenchMutationResult =
  | { kind: "written" }
  | { kind: "conflict"; phase: "before-write" | "read-back"; actualContents: string | null }
  | { kind: "blocked"; reason: WorkbenchHostBlockReason; message: string };

/**
 * Host refusals made before the record is touched. A foreign project blocks the
 * whole store; a refused ignore policy blocks only this attempt, so saves resume
 * once the policy is fixed.
 */
export type WorkbenchHostBlockReason = "foreign-project" | "protection";
export type WorkbenchBlockReason = WorkbenchHostBlockReason | "reconciliation" | "not-loaded";

/** Mutations include protection, identity checks, expected bytes and read-back under a host lock. */
export interface WorkbenchStorage {
  list(): Promise<WorkbenchFile[]>;
  mutate(path: string, expectedContents: string | null, contents: string | null, projectId: ProjectId): Promise<WorkbenchMutationResult>;
}

export function assertWorkbenchRecordPath(path: string): string {
  if (path !== "selections.json" && !/^drafts\/draft_[A-Za-z0-9_-]+\.json$/.test(path)) {
    throw new Error("Invalid workbench record path.");
  }
  return path;
}

export function workbenchRecordPath(record: WorkbenchRecordV1): string {
  return assertWorkbenchRecordPath(record.kind === "selections" ? "selections.json" : `drafts/${record.draftId}.json`);
}

/** Inspect identity even when the rest of a future/damaged record cannot parse. */
export function hasForeignWorkbenchIdentity(files: WorkbenchFile[], projectId: ProjectId): boolean {
  return files.some(file => {
    if (!("contents" in file)) return false;
    try {
      const value: unknown = JSON.parse(file.contents);
      return value !== null && typeof value === "object" && "projectId" in value
        && typeof value.projectId === "string" && value.projectId !== projectId;
    } catch { return false; }
  });
}

export type WorkbenchStoreOutcome =
  | { kind: "saved" | "deleted"; path: string }
  | { kind: "conflict"; path: string; phase: "before-write" | "read-back"; expectedContents: string | null; actualContents: string | null; attemptedContents: string | null }
  | { kind: "blocked"; reason: WorkbenchBlockReason; path: string; message: string; attemptedContents: string | null }
  | { kind: "failed"; path: string; message: string; attemptedContents: string | null };

/** An explicit open captures expectations once. Conflicts never silently adopt disk contents. */
export async function openWorkbenchStore(storage: WorkbenchStorage, projectId: ProjectId) {
  const files = await storage.list();
  const records: Array<{ path: string; record: WorkbenchRecordV1; contents: string }> = [];
  const unavailable: Array<{ path: string; message: string; contents?: string }> = [];
  const expected = new Map<string, string | null>();
  const blocked = new Set<string>();
  let writeBlocked = hasForeignWorkbenchIdentity(files, projectId);
  for (const file of files) {
    // Journals/candidates are identity inventory, not active recovery records.
    if (file.path.startsWith("migrations/")) continue;
    try {
      if ("error" in file) throw new Error(file.error);
      assertWorkbenchRecordPath(file.path);
      const record = parseWorkbenchRecordJson(file.contents, projectId);
      if (workbenchRecordPath(record) !== file.path) throw new Error("Record identity does not match its filename.");
      records.push({ path: file.path, record, contents: file.contents });
      expected.set(file.path, file.contents);
    } catch (error) {
      blocked.add(file.path);
      unavailable.push({ path: file.path, message: errorMessage(error), ...("contents" in file ? { contents: file.contents } : {}) });
    }
  }
  // Also serialize mutations through this store, so queued saves use the latest
  // confirmed expectation, rather than capturing it before their predecessor.
  let queue: Promise<unknown> = Promise.resolve();
  function mutate(path: string, contents: string | null): Promise<WorkbenchStoreOutcome> {
    const operation = queue.then(async (): Promise<WorkbenchStoreOutcome> => {
      assertWorkbenchRecordPath(path);
      if (writeBlocked) {
        return { kind: "blocked", reason: "foreign-project", path, attemptedContents: contents, message: FOREIGN_PROJECT_MESSAGE };
      }
      if (blocked.has(path)) {
        return { kind: "blocked", reason: "reconciliation", path, attemptedContents: contents, message: "This record needs explicit reconciliation before further writes." };
      }
      const expectedContents = expected.get(path) ?? null;
      if (contents === null && !expected.has(path)) {
        return { kind: "blocked", reason: "not-loaded", path, attemptedContents: null, message: "Only a loaded or saved valid record can be deleted." };
      }
      try {
        const result = await storage.mutate(path, expectedContents, contents, projectId);
        if (result.kind === "blocked") {
          if (result.reason === "foreign-project") writeBlocked = true;
          return { ...result, path, attemptedContents: contents };
        }
        if (result.kind === "conflict") {
          blocked.add(path);
          return { ...result, path, expectedContents, attemptedContents: contents };
        }
        expected.set(path, contents);
        return { kind: contents === null ? "deleted" : "saved", path };
      } catch (error) {
        // The host may have failed after changing bytes. Never retry implicitly.
        blocked.add(path);
        return { kind: "failed", path, message: errorMessage(error), attemptedContents: contents };
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    /** Initial read only; callers keep their own current editor content. */
    records,
    unavailable,
    get writeBlocked() { return writeBlocked; },
    async save(record: WorkbenchRecordV1): Promise<WorkbenchStoreOutcome> {
      const validated = parseWorkbenchRecord(record, projectId);
      // Freeze before yielding: edits made while saving belong to the next save.
      return mutate(workbenchRecordPath(validated), serializeWorkbenchRecord(validated));
    },
    delete(path: string): Promise<WorkbenchStoreOutcome> { return mutate(path, null); },
  };
}

export const FOREIGN_PROJECT_MESSAGE = "Workbench belongs to a different project. Preserve it before reconciling.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
