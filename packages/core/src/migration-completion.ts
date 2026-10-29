import type { ProjectId } from "./run-kernel/types.ts";
import {
  inspectSharedProjectMigration, parseMigrationJournal, prepareSharedProjectMigration, sameMigrationBytes,
} from "./migration-journal.ts";
import type { MigrationFile, MigrationInspection, MigrationSnapshot } from "./migration-journal.ts";
import { parseWorkbenchRecordJson } from "./personal-workbench.ts";
import type { WorkbenchRecordV1 } from "./personal-workbench.ts";
import { assertWorkbenchRecordPath, workbenchRecordPath } from "./workbench-store.ts";

export type CandidateDisposition = "present" | "activate" | "existing-selections" | "pending-draft" | "unavailable";
export interface CandidateAssessment {
  kind: "selections" | "draft";
  /** Candidate path inside the operation, e.g. candidates/selections.json. */
  candidate: string;
  /** Active record path relative to .workbench. */
  destination: string;
  disposition: CandidateDisposition;
  reason?: string;
}
export type MigrationCompletionInspection =
  | { kind: "ready" | "shared-written"; candidates: CandidateAssessment[] }
  | { kind: "blocked"; reason: MigrationInspection["kind"]; message?: string };

export interface MigrationCompletionActivation { candidate: string; destination: string; bytes: Uint8Array }
/** Immutable checked plan. Hosts recheck `expected` under their coordination scope before writing. */
export interface MigrationCompletionPlan {
  projectId: ProjectId;
  operationId: string;
  expected: MigrationSnapshot;
  source: Uint8Array;
  shared: Uint8Array;
  activations: MigrationCompletionActivation[];
}
export type MigrationCompletionHostResult =
  | { kind: "stale-plan" }
  | { kind: "blocked"; reason: "protection"; message: string }
  | { kind: "executed"; manifest: "written" | "already-shared" | "failed"; activated: string[]; stopped?: { destination: string; phase: "before-write" | "write" | "read-back"; message: string } };
/** Separate capability from WorkbenchStorage and MigrationStorage: only this writes the manifest. */
export interface MigrationCompletionStorage {
  read(): Promise<MigrationSnapshot>;
  execute(plan: MigrationCompletionPlan): Promise<MigrationCompletionHostResult>;
}
export type SharedOutcome = "unchanged-source" | "confirmed-shared" | "diverged" | "uncertain";
export type MigrationCompletionOutcome =
  | { kind: "blocked"; reason: string; message: string }
  | { kind: "stale-plan" }
  | {
    kind: "completed";
    shared: SharedOutcome;
    personal: { status: "complete" | "recovery-pending" | "stopped"; candidates: CandidateAssessment[]; activated: string[]; stopped?: { destination: string; phase: string; message: string } };
  };

const SELECTIONS = "selections.json";
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const copy = (bytes: Uint8Array) => new Uint8Array(bytes);
const copySnapshot = (snapshot: MigrationSnapshot): MigrationSnapshot => ({
  manifest: snapshot.manifest && copy(snapshot.manifest),
  files: snapshot.files.map((file): MigrationFile => "bytes" in file ? { path: file.path, bytes: copy(file.bytes) } : { ...file }),
});
const isActiveRecordPath = (path: string) => path === SELECTIONS || /^drafts\/[^/]+$/.test(path);

/** The workbench store's checks: a record whose identity does not match its filename is unavailable. */
function parseActiveRecord(path: string, bytes: Uint8Array, projectId: ProjectId): WorkbenchRecordV1 {
  assertWorkbenchRecordPath(path);
  const record = parseWorkbenchRecordJson(decode(bytes), projectId);
  if (workbenchRecordPath(record) !== path) throw new Error("Record identity does not match its filename.");
  return record;
}

interface Verified { projectId: ProjectId; sharedBytes: Uint8Array; sourceBytes: Uint8Array; candidates: { kind: "selections" | "draft"; candidate: string; destination: string; assetId?: string; bytes: Uint8Array }[]; state: "ready" | "shared-written" }

/** Reconstructs everything from preserved source; neither journal hashes nor a previous staged result are trusted. */
async function verify(snapshot: MigrationSnapshot, projectId: ProjectId, operationId: string): Promise<Verified | { blocked: MigrationInspection }> {
  const inspection = await inspectSharedProjectMigration(snapshot, projectId, operationId);
  if (inspection.kind !== "ready" && inspection.kind !== "shared-written") return { blocked: inspection };
  const root = `migrations/${operationId}/`;
  const find = (path: string) => {
    const file = snapshot.files.find(item => item.path === `${root}${path}`);
    if (!file || !("bytes" in file)) throw new Error(`Missing staged file: ${path}`);
    return file.bytes;
  };
  const sourceBytes = find("source.project.json");
  const expected = await prepareSharedProjectMigration(sourceBytes);
  const journal = parseMigrationJournal(JSON.parse(decode(find("journal.json"))), projectId);
  return {
    projectId, state: inspection.kind, sourceBytes: copy(sourceBytes), sharedBytes: copy(expected.files[2].bytes),
    candidates: journal.candidates.map(item => ({
      kind: item.kind, candidate: item.path, bytes: copy(find(item.path)),
      destination: item.kind === "selections" ? SELECTIONS : `drafts/${item.draftId}.json`,
      assetId: item.kind === "draft" ? item.asset.id : undefined,
    })),
  };
}

