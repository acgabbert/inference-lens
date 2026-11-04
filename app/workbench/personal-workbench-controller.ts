import { ProjectValidationError } from "../../packages/core/src/project.ts";
import type { ProjectFile, PromptTemplateRevision } from "../../packages/core/src/project.ts";
import { isPromptDraft, parseWorkbenchRecord } from "../../packages/core/src/personal-workbench.ts";
import type {
  WorkbenchDraftV1,
  WorkbenchPromptDraftV1,
  WorkbenchRecordV1,
  WorkbenchScratchV1,
} from "../../packages/core/src/personal-workbench.ts";
import { openWorkbenchStore, workbenchRecordPath } from "../../packages/core/src/workbench-store.ts";
import type { WorkbenchStorage, WorkbenchStoreOutcome } from "../../packages/core/src/workbench-store.ts";
import {
  clearPublication,
  completePublication,
  publishPromptDraft,
  reconcilePublication,
} from "../../packages/core/src/workbench-publication.ts";
import { randomUUID } from "../../packages/core/src/random-id.ts";
import { stableJsonValue } from "../../packages/core/src/stable-json.ts";
import type { ProjectId } from "../../packages/core/src/run-kernel/types.ts";
import type { SharedWriteOutcome } from "../use-project-workspace.client.ts";

/**
 * The personal workbench's state and protocols, apart from React
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "`usePersonalWorkbench`"). One
 * controller serves one adoption; `usePersonalWorkbench` makes a new one each
 * time the workspace adopts a document.
 *
 * In-memory records are the editor's truth. Disk is written behind them after
 * a debounce (D14), through `openWorkbenchStore`, which serializes writes and
 * never adopts disk contents over a conflict. Step 2 routes prompt drafts only;
 * the other arms load, reconcile and appear in recovery, but no owner edits them
 * yet.
 */

export type WorkbenchAssetRef = WorkbenchDraftV1["asset"];
export type PromptAssetRef = WorkbenchPromptDraftV1["asset"];
export type PromptDraftBase = WorkbenchPromptDraftV1["base"];
export type PromptDraftContent = WorkbenchPromptDraftV1["edited"];

export type PersonalWorkbenchStatus =
  | { kind: "off" }
  /** No folder, or a legacy folder (S1): drafts live in memory only. */
  | { kind: "session" }
  | { kind: "loading" }
  | { kind: "ready"; saving: boolean }
  | { kind: "blocked"; reason: "foreign-project" | "protection"; message: string };

/** One entry of the D8 Recovery drawer; step 6 renders it. */
export interface RecoveryItem {
  kind: "unreadable" | "record-conflict" | "publication-conflict" | "orphaned-draft" | "competing-draft" | "write-failed";
  path: string;
  message: string;
  asset?: WorkbenchAssetRef;
}

export interface UnsavedDraftSummary {
  asset: WorkbenchAssetRef;
  draftId: WorkbenchDraftV1["draftId"];
  /** False while a debounced write is pending or after it failed. */
  persisted: boolean;
}

export type PublishOutcome =
  /** `project` is the shared document as confirmed. */
  | { kind: "published"; revisionId: string; keptEdits: boolean; project: ProjectFile }
  /** The draft is kept in every case below. */
  | { kind: "conflict" | "failed" | "blocked"; message: string };

export interface PersonalWorkbenchControllerOptions {
  projectId: ProjectId;
  storage: WorkbenchStorage | null;
  /** Session-only records to start with: lifted legacy drafts or a carried session. */
  seeds: readonly WorkbenchRecordV1[];
  onChange(): void;
  debounceMs?: number;
  setTimer?(callback: () => void, delay: number): unknown;
  clearTimer?(timer: unknown): void;
  newDraftId?(): WorkbenchDraftV1["draftId"];
  now?(): string;
}

const DEFAULT_DEBOUNCE_MS = 500;

