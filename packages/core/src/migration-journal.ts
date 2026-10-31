import { z } from "zod";
import { projectContentSchemas } from "./project.ts";
import { planSharedProjectMigration } from "./shared-project-migration.ts";
import { serializeSharedProjectFile } from "./shared-project.ts";
import { parseWorkbenchRecord, serializeWorkbenchRecord, WorkbenchValidationError } from "./personal-workbench.ts";
import { stableJsonValue } from "./stable-json.ts";
import type { ProjectId } from "./run-kernel/types.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const operationIdSchema = z.string().regex(/^migration_[a-f0-9]{64}$/);
const compactDraftId = z.string().regex(/^draft_migrated-[a-f0-9]{64}$/);
const descriptor = { sha256: digest, byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) };
const candidates = z.discriminatedUnion("kind", [
  z.object({ ...descriptor, kind: z.literal("selections"), path: z.literal("candidates/selections.json") }).strict(),
  z.object({ ...descriptor, kind: z.literal("draft"), path: z.string(), draftId: compactDraftId,
    asset: z.object({ kind: z.enum(["chat-prompt", "decision-prompt"]), id: projectContentSchemas.entityId("template") }).strict(),
  }).strict(),
]);
/**
 * Settled pending candidates of one operation (D7), beside its immutable
 * journal. Settling never deletes a staged candidate; "Use this one" keeps the
 * active record it replaced under the operation's `replaced/` directory (D6).
 */
const resolutionsSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("migration-resolutions"),
  projectId: projectContentSchemas.entityId("project"), operationId: operationIdSchema,
  resolutions: z.array(z.object({
    candidate: z.union([z.literal("candidates/selections.json"), z.string().regex(/^candidates\/draft_migrated-[a-f0-9]{64}\.json$/)]),
    outcome: z.enum(["used", "discarded"]),
    settledAt: z.iso.datetime({ offset: true }),
    replacedCopy: z.string().optional(),
  }).strict()),
  backupRemovedAt: z.iso.datetime({ offset: true }).optional(),
}).strict().superRefine((record, ctx) => {
  const settled = new Set<string>();
  const replaced = new RegExp(`^migrations/${record.operationId}/replaced/(?:selections|draft_[A-Za-z0-9_-]+)\\.json$`);
  for (const [index, resolution] of record.resolutions.entries()) {
    if (settled.has(resolution.candidate)) ctx.addIssue({ code: "custom", path: ["resolutions", index, "candidate"], message: "A candidate is settled once." });
    settled.add(resolution.candidate);
    if (resolution.replacedCopy === undefined) continue;
    if (resolution.outcome !== "used") ctx.addIssue({ code: "custom", path: ["resolutions", index, "replacedCopy"], message: "Only a used candidate replaces an active record." });
    else if (!replaced.test(resolution.replacedCopy)) ctx.addIssue({ code: "custom", path: ["resolutions", index, "replacedCopy"], message: "A replaced copy stays inside its own operation." });
  }
});
export type MigrationResolutionsV1 = z.infer<typeof resolutionsSchema>;
const resolutionsFieldOrder = new Map(["schemaVersion", "kind", "projectId", "operationId", "resolutions", "backupRemovedAt", "candidate", "outcome", "settledAt", "replacedCopy"].map((field, index) => [field, index]));

export function parseMigrationResolutions(value: unknown, expectedProjectId?: ProjectId): MigrationResolutionsV1 {
  const parsed = resolutionsSchema.safeParse(value);
  if (!parsed.success) throw new WorkbenchValidationError(parsed.error.issues);
  if (expectedProjectId !== undefined && parsed.data.projectId !== expectedProjectId) {
    throw new WorkbenchValidationError([{ code: "custom", path: ["projectId"], message: "Migration resolutions belong to a different project." }]);
  }
  return structuredClone(parsed.data);
}

