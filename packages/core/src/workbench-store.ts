import { isMigrationRecoveryPath } from "./migration-journal.ts";
import { parseWorkbenchRecord, parseWorkbenchRecordJson, serializeWorkbenchRecord } from "./personal-workbench.ts";
import type { WorkbenchDraftV1, WorkbenchRecordV1 } from "./personal-workbench.ts";
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

export type WorkbenchRemovalResult =
  | { kind: "removed" }
  /** "not-removable": no recorded removal intent, or an entry the host will not delete. Nothing was deleted. */
  | { kind: "blocked"; reason: WorkbenchHostBlockReason | "not-removable"; message: string };

/** Mutations include protection, identity checks, expected bytes and read-back under a host lock. */
export interface WorkbenchStorage {
  list(): Promise<WorkbenchFile[]>;
  /** Active record paths, and the recovery paths `assertWorkbenchRecoveryPath` accepts. */
  mutate(path: string, expectedContents: string | null, contents: string | null, projectId: ProjectId): Promise<WorkbenchMutationResult>;
  /**
   * W3: deletes one migration operation's directory, `resolutions.json` last,
   * only when that record holds `backupRemovedAt`. Refuses links and entries
   * outside the operation's fixed layout.
   */
  removeMigrationOperation(operationId: string, projectId: ProjectId): Promise<WorkbenchRemovalResult>;
}

const OPERATION_ID = /^migration_[a-f0-9]{64}$/;
export function assertMigrationOperationId(operationId: string): string {
  if (!OPERATION_ID.test(operationId)) throw new Error("Invalid migration operation.");
  return operationId;
}

/** A replaced draft outside any migration (W1). */
export function replacedDraftPath(draftId: string): string {
  return assertWorkbenchRecoveryPath(`replaced/${draftId}.json`);
}

/**
 * Recovery files reconciliation writes: replaced drafts (W1) and, inside a
 * migration operation, its resolutions and replaced copies (D7, D6). Never
 * loaded as active records.
 */
export function assertWorkbenchRecoveryPath(path: string): string {
  if (!/^replaced\/draft_[A-Za-z0-9_-]+\.json$/.test(path) && !isMigrationRecoveryPath(path)) {
    throw new Error("Invalid workbench recovery path.");
  }
  return path;
}

/** Every path a host mutation may touch. */
export function assertWorkbenchWritablePath(path: string): string {
  if (!/^replaced\/draft_[A-Za-z0-9_-]+\.json$/.test(path) && !isMigrationRecoveryPath(path)) return assertWorkbenchRecordPath(path);
  return path;
}

export function assertWorkbenchRecordPath(path: string): string {
  if (path !== "selections.json" && !/^drafts\/draft_[A-Za-z0-9_-]+\.json$/.test(path) && !/^scratch\/scratch_[A-Za-z0-9_-]+\.json$/.test(path)) {
    throw new Error("Invalid workbench record path.");
  }
  return path;
}

