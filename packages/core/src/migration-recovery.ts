import {
  assertMigrationPath,
  isMigrationRecoveryPath,
  parseMigrationJournal,
  parseMigrationResolutions,
  prepareSharedProjectMigration,
  sameMigrationBytes,
} from "./migration-journal.ts";
import type { MigrationFile, MigrationJournalV1, MigrationResolutionsV1, MigrationSnapshot } from "./migration-journal.ts";
import { parseWorkbenchRecordJson } from "./personal-workbench.ts";
import type { WorkbenchDraftV1, WorkbenchSelectionsV1 } from "./personal-workbench.ts";
import type { ProjectId } from "./run-kernel/types.ts";

/**
 * Reconciliation's read of the migration inventory (step 6b, "Candidates are
 * assessed without the manifest"). Completion's own inspection refuses once
 * `project.json` moves past an operation's output; this one verifies each
 * operation against its preserved source, as completion does, and classifies
 * its candidates against the active records and its resolutions record.
 *
 * Pure apart from hashing: nothing here writes.
 */

export type MigrationCandidateState =
  /** Nothing holds its destination or its asset: "Use this one" activates it. */
  | "absent"
  /** Another active draft holds its asset or its destination. */
  | "competing"
  /** A selections candidate that met existing selections (W2: Compare and Discard only). */
  | "existing-selections"
  /** An unreadable active record prevents ruling out a competitor. */
  | "unavailable";

export interface MigrationRecoveryCandidate {
  operationId: string;
  /** The journal's candidate path, as resolutions name it. */
  candidate: `candidates/${string}`;
  /** Workbench-relative path of the staged candidate. */
  path: string;
  kind: "selections" | "draft";
  /** The active record path it would become. */
  destination: string;
  record: WorkbenchDraftV1 | WorkbenchSelectionsV1;
  state: MigrationCandidateState;
  /** The active record it competes with, when there is one. */
  competitor?: string;
  reason: string;
}

export interface MigrationRecoveryOperation {
  operationId: string;
  resolutions?: MigrationResolutionsV1;
  /**
   * Unsettled candidates whose exact bytes are active: completion (or an
   * interrupted "Use this one") activated them. Record them as `used`, so a
   * later edit or save of the draft never brings the candidate back.
   */
  present: `candidates/${string}`[];
  pending: MigrationRecoveryCandidate[];
  /** The manifest is still exactly this operation's output and absent candidates wait for Finish (6a). */
  unfinished: boolean;
  /** `backupRemovedAt` is set: an interrupted removal to finish (W3). */
  removing: boolean;
  /** Every file under the operation, for the removal confirmation. */
  files: string[];
}

export interface MigrationRecoveryInventory {
  operations: MigrationRecoveryOperation[];
  /** Operations or files that cannot be verified: shown with their path and message only. */
  unreadable: { path: string; message: string }[];
}

const OPERATION_PATH = /^migrations\/(migration_[a-f0-9]{64})(?:\/|$)/;
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function migrationReplacedCopyPath(operationId: string, draftId: string): string {
  const path = `migrations/${operationId}/replaced/${draftId}.json`;
  if (!isMigrationRecoveryPath(path)) throw new Error("Invalid replaced copy path.");
  return path;
}

export function migrationResolutionsPath(operationId: string): string {
  const path = `migrations/${operationId}/resolutions.json`;
  if (!isMigrationRecoveryPath(path)) throw new Error("Invalid resolutions path.");
  return path;
}

/** Nothing is left to settle, or a removal was already started. */
export function removableMigrationOperation(operation: MigrationRecoveryOperation): boolean {
  return operation.removing || (!operation.unfinished && !operation.pending.length && !operation.present.length);
}

export function settleMigrationCandidate(
  resolutions: MigrationResolutionsV1 | undefined,
  input: {
    projectId: ProjectId;
    operationId: string;
    candidate: string;
    outcome: "used" | "discarded";
    settledAt: string;
    replacedCopy?: string;
  },
): MigrationResolutionsV1 {
  const current = resolutions ?? emptyResolutions(input.projectId, input.operationId);
  if (current.operationId !== input.operationId) throw new Error("Resolutions belong to another operation.");
  if (current.resolutions.some(({ candidate }) => candidate === input.candidate)) throw new Error("A candidate is settled once.");
  return parseMigrationResolutions({
    ...current,
    resolutions: [...current.resolutions, {
      candidate: input.candidate,
      outcome: input.outcome,
      settledAt: input.settledAt,
      ...(input.replacedCopy ? { replacedCopy: input.replacedCopy } : {}),
    }],
  }, input.projectId);
}