export function serializeMigrationResolutions(record: MigrationResolutionsV1): string {
  return `${JSON.stringify(stableJsonValue(parseMigrationResolutions(record), { preferredKeyOrder: resolutionsFieldOrder }), null, 2)}\n`;
}

const journalSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("shared-project-migration"),
  operationId: operationIdSchema, projectId: projectContentSchemas.entityId("project"),
  sourceVersion: z.union([z.literal(10), z.literal(11), z.literal(12), z.literal(13), z.literal(14), z.literal(15), z.literal(16), z.literal(17), z.literal(18)]),
  targetVersion: z.literal(16),
  source: z.object({ ...descriptor, path: z.literal("source.project.json") }).strict(),
  shared: z.object({ ...descriptor, path: z.literal("shared.project.json") }).strict(),
  candidates: z.array(candidates).min(1),
}).strict().superRefine((journal, ctx) => {
  const paths = new Set<string>();
  const assets = new Set<string>();
  if (journal.operationId !== `migration_${journal.source.sha256}`) ctx.addIssue({ code: "custom", path: ["operationId"], message: "Operation must identify source bytes." });
  for (const [index, candidate] of journal.candidates.entries()) {
    if (paths.has(candidate.path)) ctx.addIssue({ code: "custom", path: ["candidates", index], message: "Duplicate candidate." });
    paths.add(candidate.path);
    if (candidate.kind === "draft") {
      if (candidate.path !== `candidates/${candidate.draftId}.json` || assets.has(candidate.asset.id)) ctx.addIssue({ code: "custom", path: ["candidates", index], message: "Invalid draft identity or filename." });
      assets.add(candidate.asset.id);
    } else if (index !== 0) ctx.addIssue({ code: "custom", path: ["candidates", index], message: "Selections must be first." });
  }
  if (journal.candidates[0]?.kind !== "selections") ctx.addIssue({ code: "custom", path: ["candidates"], message: "Selections seed is required." });
});
export type MigrationJournalV1 = z.infer<typeof journalSchema>;
export interface MigrationPayload { path: string; bytes: Uint8Array }
export type MigrationFile = MigrationPayload | { path: string; error: string };
/** Files include active records for whole-store identity checks, all paths relative to .workbench. */
export interface MigrationSnapshot { manifest: Uint8Array | null; files: MigrationFile[] }
export type MigrationStageOutcome =
  | { kind: "staged" }
  | { kind: "blocked"; reason: string; message: string }
  | { kind: "conflict"; path: string; phase: "before-write" | "read-back"; actualBytes: Uint8Array | null }
  | { kind: "failed"; path: string; message: string };