export function workbenchRecordPath(record: WorkbenchRecordV1): string {
  switch (record.kind) {
    case "selections": return assertWorkbenchRecordPath("selections.json");
    case "draft": return assertWorkbenchRecordPath(`drafts/${record.draftId}.json`);
    case "scratch": return assertWorkbenchRecordPath(`scratch/${record.scratchId}.json`);
  }
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
  const replaced: Array<{ path: string; record: WorkbenchDraftV1 }> = [];
  const unavailable: Array<{ path: string; message: string; contents?: string }> = [];
  const expected = new Map<string, string | null>();
  const blocked = new Set<string>();
  let writeBlocked = hasForeignWorkbenchIdentity(files, projectId);
  for (const file of files) {
    // Journals/candidates are identity inventory, not active recovery records.
    // Reconciliation's own files there are tracked so they can be rewritten.
    if (file.path.startsWith("migrations/")) {
      if (isMigrationRecoveryPath(file.path) && "contents" in file) expected.set(file.path, file.contents);
      else if (isMigrationRecoveryPath(file.path)) blocked.add(file.path);
      continue;
    }
    if (file.path.startsWith("replaced/")) {
      try {
        if ("error" in file) throw new Error(file.error);
        assertWorkbenchRecoveryPath(file.path);
        const record = parseWorkbenchRecordJson(file.contents, projectId);
        if (record.kind !== "draft" || replacedDraftPath(record.draftId) !== file.path) throw new Error("A replaced copy must be a draft named by its ID.");
        replaced.push({ path: file.path, record });
        expected.set(file.path, file.contents);
      } catch (error) {
        blocked.add(file.path);
        unavailable.push({ path: file.path, message: errorMessage(error), ...("contents" in file ? { contents: file.contents } : {}) });
      }
      continue;
    }
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
      assertWorkbenchWritablePath(path);
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
    hasRecord(path: string): boolean {
      return blocked.has(path) || expected.get(path) != null;
    },
    get writeBlocked() { return writeBlocked; },
    async save(record: WorkbenchRecordV1): Promise<WorkbenchStoreOutcome> {
      const validated = parseWorkbenchRecord(record, projectId);
      // Freeze before yielding: edits made while saving belong to the next save.
      return mutate(workbenchRecordPath(validated), serializeWorkbenchRecord(validated));
    },
    delete(path: string): Promise<WorkbenchStoreOutcome> { return mutate(path, null); },
    /** Initial read of `replaced/` (W1). */
    replaced,
    /** Writes or deletes a recovery file; `contents` must already be its serialized record. */
    writeRecovery(path: string, contents: string | null): Promise<WorkbenchStoreOutcome> {
      try { assertWorkbenchRecoveryPath(path); } catch (error) { return Promise.reject(error); }
      return mutate(path, contents);
    },
    /**
     * Explicit reconciliation of one path: re-reads it, adopts what is on disk
     * as the expectation and lifts a conflict or failure block. The caller
     * decides what to do with the contents. Passing the intended contents for
     * a retry keeps the path blocked if a third party changed the record.
     */
    refresh(path: string, retryContents?: string | null): Promise<{ kind: "refreshed"; path: string; contents: string | null } | { kind: "failed" | "conflict"; path: string; message: string }> {
      const operation = queue.then(async () => {
        assertWorkbenchWritablePath(path);
        try {
          const file = (await storage.list()).find(entry => entry.path === path);
          if (file && "error" in file) throw new Error(file.error);
          const contents = file ? file.contents : null;
          // Retry may confirm a write that landed, but only an explicit conflict
          // choice may adopt an unrelated change as the next write's baseline.
          if (retryContents !== undefined && contents !== retryContents && contents !== (expected.get(path) ?? null)) {
            blocked.add(path);
            return { kind: "conflict" as const, path, message: "The record on disk changed. Compare the copies before choosing one." };
          }
          if (contents === null) expected.delete(path); else expected.set(path, contents);
          blocked.delete(path);
          return { kind: "refreshed" as const, path, contents };
        } catch (error) {
          return { kind: "failed" as const, path, message: errorMessage(error) };
        }
      });
      queue = operation.catch(() => {});
      return operation;
    },
    /** W3: the operation's `backupRemovedAt` must already be written. */
    removeMigrationOperation(operationId: string): Promise<{ kind: "removed"; operationId: string } | { kind: "blocked"; reason: WorkbenchHostBlockReason | "not-removable"; operationId: string; message: string } | { kind: "failed"; operationId: string; message: string }> {
      try { assertMigrationOperationId(operationId); } catch (error) { return Promise.reject(error); }
      const operation = queue.then(async () => {
        if (writeBlocked) return { kind: "blocked" as const, reason: "foreign-project" as const, operationId, message: FOREIGN_PROJECT_MESSAGE };
        try {
          const result = await storage.removeMigrationOperation(operationId, projectId);
          if (result.kind === "blocked") return { ...result, operationId };
          const root = `migrations/${operationId}/`;
          for (const path of [...expected.keys()]) if (path.startsWith(root)) expected.delete(path);
          for (const path of [...blocked]) if (path.startsWith(root)) blocked.delete(path);
          return { kind: "removed" as const, operationId };
        } catch (error) {
          return { kind: "failed" as const, operationId, message: errorMessage(error) };
        }
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}

export const FOREIGN_PROJECT_MESSAGE = "Workbench belongs to a different project. Preserve it before reconciling.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