/** W3: the removal's intent, written before anything is deleted. */
export function markMigrationBackupRemoval(
  resolutions: MigrationResolutionsV1 | undefined,
  input: { projectId: ProjectId; operationId: string; at: string },
): MigrationResolutionsV1 {
  const current = resolutions ?? emptyResolutions(input.projectId, input.operationId);
  if (current.operationId !== input.operationId) throw new Error("Resolutions belong to another operation.");
  return parseMigrationResolutions({ ...current, backupRemovedAt: current.backupRemovedAt ?? input.at }, input.projectId);
}

function emptyResolutions(projectId: ProjectId, operationId: string): MigrationResolutionsV1 {
  return parseMigrationResolutions({ schemaVersion: 1, kind: "migration-resolutions", projectId, operationId, resolutions: [] }, projectId);
}

interface ActiveDraft { path: string; record?: WorkbenchDraftV1; bytes?: Uint8Array }

export async function assessMigrationRecovery(snapshot: MigrationSnapshot, projectId: ProjectId): Promise<MigrationRecoveryInventory> {
  const inventory: MigrationRecoveryInventory = { operations: [], unreadable: [] };
  const operations = new Map<string, MigrationFile[]>();
  for (const file of snapshot.files) {
    if (!file.path.startsWith("migrations/") && file.path !== "migrations") continue;
    const operationId = OPERATION_PATH.exec(file.path)?.[1];
    if (!operationId) {
      inventory.unreadable.push({ path: file.path, message: "error" in file ? file.error : "Unexpected migration entry." });
      continue;
    }
    operations.set(operationId, [...operations.get(operationId) ?? [], file]);
  }

  const selections = snapshot.files.find(({ path }) => path === "selections.json");
  const drafts: ActiveDraft[] = snapshot.files.filter(({ path }) => /^drafts\/[^/]+$/.test(path)).map((file) => {
    if (!("bytes" in file)) return { path: file.path };
    try {
      const record = parseWorkbenchRecordJson(decode(file.bytes), projectId);
      return record.kind === "draft" && `drafts/${record.draftId}.json` === file.path ? { path: file.path, record, bytes: file.bytes } : { path: file.path, bytes: file.bytes };
    } catch {
      return { path: file.path, bytes: file.bytes };
    }
  });

  for (const [operationId, files] of [...operations].sort(([a], [b]) => a < b ? -1 : 1)) {
    const root = `migrations/${operationId}/`;
    const paths = files.map(({ path }) => path).sort();
    const unreadable = files.find((file) => "error" in file);
    if (unreadable) {
      inventory.unreadable.push({ path: unreadable.path, message: "error" in unreadable ? unreadable.error : "" });
      continue;
    }
    const byPath = new Map(files.map((file) => [file.path, (file as { bytes: Uint8Array }).bytes]));
    let resolutions: MigrationResolutionsV1 | undefined;
    const resolutionsBytes = byPath.get(`${root}resolutions.json`);
    if (resolutionsBytes) {
      try {
        resolutions = parseMigrationResolutions(JSON.parse(decode(resolutionsBytes)), projectId);
        if (resolutions.operationId !== operationId) throw new Error("Resolutions name another operation.");
      } catch (error) {
        inventory.unreadable.push({ path: `${root}resolutions.json`, message: message(error) });
        continue;
      }
    }
    const operation: MigrationRecoveryOperation = {
      operationId, ...(resolutions ? { resolutions } : {}), present: [], pending: [], unfinished: false, removing: Boolean(resolutions?.backupRemovedAt), files: paths,
    };
    if (operation.removing) {
      inventory.operations.push(operation);
      continue;
    }
    let verified: { journal?: MigrationJournalV1; shared: Uint8Array };
    try {
      verified = await verifyOperation(byPath, projectId, operationId);
    } catch (error) {
      inventory.unreadable.push({ path: `migrations/${operationId}`, message: message(error) });
      continue;
    }
    const settled = new Set(resolutions?.resolutions.map(({ candidate }) => candidate));
    const absent: MigrationRecoveryCandidate[] = [];
    for (const item of verified.journal?.candidates ?? []) {
      const bytes = byPath.get(`${root}${item.path}`);
      if (!bytes || settled.has(item.path)) continue;
      const candidate = item.path as `candidates/${string}`;
      const record = parseWorkbenchRecordJson(decode(bytes), projectId) as WorkbenchDraftV1 | WorkbenchSelectionsV1;
      const destination = item.kind === "selections" ? "selections.json" : `drafts/${item.draftId}.json`;
      const base = { operationId, candidate, path: `${root}${item.path}`, kind: item.kind, destination, record };
      if (item.kind === "selections") {
        if (!selections) {
          absent.push({ ...base, state: "absent", reason: "No personal selections exist." });
        } else if (!("bytes" in selections)) {
          operation.pending.push({ ...base, state: "unavailable", reason: "Active selections are unreadable." });
        } else if (sameMigrationBytes(selections.bytes, bytes)) {
          operation.present.push(candidate);
        } else {
          let readable = false;
          try { readable = parseWorkbenchRecordJson(decode(selections.bytes), projectId).kind === "selections"; } catch { /* unavailable below */ }
          operation.pending.push(readable
            ? { ...base, state: "existing-selections", competitor: "selections.json", reason: "Existing selections were kept." }
            : { ...base, state: "unavailable", reason: "Active selections are corrupt or unrecognized." });
        }
        continue;
      }
      const occupant = drafts.find(({ path }) => path === destination);
      if (occupant?.bytes && sameMigrationBytes(occupant.bytes, bytes)) {
        operation.present.push(candidate);
        continue;
      }
      if (occupant && !occupant.record) {
        operation.pending.push({ ...base, state: "unavailable", reason: "The active draft at its destination is unreadable." });
        continue;
      }
      const rival = occupant ?? drafts.find(({ record: active }) => active?.asset.kind === item.asset.kind && active.asset.id === item.asset.id);
      if (rival) {
        operation.pending.push({ ...base, state: "competing", competitor: rival.path, reason: "Another draft for the same prompt is active." });
      } else if (drafts.some(({ record: active }) => !active)) {
        operation.pending.push({ ...base, state: "unavailable", reason: "An unreadable active draft prevents ruling out a competing draft." });
      } else {
        absent.push({ ...base, state: "absent", reason: "This draft is only in the migration backup." });
      }
    }
    if (absent.length && sameMigrationBytes(snapshot.manifest, verified.shared)) operation.unfinished = true;
    else operation.pending.push(...absent);
    operation.pending.sort((left, right) => left.candidate < right.candidate ? -1 : 1);
    inventory.operations.push(operation);
  }
  return inventory;
}