/** The host coordinates the entire batch with ordinary workbench mutations. No deletion or manifest writer. */
export interface MigrationStorage {
  read(): Promise<MigrationSnapshot>;
  stage(projectId: ProjectId, files: MigrationPayload[]): Promise<MigrationStageOutcome>;
}
export interface PreparedSharedProjectMigration { projectId: ProjectId; operationId: string; files: MigrationPayload[] }
export type MigrationInspection = { kind: "none" | "incomplete-intent" | "incomplete" | "ready" | "shared-written" | "manifest-diverged" | "needs-review" | "foreign-project"; message?: string };
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
export function sameMigrationBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null || right === null ? left === right : left.length === right.length && left.every((value, index) => value === right[index]);
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function parseMigrationJournal(value: unknown, expectedProjectId?: ProjectId): MigrationJournalV1 {
  const result = journalSchema.parse(value);
  if (expectedProjectId !== undefined && result.projectId !== expectedProjectId) throw new Error("Migration journal belongs to a different project.");
  return structuredClone(result);
}
export function serializeMigrationJournal(journal: MigrationJournalV1): string {
  return `${JSON.stringify(parseMigrationJournal(journal), null, 2)}\n`;
}
export function assertMigrationPath(path: string): string {
  if (!/^migrations\/migration_[a-f0-9]{64}\/(?:source\.project\.json|journal\.json|shared\.project\.json|candidates\/(?:selections|draft_migrated-[a-f0-9]{64})\.json)$/.test(path)) throw new Error("Invalid migration path.");
  return path;
}
/** Preparation assigns bounded persistence IDs; the synchronous logical planner remains unchanged. */
export async function prepareSharedProjectMigration(source: Uint8Array): Promise<PreparedSharedProjectMigration> {
  const plan = planSharedProjectMigration(source);
  const sourceHash = await sha256(plan.sourceBytes);
  const operationId = `migration_${sourceHash}`;
  const root = `migrations/${operationId}/`;
  const sharedBytes = encode(serializeSharedProjectFile(plan.shared));
  const payloads: MigrationPayload[] = [{ path: "candidates/selections.json", bytes: encode(serializeWorkbenchRecord(plan.selections)) }];
  const candidateDescriptors: MigrationJournalV1["candidates"] = [{
    kind: "selections", path: "candidates/selections.json", sha256: await sha256(payloads[0].bytes), byteLength: payloads[0].bytes.length,
  }];
  for (const draft of plan.drafts) {
    const prefix = encode("inference-lens:migrated-draft:v1\0");
    const identity = new Uint8Array(prefix.length + draft.asset.id.length * 2);
    identity.set(prefix);
    const view = new DataView(identity.buffer);
    for (let index = 0; index < draft.asset.id.length; index++) view.setUint16(prefix.length + index * 2, draft.asset.id.charCodeAt(index), true);
    const draftId = `draft_migrated-${await sha256(identity)}`;
    const record = parseWorkbenchRecord({ ...draft, draftId }, plan.shared.projectId);
    const bytes = encode(serializeWorkbenchRecord(record));
    const path = `candidates/${draftId}.json`;
    payloads.push({ path, bytes });
    candidateDescriptors.push({ kind: "draft", path, draftId, asset: draft.asset, sha256: await sha256(bytes), byteLength: bytes.length });
  }
  const journal = parseMigrationJournal({
    schemaVersion: 1, kind: "shared-project-migration", operationId, projectId: plan.shared.projectId,
    sourceVersion: plan.sourceVersion, targetVersion: 16,
    source: { path: "source.project.json", sha256: sourceHash, byteLength: plan.sourceBytes.length },
    shared: { path: "shared.project.json", sha256: await sha256(sharedBytes), byteLength: sharedBytes.length },
    candidates: candidateDescriptors,
  });
  return { projectId: plan.shared.projectId, operationId, files: [
    { path: `${root}source.project.json`, bytes: plan.sourceBytes },
    { path: `${root}journal.json`, bytes: encode(serializeMigrationJournal(journal)) },
    { path: `${root}shared.project.json`, bytes: sharedBytes },
    ...payloads.map(file => ({ path: `${root}${file.path}`, bytes: file.bytes })),
  ] };
}
/** Identity is inspected even in unknown or otherwise invalid JSON envelopes. */
export function hasForeignMigrationIdentity(files: MigrationFile[], projectId: ProjectId): boolean {
  return files.some(file => {
    if (!("bytes" in file)) return false;
    try {
      const value: unknown = JSON.parse(decode(file.bytes));
      return value !== null && typeof value === "object" && "projectId" in value && typeof value.projectId === "string" && value.projectId !== projectId;
    } catch { return false; }
  });
}
export async function inspectSharedProjectMigration(snapshot: MigrationSnapshot, projectId: ProjectId, operationId: string): Promise<MigrationInspection> {
  try {
    operationIdSchema.parse(operationId);
    if (hasForeignMigrationIdentity(snapshot.files, projectId)) return { kind: "foreign-project" };
    // Unavailable migration inventory prevents claiming that an operation is ready.
    if (snapshot.files.some(file => "error" in file && file.path.startsWith("migrations"))) return { kind: "needs-review", message: "Migration inventory is unavailable." };
    const root = `migrations/${operationId}/`;
    const files = snapshot.files.filter(file => file.path === root.slice(0, -1) || file.path.startsWith(root));
    if (!files.length) return { kind: "none" };
    const byPath = new Map<string, Uint8Array>();
    for (const file of files) {
      assertMigrationPath(file.path);
      if (!("bytes" in file) || byPath.has(file.path)) throw new Error("Unreadable or duplicate migration file.");
      byPath.set(file.path, file.bytes);
    }
    const source = byPath.get(`${root}source.project.json`);
    if (!source) throw new Error("Migration source is missing.");
    const expected = await prepareSharedProjectMigration(source);
    if (expected.projectId !== projectId || expected.operationId !== operationId) throw new Error("Migration source identity does not match its operation.");
    const expectedByPath = new Map(expected.files.map(file => [file.path, file]));
    for (const [path, bytes] of byPath) {
      const match = expectedByPath.get(path);
      if (!match || !sameMigrationBytes(bytes, match.bytes)) throw new Error(`Migration bytes differ: ${path}`);
    }
    const journalBytes = byPath.get(`${root}journal.json`);
    if (!journalBytes) return files.length === 1 ? { kind: "incomplete-intent" } : { kind: "needs-review", message: "Outputs exist without a verified intent." };
    parseMigrationJournal(JSON.parse(decode(journalBytes)), projectId);
    // Report manifest divergence even when staging was interrupted.
    const shared = expected.files[2].bytes;
    if (!sameMigrationBytes(snapshot.manifest, source) && !sameMigrationBytes(snapshot.manifest, shared)) return { kind: "manifest-diverged" };
    if (expected.files.some(file => !byPath.has(file.path))) return { kind: "incomplete" };
    return { kind: sameMigrationBytes(snapshot.manifest, source) ? "ready" : "shared-written" };
  } catch (error) { return { kind: "needs-review", message: message(error) }; }
}
/** Explicit call only: verifies caller payloads, stages immutable copies, and confirms the final inventory. */
export async function stageSharedProjectMigration(storage: MigrationStorage, prepared: PreparedSharedProjectMigration): Promise<MigrationStageOutcome> {
  let path = prepared.files[0]?.path ?? "migrations";
  try {
    // Capture caller-owned buffers before the first await.
    const frozen = structuredClone(prepared);
    const source = frozen.files[0];
    if (!source) throw new Error("Migration source is required.");
    const expected = await prepareSharedProjectMigration(source.bytes);
    if (expected.projectId !== frozen.projectId || expected.operationId !== frozen.operationId || expected.files.length !== frozen.files.length || expected.files.some((file, index) => file.path !== frozen.files[index].path || !sameMigrationBytes(file.bytes, frozen.files[index].bytes))) throw new Error("Prepared migration was changed or is unsupported.");
    const snapshot = await storage.read();
    const inspection = await inspectSharedProjectMigration(snapshot, frozen.projectId, frozen.operationId);
    if (inspection.kind === "shared-written") return { kind: "blocked", reason: "shared-written", message: "Shared migration output is already present. Inspect personal recovery before continuing." };
    if (!["none", "incomplete-intent", "incomplete", "ready"].includes(inspection.kind)) return { kind: "blocked", reason: inspection.kind, message: inspection.message ?? inspection.kind };
    if (!sameMigrationBytes(snapshot.manifest, source.bytes)) return { kind: "blocked", reason: "manifest-diverged", message: "Manifest no longer matches the migration source. Inspect before continuing." };
    const outcome = await storage.stage(frozen.projectId, frozen.files);
    if (outcome.kind !== "staged") return outcome;
    path = frozen.files[1].path;
    const confirmed = await inspectSharedProjectMigration(await storage.read(), frozen.projectId, frozen.operationId);
    return confirmed.kind === "ready" ? { kind: "staged" } : { kind: "blocked", reason: confirmed.kind, message: confirmed.message ?? "Staging could not be confirmed." };
  } catch (error) { return { kind: "failed", path, message: message(error) }; }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