function assess(snapshot: MigrationSnapshot, verified: Verified): CandidateAssessment[] {
  const active = new Map(snapshot.files.filter(file => isActiveRecordPath(file.path)).map(file => [file.path, file]));
  // Same-asset ownership of other drafts cannot be ruled out through an unreadable or unrecognized draft file.
  const assets = new Set<string>();
  let draftUnavailable = false;
  for (const [path, file] of active) {
    if (!path.startsWith("drafts/")) continue;
    try {
      if (!("bytes" in file)) throw new Error(file.error);
      const record = parseActiveRecord(path, file.bytes, verified.projectId);
      if (record.kind === "draft") assets.add(record.asset.id); else throw new Error("Not a draft record.");
    } catch { draftUnavailable = true; }
  }
  return verified.candidates.map((item): CandidateAssessment => {
    const base = { kind: item.kind, candidate: item.candidate, destination: item.destination };
    const file = active.get(item.destination);
    if (file && !("bytes" in file)) return { ...base, disposition: "unavailable", reason: "Active record is unreadable." };
    if (file && sameMigrationBytes(file.bytes, item.bytes)) return { ...base, disposition: "present" };
    if (item.kind === "selections") {
      if (!file) return { ...base, disposition: "activate" };
      try {
        if (parseActiveRecord(item.destination, file.bytes, verified.projectId).kind === "selections") return { ...base, disposition: "existing-selections", reason: "Existing selections are preserved." };
      } catch { /* falls through */ }
      return { ...base, disposition: "unavailable", reason: "Active selections are corrupt or unrecognized." };
    }
    if (file) {
      try { parseActiveRecord(item.destination, file.bytes, verified.projectId); } catch { return { ...base, disposition: "unavailable", reason: "Active draft is corrupt or unrecognized." }; }
      return { ...base, disposition: "pending-draft", reason: "A different draft occupies the destination." };
    }
    if (item.assetId !== undefined && assets.has(item.assetId)) return { ...base, disposition: "pending-draft", reason: "Another draft already names this asset." };
    if (draftUnavailable) return { ...base, disposition: "unavailable", reason: "An unreadable active draft prevents ruling out a competing draft." };
    return { ...base, disposition: "activate" };
  });
}

export async function inspectSharedProjectMigrationCompletion(snapshot: MigrationSnapshot, projectId: ProjectId, operationId: string): Promise<MigrationCompletionInspection> {
  try {
    const frozen = copySnapshot(snapshot);
    const verified = await verify(frozen, projectId, operationId);
    if ("blocked" in verified) return { kind: "blocked", reason: verified.blocked.kind, message: verified.blocked.message };
    return { kind: verified.state, candidates: assess(frozen, verified) };
  } catch (error) {
    return { kind: "blocked", reason: "needs-review", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Explicit mutation. Never stages or repairs, never accepts caller-supplied manifests or file lists. */
export async function completeSharedProjectMigration(storage: MigrationCompletionStorage, projectId: ProjectId, operationId: string): Promise<MigrationCompletionOutcome> {
  try {
    const snapshot = copySnapshot(await storage.read());
    const verified = await verify(snapshot, projectId, operationId);
    if ("blocked" in verified) return { kind: "blocked", reason: verified.blocked.kind, message: verified.blocked.message ?? verified.blocked.kind };
    const candidates = assess(snapshot, verified);
    const byCandidate = new Map(verified.candidates.map(item => [item.candidate, item]));
    const plan: MigrationCompletionPlan = {
      projectId, operationId, expected: snapshot, source: verified.sourceBytes, shared: verified.sharedBytes,
      activations: candidates.filter(item => item.disposition === "activate").map(item => ({ candidate: item.candidate, destination: item.destination, bytes: copy(byCandidate.get(item.candidate)!.bytes) })),
    };
    const result = await storage.execute(structuredClone(plan));
    if (result.kind === "stale-plan") return { kind: "stale-plan" };
    if (result.kind === "blocked") return { kind: "blocked", reason: result.reason, message: result.message };
    // Claims come from reinspection of persisted bytes, not from the host's report.
    const after = copySnapshot(await storage.read());
    const shared: SharedOutcome = result.manifest === "failed" ? "uncertain"
      : sameMigrationBytes(after.manifest, verified.sharedBytes) ? "confirmed-shared"
        : sameMigrationBytes(after.manifest, verified.sourceBytes) ? "unchanged-source" : "diverged";
    const final = await verify(after, projectId, operationId).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    // A blocked reinspection must not fall back to pre-write dispositions, which could still read as eligible.
    const finalCandidates = final instanceof Error || "blocked" in final
      ? candidates.map(({ kind, candidate, destination }): CandidateAssessment => ({
        kind, candidate, destination, disposition: "unavailable",
        reason: final instanceof Error ? `Reinspection after execution failed: ${final.message}`
          : `Reinspection after execution was blocked: ${final.blocked.kind}${final.blocked.message ? ` (${final.blocked.message})` : ""}.`,
      }))
      : assess(after, final);
    const activated = result.activated.filter(destination => finalCandidates.some(item => item.destination === destination && item.disposition === "present"));
    const unresolved = finalCandidates.some(item => item.disposition === "pending-draft" || item.disposition === "unavailable" || item.disposition === "activate");
    // Activation requires a confirmed shared write; a host reporting otherwise broke the contract.
    const stopped = result.stopped ?? (result.manifest === "failed" && result.activated.length
      ? { destination: result.activated[0], phase: "write" as const, message: "Host reported activations after a failed shared write." }
      : undefined);
    const status = stopped ? "stopped" : unresolved || shared !== "confirmed-shared" ? "recovery-pending" : "complete";
    return { kind: "completed", shared, personal: { status, candidates: finalCandidates, activated, ...(stopped ? { stopped } : {}) } };
  } catch (error) {
    return { kind: "blocked", reason: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