/**
 * Staged outputs must be exactly what the preserved source prepares. The
 * journal may be missing (an interrupted staging): there are then no
 * candidates, only files to remove.
 */
async function verifyOperation(byPath: Map<string, Uint8Array>, projectId: ProjectId, operationId: string): Promise<{ journal?: MigrationJournalV1; shared: Uint8Array }> {
  const root = `migrations/${operationId}/`;
  for (const path of byPath.keys()) if (!isMigrationRecoveryPath(path)) assertMigrationPath(path);
  const source = byPath.get(`${root}source.project.json`);
  if (!source) throw new Error("Migration source is missing.");
  const expected = await prepareSharedProjectMigration(source);
  if (expected.projectId !== projectId || expected.operationId !== operationId) throw new Error("Migration source identity does not match its operation.");
  const expectedByPath = new Map(expected.files.map((file) => [file.path, file.bytes]));
  for (const [path, bytes] of byPath) {
    if (isMigrationRecoveryPath(path)) continue;
    const match = expectedByPath.get(path);
    if (!match || !sameMigrationBytes(bytes, match)) throw new Error(`Migration bytes differ: ${path}`);
  }
  const journalBytes = byPath.get(`${root}journal.json`);
  return {
    ...(journalBytes ? { journal: parseMigrationJournal(JSON.parse(decode(journalBytes)), projectId) } : {}),
    shared: expected.files[2].bytes,
  };
}