function assetKey(asset: WorkbenchAssetRef): string {
  return `${asset.kind}:${asset.id}`;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Legacy parity: a draft equal to its base, with no revision label, is no draft. */
function matchesBase(base: PromptDraftBase, edited: PromptDraftContent): boolean {
  const snapshot = base.snapshot as PromptTemplateRevision;
  const body = "messages" in edited
    ? { messages: edited.messages, variableDefaults: edited.variableDefaults }
    : { decision: edited.decision, variableDefaults: edited.variableDefaults };
  const baseBody = "messages" in snapshot
    ? { messages: snapshot.messages, variableDefaults: snapshot.variableDefaults }
    : { decision: snapshot.decision, variableDefaults: snapshot.variableDefaults };
  return !edited.revisionName && same(body, baseBody);
}

type Store = Awaited<ReturnType<typeof openWorkbenchStore>>;

export class PersonalWorkbenchController {
  readonly projectId: ProjectId;
  private readonly storage: WorkbenchStorage | null;
  private readonly options: PersonalWorkbenchControllerOptions;
  private store: Store | null = null;
  private statusValue: PersonalWorkbenchStatus;
  /** Records by path: the editor's truth. */
  private readonly records = new Map<string, WorkbenchRecordV1>();
  /** Paths whose in-memory record differs from what was last written. */
  private readonly dirty = new Set<string>();
  /** Paths whose disk copy should be deleted at the next flush. */
  private readonly deletions = new Set<string>();
  private readonly timers = new Map<string, unknown>();
  private readonly publishing = new Set<string>();
  private recoveryItems: RecoveryItem[] = [];
  private pendingWrites = 0;
  private closed = false;

  constructor(options: PersonalWorkbenchControllerOptions) {
    this.options = options;
    this.projectId = options.projectId;
    this.storage = options.storage;
    this.statusValue = options.storage ? { kind: "loading" } : { kind: "session" };
    for (const seed of options.seeds) this.adoptSeed(seed);
  }

  get status(): PersonalWorkbenchStatus {
    return this.statusValue;
  }

  get recovery(): readonly RecoveryItem[] {
    return this.recoveryItems;
  }

  /** Every record held now, for carrying a session forward into a folder. */
  get allRecords(): WorkbenchRecordV1[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  get unsavedDrafts(): UnsavedDraftSummary[] {
    const drafts: UnsavedDraftSummary[] = [];
    for (const [path, record] of this.records) {
      if (record.kind !== "draft") continue;
      drafts.push({
        asset: record.asset,
        draftId: record.draftId,
        persisted: Boolean(this.store) && !this.dirty.has(path),
      });
    }
    return drafts;
  }

  draftFor(asset: WorkbenchAssetRef): WorkbenchDraftV1 | undefined {
    const key = assetKey(asset);
    for (const record of this.records.values()) {
      if (record.kind === "draft" && assetKey(record.asset) === key) return record;
    }
    return undefined;
  }

  /**
   * Reads the store and settles every interrupted publication against the
   * shared document before reporting `ready` (protocol step 4).
   */
  async open(shared: ProjectFile): Promise<void> {
    if (!this.storage) {
      this.markOrphans(shared);
      this.changed();
      return;
    }
    let store: Store;
    try {
      store = await openWorkbenchStore(this.storage, this.projectId);
    } catch (error) {
      if (this.closed) return;
      this.statusValue = { kind: "blocked", reason: "protection", message: errorMessage(error, "Could not read the personal workbench.") };
      this.changed();
      return;
    }
    if (this.closed) return;
    this.store = store;
    for (const entry of store.unavailable) {
      this.recoveryItems.push({ kind: "unreadable", path: entry.path, message: entry.message });
    }
    if (store.writeBlocked) {
      this.statusValue = { kind: "blocked", reason: "foreign-project", message: "This folder's personal workbench belongs to a different project." };
      this.changed();
      return;
    }
    // Carried session records stay in memory; a stored draft for the same
    // asset wins and the carried copy is reported, never written over it.
    const carried = [...this.records.values()];
    this.records.clear();
    this.dirty.clear();
    for (const { path, record } of store.records) {
      if (record.kind === "draft" && this.draftFor(record.asset)) {
        this.recoveryItems.push({ kind: "competing-draft", path, asset: record.asset, message: "Another draft for this prompt is already active." });
        continue;
      }
      this.records.set(path, record);
    }
    for (const record of carried) {
      if (record.kind === "draft" && this.draftFor(record.asset)) {
        this.recoveryItems.push({
          kind: "competing-draft", path: workbenchRecordPath(record), asset: record.asset,
          message: "A session draft was not saved because this folder already has a draft for the same prompt.",
        });
        continue;
      }
      const path = workbenchRecordPath(record);
      this.records.set(path, record);
      this.dirty.add(path);
    }
    await this.settlePublications(shared);
    if (this.closed) return;
    this.markOrphans(shared);
    this.statusValue = { kind: "ready", saving: false };
    this.changed();
    if (this.dirty.size || this.deletions.size) await this.flush();
  }

  /** Records or replaces the asset's one active draft (D6); persisted after a debounce. */
  updatePromptDraft(asset: PromptAssetRef, base: PromptDraftBase, edited: PromptDraftContent): void {
    const existing = this.draftFor(asset);
    const path = existing ? workbenchRecordPath(existing) : undefined;
    const inFlight = path !== undefined && this.publishing.has(path);
    if (existing && !inFlight && matchesBase(base, edited)) {
      this.dropRecord(path!);
      return;
    }
    if (!existing && matchesBase(base, edited)) return;
    const record = parseWorkbenchRecord({
      schemaVersion: 1,
      kind: "draft",
      projectId: this.projectId,
      draftId: existing?.draftId ?? this.options.newDraftId?.() ?? `draft_${randomUUID()}`,
      asset,
      // A publication in flight keeps its base: the intent names it as parent.
      base: inFlight ? (existing as WorkbenchPromptDraftV1).base : base,
      edited,
      ...(existing?.publishing ? { publishing: existing.publishing } : {}),
    }, this.projectId);
    const recordPath = workbenchRecordPath(record);
    this.records.set(recordPath, record);
    this.deletions.delete(recordPath);
    this.schedule(recordPath);
  }

  async discardDraft(asset: WorkbenchAssetRef): Promise<WorkbenchStoreOutcome | undefined> {
    const existing = this.draftFor(asset);
    if (!existing) return undefined;
    const path = workbenchRecordPath(existing);
    if (this.publishing.has(path)) {
      return { kind: "blocked", reason: "reconciliation", path, message: "This draft is being saved.", attemptedContents: null };
    }
    this.dropRecord(path);
    return this.persist(path);
  }

  /** Writes every queued change now: before replacement, close or publication. */
  async flush(): Promise<void> {
    const paths = new Set([...this.dirty, ...this.deletions]);
    for (const path of paths) {
      this.cancelTimer(path);
      await this.persist(path);
    }
  }

  close(): void {
    this.closed = true;
    for (const path of [...this.timers.keys()]) this.cancelTimer(path);
  }

  /**
   * The four-step protocol for a prompt draft. `writeShared` is the
   * workspace's explicit shared write; `extend` adds the direct shared edits
   * that ride with this Save (a template rename), applied deterministically
   * with the publication.
   */
  async publishPromptDraft(
    asset: PromptAssetRef,
    shared: ProjectFile,
    writeShared: (update: (current: ProjectFile) => ProjectFile) => Promise<SharedWriteOutcome>,
    extend: (project: ProjectFile) => ProjectFile = (project) => project,
  ): Promise<PublishOutcome> {
    if (this.statusValue.kind === "blocked" || this.statusValue.kind === "loading" || this.statusValue.kind === "off") {
      return { kind: "blocked", message: "The personal workbench is not ready to save." };
    }
    const existing = this.draftFor(asset);
    if (!existing || !isPromptDraft(existing)) {
      return { kind: "failed", message: "There is no draft to save." };
    }
    const path = workbenchRecordPath(existing);
    if (this.publishing.has(path)) return { kind: "blocked", message: "This draft is already being saved." };
    if (existing.publishing) {
      return { kind: "conflict", message: "An earlier save of this draft needs review before it can be saved again." };
    }
    this.publishing.add(path);
    this.setSaving();
    try {
      const options = { idSuffix: randomUUID(), createdAt: this.options.now?.() ?? new Date().toISOString() };
      let planned: ReturnType<typeof publishPromptDraft>;
      try {
        planned = publishPromptDraft(shared, existing, options);
      } catch (error) {
        return { kind: "failed", message: errorMessage(error, "Could not save the prompt.") };
      }
      if (planned.kind === "unchanged") {
        // The base is confirmed in `shared`; nothing to write but the extension.
        let confirmed = shared;
        if (extend(shared) !== shared) {
          const outcome = await writeShared(extend);
          if (outcome.kind !== "confirmed") return outcome;
          confirmed = outcome.project;
        }
        this.dropRecord(path);
        await this.persist(path);
        return { kind: "published", revisionId: existing.base.revisionId, keptEdits: false, project: confirmed };
      }
      // Step 1: the intent, written and read back before the shared write.
      const withIntent = parseWorkbenchRecord({ ...existing, publishing: planned.intent }, this.projectId) as WorkbenchPromptDraftV1;
      this.records.set(path, withIntent);
      this.dirty.add(path);
      const recorded = await this.persist(path);
      if (recorded && recorded.kind !== "saved") {
        this.restoreWithoutIntent(path);
        return { kind: recorded.kind === "conflict" ? "conflict" : recorded.kind === "blocked" ? "blocked" : "failed", message: storeMessage(recorded) };
      }
      // Step 2: the shared write, re-applied deterministically by the workspace.
      const outcome = await writeShared((current) => {
        const replanned = publishPromptDraft(current, existing, options);
        if (replanned.kind !== "publish") {
          throw new ProjectValidationError([{ code: "custom", path: [], message: "The draft no longer differs from its base." }]);
        }
        return extend(replanned.project);
      });
      if (outcome.kind !== "confirmed") {
        this.restoreWithoutIntent(path);
        await this.persist(path);
        return outcome;
      }
      // Step 3: clear, or keep later edits based on the published revision.
      const current = this.records.get(path) as WorkbenchPromptDraftV1 | undefined;
      const completion = completePublication(outcome.project, current ?? withIntent, [] as WorkbenchScratchV1[]);
      if (completion.record) {
        this.records.set(path, completion.record);
        this.dirty.add(path);
      } else {
        this.dropRecord(path);
      }
      await this.persist(path);
      return { kind: "published", revisionId: planned.intent.revisionId, keptEdits: Boolean(completion.record), project: outcome.project };
    } finally {
      this.publishing.delete(path);
      this.setSaving();
      this.changed();
    }
  }

  private adoptSeed(seed: WorkbenchRecordV1): void {
    const record = parseWorkbenchRecord(seed, this.projectId);
    if (record.kind === "draft" && this.draftFor(record.asset)) return;
    this.records.set(workbenchRecordPath(record), record);
  }

  private restoreWithoutIntent(path: string): void {
    const current = this.records.get(path);
    if (current && current.kind !== "selections") {
      this.records.set(path, clearPublication(current));
      this.dirty.add(path);
    }
  }

  private dropRecord(path: string): void {
    this.cancelTimer(path);
    this.records.delete(path);
    this.dirty.delete(path);
    this.deletions.add(path);
    this.changed();
  }

  private async settlePublications(shared: ProjectFile): Promise<void> {
    for (const [path, record] of [...this.records]) {
      if (record.kind === "selections" || !record.publishing) continue;
      if (record.kind === "scratch") {
        // No owner publishes a scratch yet (step 3); leave it for review.
        this.recoveryItems.push({ kind: "publication-conflict", path, message: "This local request was being saved. A later build settles it." });
        continue;
      }
      let state: ReturnType<typeof reconcilePublication>;
      try {
        state = reconcilePublication(shared, record);
      } catch (error) {
        this.recoveryItems.push({ kind: "publication-conflict", path, asset: record.asset, message: errorMessage(error, "Could not check an earlier save.") });
        continue;
      }
      if (state === "conflict") {
        this.recoveryItems.push({
          kind: "publication-conflict", path, asset: record.asset,
          message: "An earlier save of this draft found different content under the same revision. Compare before saving again.",
        });
        continue;
      }
      if (state === "not-published") {
        this.records.set(path, clearPublication(record));
      } else {
        const { record: next } = completePublication(shared, record, []);
        if (next) {
          this.records.set(path, next);
        } else {
          this.records.delete(path);
          this.deletions.add(path);
          continue;
        }
      }
      this.dirty.add(path);
    }
  }

  private markOrphans(shared: ProjectFile): void {
    for (const [path, record] of this.records) {
      if (!isPromptDraft(record)) continue;
      const kind = record.asset.kind === "chat-prompt" ? "chat" : "decision";
      const template = shared.promptTemplates.find(({ id }) => id === record.asset.id);
      const base = template?.kind === kind && (template.revisions as PromptTemplateRevision[]).some(({ id }) => id === record.base.revisionId);
      if (!base) {
        this.recoveryItems.push({
          kind: "orphaned-draft", path, asset: record.asset,
          message: template ? "This draft's base revision no longer exists." : "This draft's prompt no longer exists.",
        });
      }
    }
  }

  private schedule(path: string): void {
    this.dirty.add(path);
    this.changed();
    if (!this.store) return;
    this.cancelTimer(path);
    const delay = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const run = () => {
      this.timers.delete(path);
      void this.persist(path);
    };
    this.timers.set(path, this.options.setTimer ? this.options.setTimer(run, delay) : setTimeout(run, delay));
  }

  private cancelTimer(path: string): void {
    const timer = this.timers.get(path);
    if (timer === undefined) return;
    if (this.options.clearTimer) this.options.clearTimer(timer);
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
    this.timers.delete(path);
  }

  /**
   * Writes the path's current in-memory state. Without a store there is nothing
   * to write; the record stays in memory and counts as unsaved.
   */
  private async persist(path: string): Promise<WorkbenchStoreOutcome | undefined> {
    const store = this.store;
    if (!store || this.closed) return undefined;
    const record = this.records.get(path);
    let outcome: WorkbenchStoreOutcome;
    this.pendingWrites += 1;
    this.setSaving();
    try {
      if (record) {
        if (!this.dirty.has(path)) return { kind: "saved", path };
        this.dirty.delete(path);
        outcome = await store.save(record);
      } else {
        if (!this.deletions.has(path)) return undefined;
        this.deletions.delete(path);
        // Never written: nothing on disk to delete.
        outcome = await store.delete(path);
        if (outcome.kind === "blocked" && outcome.reason === "not-loaded") return { kind: "deleted", path };
      }
    } finally {
      this.pendingWrites -= 1;
      this.setSaving();
    }
    if (outcome.kind === "saved" || outcome.kind === "deleted") {
      this.recoveryItems = this.recoveryItems.filter((item) => !(item.kind === "write-failed" && item.path === path));
    } else {
      // Keep the work in memory and say so; the store refuses further writes
      // to a conflicted path until it is reconciled.
      if (record) this.dirty.add(path);
      this.recoveryItems = [
        ...this.recoveryItems.filter((item) => !(item.kind === "write-failed" && item.path === path)),
        {
          kind: outcome.kind === "conflict" ? "record-conflict" : "write-failed",
          path,
          message: storeMessage(outcome),
          ...(record && record.kind === "draft" ? { asset: record.asset } : {}),
        },
      ];
      if (outcome.kind === "blocked" && outcome.reason === "foreign-project") {
        this.statusValue = { kind: "blocked", reason: "foreign-project", message: outcome.message };
      }
    }
    this.changed();
    return outcome;
  }

  private setSaving(): void {
    if (this.statusValue.kind !== "ready") return;
    const saving = this.pendingWrites > 0 || this.publishing.size > 0;
    if (this.statusValue.saving !== saving) {
      this.statusValue = { kind: "ready", saving };
      this.changed();
    }
  }

  private changed(): void {
    if (!this.closed) this.options.onChange();
  }
}

function storeMessage(outcome: WorkbenchStoreOutcome): string {
  switch (outcome.kind) {
    case "saved":
    case "deleted":
      return "";
    case "conflict":
      return "The personal workbench record changed outside this window. Your draft is kept here.";
    case "blocked":
    case "failed":
      return outcome.message;
  }
}
