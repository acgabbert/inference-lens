import { createPromptTemplate, ProjectValidationError } from "../../packages/core/src/project.ts";
import { createDecisionPromptTemplate } from "../../packages/core/src/decision-template.ts";
import { isMigrationRecoveryPath, readMigrationResolutions, serializeMigrationResolutions } from "../../packages/core/src/migration-journal.ts";
import type { MigrationResolutionsV1, MigrationSnapshot } from "../../packages/core/src/migration-journal.ts";
import {
  assessMigrationRecovery,
  markMigrationBackupRemoval,
  migrationReplacedCopyPath,
  migrationResolutionsPath,
  removableMigrationOperation,
  settleMigrationCandidate,
} from "../../packages/core/src/migration-recovery.ts";
import type { MigrationCandidateState, MigrationRecoveryOperation } from "../../packages/core/src/migration-recovery.ts";
import type {
  ProjectConversationItem,
  ProjectConversationRevision,
  ProjectDecisionRequestRevision,
  ProjectFile,
  PromptTemplateRevision,
} from "../../packages/core/src/project.ts";
import { isPromptDraft, parseWorkbenchRecord, parseWorkbenchRecordJson, serializeWorkbenchRecord } from "../../packages/core/src/personal-workbench.ts";
import type {
  LocalChatInput,
  LocalDecisionInput,
  WorkbenchChatRequestDraftV1,
  WorkbenchDecisionRequestContent,
  WorkbenchDecisionRequestDraftV1,
  WorkbenchDraftV1,
  WorkbenchPromptDraftV1,
  WorkbenchRecordV1,
  WorkbenchScratchV1,
  WorkbenchSelectionsV1,
} from "../../packages/core/src/personal-workbench.ts";
import { openWorkbenchStore, replacedDraftPath, workbenchRecordPath } from "../../packages/core/src/workbench-store.ts";
import type { WorkbenchStorage, WorkbenchStoreOutcome } from "../../packages/core/src/workbench-store.ts";
import {
  clearPublication,
  completePublication,
  publishChatRequestDraft,
  publishDecisionRequestDraft,
  publishPromptDraft,
  publishScratch,
  reconcilePublication,
} from "../../packages/core/src/workbench-publication.ts";
import { randomUUID } from "../../packages/core/src/random-id.ts";
import { stableJsonValue } from "../../packages/core/src/stable-json.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/types.ts";
import type { ConversationId, DecisionRequestId, ProjectId } from "../../packages/core/src/run-kernel/types.ts";
import type { SharedWriteOutcome } from "../use-project-workspace.client.ts";

/**
 * The personal workbench's state and protocols, apart from React
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "`usePersonalWorkbench`"). One
 * controller serves one adoption; `usePersonalWorkbench` makes a new one each
 * time the workspace adopts a document.
 *
 * In-memory records are the editor's truth. Disk is written behind them after
 * a debounce (D14), through `openWorkbenchStore`, which serializes writes and
 * never adopts disk contents over a conflict. Step 2 routes prompt drafts,
 * step 3 chat request drafts, chat scratch records and the chat selection, and
 * step 4 the decision equivalents.
 */

export type WorkbenchAssetRef = WorkbenchDraftV1["asset"];
export type PromptAssetRef = WorkbenchPromptDraftV1["asset"];
export type PromptDraftBase = WorkbenchPromptDraftV1["base"];
export type PromptDraftContent = WorkbenchPromptDraftV1["edited"];
export type ChatScratchParent = NonNullable<Extract<WorkbenchScratchV1["request"], { kind: "chat" }>["parent"]>;
export type DecisionScratchParent = NonNullable<Extract<WorkbenchScratchV1["request"], { kind: "decision" }>["parent"]>;
export type ScratchBranchPoint = NonNullable<WorkbenchScratchV1["branchedFrom"]>;
export type ChatExecutionOverrides = NonNullable<NonNullable<WorkbenchSelectionsV1["chat"]>["execution"]>;
type WriteShared = (update: (current: ProjectFile) => ProjectFile) => Promise<SharedWriteOutcome>;

export type PersonalWorkbenchStatus =
  | { kind: "off" }
  /** No folder, or a legacy folder (S1): drafts live in memory only. */
  | { kind: "session" }
  | { kind: "loading" }
  | { kind: "ready"; saving: boolean }
  | { kind: "blocked"; reason: "foreign-project" | "protection"; message: string };

/** What the drawer may offer for an item (V4). */
export type RecoveryAction = "compare" | "use" | "discard" | "save-as-new" | "keep-as-draft" | "retry";

/** One entry of the D8 Recovery drawer, as the controller holds it. */
export interface RecoveryItem {
  kind:
    | "unreadable"
    | "record-conflict"
    | "publication-conflict"
    | "orphaned-draft"
    | "competing-draft"
    | "write-failed"
    /** A draft "Use this one" replaced outside a migration (W1). */
    | "replaced-draft"
    /** A migration candidate nothing has settled (D6, D7). */
    | "migration-candidate";
  path: string;
  message: string;
  asset?: WorkbenchAssetRef;
  /** The other copy: a session copy, a stored competitor, a replaced draft or a candidate. */
  record?: WorkbenchRecordV1;
  /** The record exists only in memory (V2): unload warns until it is reconciled. */
  memory?: boolean;
  /** A competing draft that is a file at `path`, not loaded as active. */
  stored?: boolean;
  /** The save landed but its local children were not updated: Retry settles it. */
  settle?: "children";
  operationId?: string;
  /** The journal's candidate path, as resolutions name it. */
  candidate?: string;
  state?: MigrationCandidateState;
  /** The active record a candidate competes with. */
  competitor?: string;
}

/** A recovery item as the drawer reads it: addressed by `id`, with its actions. */
export interface RecoveryEntry extends RecoveryItem {
  id: string;
  actions: RecoveryAction[];
}

/** One migration operation's backup, for "Remove migration backup" (D7, W3). */
export interface MigrationBackupSummary {
  operationId: string;
  /** Nothing is pending: the backup may be removed. */
  removable: boolean;
  /** A removal was interrupted: finish it. */
  removing: boolean;
  /** Absent candidates wait for Finish upgrade (6a). */
  unfinished: boolean;
  files: string[];
}

export interface RecoveryComparison {
  /** `record` is undefined when this side deleted it, such as this window's discarded draft. */
  incoming: { label: string; record: unknown };
  current?: { label: string; record: unknown };
}

export type ReconcileOutcome =
  | { kind: "settled" }
  /** Nothing settled; the item stays. */
  | { kind: "failed" | "blocked"; message: string };

function recoveryId(item: RecoveryItem): string {
  return `${item.kind}:${item.path}`;
}

function recoveryActions(item: RecoveryItem): RecoveryAction[] {
  switch (item.kind) {
    case "unreadable": return [];
    case "write-failed": return ["retry"];
    case "record-conflict": return item.memory || item.path === SELECTIONS_PATH ? ["compare", "discard"] : ["compare", "use", "discard"];
    case "publication-conflict": return item.settle === "children" ? ["retry"] : ["compare", "keep-as-draft", "discard"];
    case "orphaned-draft": return ["compare", "save-as-new", "discard"];
    case "competing-draft":
    case "replaced-draft": return ["compare", "use", "discard"];
    case "migration-candidate":
      if (item.state === "existing-selections") return ["compare", "discard"];
      if (item.state === "unavailable") return ["discard"];
      return ["compare", "use", "discard"];
  }
}

const SETTLED: ReconcileOutcome = { kind: "settled" };
function refused(kind: "failed" | "blocked", message: string): Exclude<ReconcileOutcome, { kind: "settled" }> {
  return { kind, message };
}

/**
 * What the upgrade that reopened this folder did (V2). `activated` are the
 * record paths completion created; `lifted` are the drafts the legacy file
 * held, which the staged candidates preserve.
 */
export interface UpgradeCarry {
  activated: readonly string[];
  lifted: readonly WorkbenchPromptDraftV1[];
  stagedSelections?: WorkbenchSelectionsV1;
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
  /** The folder's migration inventory as exact bytes, for pending candidates (6b). */
  migrations?: { read(): Promise<MigrationSnapshot> } | null;
  /** Session-only records to start with: lifted legacy drafts or a carried session. */
  seeds: readonly WorkbenchRecordV1[];
  /** Set when an upgrade just reopened this folder, to settle carried drafts (V2). */
  upgrade?: UpgradeCarry;
  onChange(): void;
  debounceMs?: number;
  setTimer?(callback: () => void, delay: number): unknown;
  clearTimer?(timer: unknown): void;
  newDraftId?(): WorkbenchDraftV1["draftId"];
  newScratchId?(): WorkbenchScratchV1["scratchId"];
  newLocalConversationId?(): ConversationId;
  now?(): string;
}

const DEFAULT_DEBOUNCE_MS = 500;
const SELECTIONS_PATH = "selections.json";

function assetKey(asset: WorkbenchAssetRef): string {
  return `${asset.kind}:${asset.id}`;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

/** A saved decision revision's editable content, as a record holds it. */
export function decisionRevisionContent(revision: ProjectDecisionRequestRevision): WorkbenchDecisionRequestContent {
  return revision.kind === "inline"
    ? { kind: "inline", decision: structuredClone(revision.decision), values: { ...revision.values } }
    : { kind: "template-use", templateId: revision.templateId, templateRevisionId: revision.templateRevisionId, overrides: { ...revision.overrides } };
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
  /** Migration operations by ID, as assessed at open and settled since. */
  private readonly migrationOperations = new Map<string, MigrationRecoveryOperation>();
  private resolutionWrites: Promise<void> = Promise.resolve();
  /** Recovery files known on disk: `replaced/` and each operation's own files. */
  private readonly recoveryFiles = new Set<string>();
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

  get recovery(): readonly RecoveryEntry[] {
    return this.recoveryItems.map((item) => ({ ...item, id: recoveryId(item), actions: recoveryActions(item) }));
  }

  get migrationBackups(): MigrationBackupSummary[] {
    return [...this.migrationOperations.values()].map((operation) => ({
      operationId: operation.operationId,
      removable: removableMigrationOperation(operation),
      removing: operation.removing,
      unfinished: operation.unfinished,
      files: [...operation.files],
    }));
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

  /** Local work a reload would lose: held only in memory, or not yet written. */
  get hasUnpersistedWork(): boolean {
    if (this.recoveryItems.some((item) => item.memory)) return true;
    for (const [path, record] of this.records) {
      if (record.kind === "selections") continue;
      if (!this.store || this.dirty.has(path)) return true;
    }
    return false;
  }

  /**
   * Drafts and scratch requests held only in memory, with no folder to write
   * them to (no-folder sessions, pre-v19 folders). Replacing the session loses
   * them (Z3). Queued writes to a folder are not counted: the outgoing session
   * flushes them on a switch.
   */
  get sessionOnlyWorkCount(): number {
    let count = this.recoveryItems.filter((item) => item.memory).length;
    if (this.store) return count;
    for (const record of this.records.values()) if (record.kind !== "selections") count += 1;
    return count;
  }

  draftFor(asset: WorkbenchAssetRef): WorkbenchDraftV1 | undefined {
    const key = assetKey(asset);
    for (const record of this.records.values()) {
      if (record.kind === "draft" && assetKey(record.asset) === key) return record;
    }
    return undefined;
  }

  /** The chat input this user selected; undefined inherits the launch default. */
  get chatSelection(): LocalChatInput | undefined {
    const selections = this.records.get(SELECTIONS_PATH) as WorkbenchSelectionsV1 | undefined;
    return selections?.chat?.selectedInput ? structuredClone(selections.chat.selectedInput) : undefined;
  }

  get scratches(): WorkbenchScratchV1[] {
    return [...this.records.values()].filter((record): record is WorkbenchScratchV1 => record.kind === "scratch");
  }

  scratch(scratchId: string): WorkbenchScratchV1 | undefined {
    const record = this.records.get(`scratch/${scratchId}.json`);
    return record?.kind === "scratch" ? record : undefined;
  }

  draftById(draftId: string): WorkbenchDraftV1 | undefined {
    const record = this.records.get(`drafts/${draftId}.json`);
    return record?.kind === "draft" ? record : undefined;
  }

  /** The decision input this user selected; undefined inherits the launch default. */
  get decisionSelection(): LocalDecisionInput | undefined {
    const selections = this.records.get(SELECTIONS_PATH) as WorkbenchSelectionsV1 | undefined;
    return selections?.decision?.selectedInput ? structuredClone(selections.decision.selectedInput) : undefined;
  }

  /** Moves the personal chat selection; never `defaults` (D10). */
  selectChat(input: LocalChatInput | undefined): void {
    if (same(this.chatSelection, input)) return;
    const current = this.records.get(SELECTIONS_PATH) as WorkbenchSelectionsV1 | undefined;
    const chat = { ...(current?.chat ?? {}) };
    if (input) chat.selectedInput = structuredClone(input);
    else delete chat.selectedInput;
    this.writeSelections({
      ...(current?.decision ? { decision: current.decision } : {}),
      ...(Object.keys(chat).length ? { chat } : {}),
    });
  }

  /** Personal execution choices over the launch defaults (step 5); undefined inherits them. */
  get chatExecution(): ChatExecutionOverrides | undefined {
    const selections = this.records.get(SELECTIONS_PATH) as WorkbenchSelectionsV1 | undefined;
    return selections?.chat?.execution ? structuredClone(selections.chat.execution) : undefined;
  }

  /**
   * Replaces the execution overrides. The caller keeps them sparse (T2); this
   * owner only records them, beside the selections it never disturbs.
   */
  setChatExecution(execution: ChatExecutionOverrides | undefined): void {
    if (same(this.chatExecution, execution)) return;
    const current = this.records.get(SELECTIONS_PATH) as WorkbenchSelectionsV1 | undefined;
    const chat = { ...(current?.chat ?? {}) };
    if (execution && Object.keys(execution).length) chat.execution = structuredClone(execution);
    else delete chat.execution;
    this.writeSelections({
      ...(current?.decision ? { decision: current.decision } : {}),
      ...(Object.keys(chat).length ? { chat } : {}),
    });
  }

  /** Moves the personal decision selection; never `defaults` (D11). */
  selectDecision(input: LocalDecisionInput | undefined): void {
    if (same(this.decisionSelection, input)) return;
    const current = this.records.get(SELECTIONS_PATH) as WorkbenchSelectionsV1 | undefined;
    this.writeSelections({
      ...(current?.chat ? { chat: current.chat } : {}),
      ...(input ? { decision: { selectedInput: structuredClone(input) } } : {}),
    });
  }

  private writeSelections(fields: Pick<WorkbenchSelectionsV1, "chat" | "decision">): void {
    const record = parseWorkbenchRecord({ schemaVersion: 1, kind: "selections", projectId: this.projectId, ...fields }, this.projectId);
    this.records.set(SELECTIONS_PATH, record);
    this.deletions.delete(SELECTIONS_PATH);
    this.schedule(SELECTIONS_PATH);
  }

  /**
   * Records the request's one active draft over a saved revision and selects
   * it. `draftId` names the draft the composer is editing; another draft for
   * the same request is kept as a scratch rather than overwritten (D6). Items
   * equal to the base drop the draft and select the base. Undefined when there
   * is no draft afterwards, or when an earlier save of the draft needs review.
   */
  updateChatRequestDraft(
    base: ProjectConversationRevision,
    items: ProjectConversationItem[],
    options: { draftId?: string } = {},
  ): WorkbenchChatRequestDraftV1 | undefined {
    const asset = { kind: "chat-request" as const, id: base.conversationId };
    let existing = this.draftFor(asset) as WorkbenchChatRequestDraftV1 | undefined;
    if (existing && existing.draftId !== options.draftId) {
      const path = workbenchRecordPath(existing);
      if (existing.publishing || this.publishing.has(path)) return undefined;
      this.createChatScratch(existing.edited.items, {
        parent: { kind: "saved-conversation-revision", revisionId: existing.base.revisionId },
        select: false,
      });
      this.dropRecord(path);
      existing = undefined;
    }
    const path = existing ? workbenchRecordPath(existing) : undefined;
    const inFlight = path !== undefined && this.publishing.has(path);
    const matches = same(existing && inFlight ? existing.base.snapshot.items : base.items, items);
    if (matches && !inFlight) {
      if (path) this.dropRecord(path);
      this.selectChat({ kind: "saved-conversation-revision", revisionId: (existing?.base.revisionId ?? base.id) as typeof base.id });
      return undefined;
    }
    const record = parseWorkbenchRecord({
      schemaVersion: 1,
      kind: "draft",
      projectId: this.projectId,
      draftId: existing?.draftId ?? this.options.newDraftId?.() ?? `draft_${randomUUID()}`,
      asset,
      // A publication in flight keeps its base: the intent names it as parent.
      base: existing && inFlight ? existing.base : { revisionId: base.id, snapshot: structuredClone(base) },
      edited: { items: structuredClone(items) },
      ...(existing?.publishing ? { publishing: existing.publishing } : {}),
    }, this.projectId) as WorkbenchChatRequestDraftV1;
    const recordPath = workbenchRecordPath(record);
    this.records.set(recordPath, record);
    this.deletions.delete(recordPath);
    this.schedule(recordPath);
    this.selectChat({ kind: "draft", draftId: record.draftId });
    return record;
  }

  /** A local chat request: a branch, or a draft kept aside (D10). Selected unless `select` is false. */
  createChatScratch(
    items: ProjectConversationItem[],
    options: { parent?: ChatScratchParent; branchedFrom?: ScratchBranchPoint; select?: boolean },
  ): WorkbenchScratchV1 {
    const { parent } = options;
    if (parent?.kind === "scratch" && this.publishing.has(`scratch/${parent.scratchId}.json`)) {
      // Completion reparents a publishing scratch's children from a fixed inventory.
      throw new Error("Wait for the parent request to finish saving before branching from it.");
    }
    const record = parseWorkbenchRecord({
      schemaVersion: 1,
      kind: "scratch",
      projectId: this.projectId,
      scratchId: this.options.newScratchId?.() ?? `scratch_${randomUUID()}`,
      createdAt: this.options.now?.() ?? new Date().toISOString(),
      localConversationId: this.options.newLocalConversationId?.() ?? createEntityId("conversation", `local-${randomUUID()}`),
      request: { kind: "chat", items: structuredClone(items), ...(parent ? { parent } : {}) },
      ...(options.branchedFrom ? { branchedFrom: options.branchedFrom } : {}),
    }, this.projectId) as WorkbenchScratchV1;
    const path = workbenchRecordPath(record);
    this.records.set(path, record);
    this.schedule(path);
    if (options.select !== false) this.selectChat({ kind: "scratch", scratchId: record.scratchId });
    return record;
  }

  updateChatScratch(scratchId: string, items: ProjectConversationItem[]): void {
    const existing = this.scratch(scratchId);
    if (!existing || existing.request.kind !== "chat") return;
    const record = parseWorkbenchRecord({
      ...existing,
      request: { ...existing.request, items: structuredClone(items) },
    }, this.projectId);
    const path = workbenchRecordPath(record);
    this.records.set(path, record);
    this.schedule(path);
  }

  /** Discards the request's draft and selects its base when the draft was selected. */
  async discardChatRequestDraft(conversationId: ConversationId): Promise<WorkbenchStoreOutcome | undefined> {
    const existing = this.draftFor({ kind: "chat-request", id: conversationId }) as WorkbenchChatRequestDraftV1 | undefined;
    if (!existing) return undefined;
    const outcome = await this.discardDraft(existing.asset);
    if (outcome?.kind === "blocked" && outcome.reason === "reconciliation") return outcome;
    const selection = this.chatSelection;
    if (selection?.kind === "draft" && selection.draftId === existing.draftId) {
      this.selectChat({ kind: "saved-conversation-revision", revisionId: existing.base.revisionId });
    }
    return outcome;
  }

  /**
   * Discards a scratch. Its local children are reparented on its own parent,
   * and a selection of it moves to that parent, or to the launch default.
   */
  async discardScratch(scratchId: string): Promise<WorkbenchStoreOutcome | undefined> {
    const existing = this.scratch(scratchId);
    if (!existing) return undefined;
    const path = workbenchRecordPath(existing);
    if (this.publishing.has(path)) {
      return { kind: "blocked", reason: "reconciliation", path, message: "This request is being saved.", attemptedContents: null };
    }
    const parent = existing.request.parent;
    for (const child of this.scratches) {
      if (child.request.parent?.kind !== "scratch" || child.request.parent.scratchId !== scratchId) continue;
      const request = { ...child.request } as WorkbenchScratchV1["request"];
      if (parent) request.parent = parent as never;
      else delete request.parent;
      const next = parseWorkbenchRecord({ ...child, request }, this.projectId);
      const childPath = workbenchRecordPath(next);
      this.records.set(childPath, next);
      this.schedule(childPath);
    }
    if (existing.request.kind === "chat") {
      const selection = this.chatSelection;
      if (selection?.kind === "scratch" && selection.scratchId === scratchId) {
        this.selectChat(existing.request.parent);
      }
    } else {
      const selection = this.decisionSelection;
      if (selection?.kind === "scratch" && selection.scratchId === scratchId) {
        this.selectDecision(existing.request.parent);
      }
    }
    this.dropRecord(path);
    return this.persist(path);
  }

  /** Saves the request's draft as a child revision (D10); see `publishRecord`. */
  async publishChatRequestDraft(conversationId: ConversationId, shared: ProjectFile, writeShared: WriteShared): Promise<PublishOutcome> {
    const blocked = this.publicationBlocked();
    if (blocked) return blocked;
    const existing = this.draftFor({ kind: "chat-request", id: conversationId }) as WorkbenchChatRequestDraftV1 | undefined;
    if (!existing) return { kind: "failed", message: "There is no draft to save." };
    const pending = this.pendingPublication(existing);
    if (pending) return pending;
    const options = this.publicationOptions();
    let planned: ReturnType<typeof publishChatRequestDraft>;
    try {
      planned = publishChatRequestDraft(shared, existing, options);
    } catch (error) {
      return { kind: "failed", message: errorMessage(error, "Could not save the request.") };
    }
    const path = workbenchRecordPath(existing);
    if (planned.kind === "unchanged") {
      this.dropRecord(path);
      await this.persist(path);
      this.selectChat({ kind: "saved-conversation-revision", revisionId: existing.base.revisionId });
      return { kind: "published", revisionId: existing.base.revisionId, keptEdits: false, project: shared };
    }
    const outcome = await this.publishRecord(path, (project) => {
      const replanned = publishChatRequestDraft(project, existing, options);
      if (replanned.kind !== "publish") throw new ProjectValidationError([{ code: "custom", path: [], message: "The draft no longer differs from its base." }]);
      return replanned;
    }, shared, writeShared);
    if (outcome.kind === "published") this.selectAfterPublication(existing, outcome);
    return outcome;
  }

  /**
   * Saves a scratch: as a child of its nearest saved ancestor, or as a new
   * request named `name` when it has none (D10).
   */
  async publishScratch(scratchId: string, shared: ProjectFile, writeShared: WriteShared, name?: string): Promise<PublishOutcome> {
    const blocked = this.publicationBlocked();
    if (blocked) return blocked;
    const existing = this.scratch(scratchId);
    if (!existing) return { kind: "failed", message: "There is no local request to save." };
    const pending = this.pendingPublication(existing);
    if (pending) return pending;
    const options = { ...this.publicationOptions(), scratches: this.scratches.filter(({ scratchId: id }) => id !== scratchId), ...(name ? { name } : {}) };
    try {
      publishScratch(shared, existing, options);
    } catch (error) {
      return { kind: "failed", message: errorMessage(error, "Could not save the request.") };
    }
    const outcome = await this.publishRecord(workbenchRecordPath(existing), (project) => publishScratch(project, existing, options), shared, writeShared);
    if (outcome.kind === "published") this.selectAfterPublication(existing, outcome);
    return outcome;
  }

  /**
   * The decision equivalent of `updateChatRequestDraft` (D11): the request's
   * one active draft over a saved revision, selected. Another draft for the
   * same request is kept as a scratch; content equal to the base drops the
   * draft and selects the base. The caller supplies content the record can
   * hold: inline values only for variables the decision uses, and sparse
   * template-use overrides.
   */
  updateDecisionRequestDraft(
    base: ProjectDecisionRequestRevision,
    content: WorkbenchDecisionRequestContent,
    options: { draftId?: string } = {},
  ): WorkbenchDecisionRequestDraftV1 | undefined {
    const asset = { kind: "decision-request" as const, id: base.decisionRequestId };
    let existing = this.draftFor(asset) as WorkbenchDecisionRequestDraftV1 | undefined;
    if (existing && existing.draftId !== options.draftId) {
      const path = workbenchRecordPath(existing);
      if (existing.publishing || this.publishing.has(path)) return undefined;
      this.createDecisionScratch(existing.edited, {
        parent: { kind: "saved-decision-request-revision", revisionId: existing.base.revisionId },
        select: false,
      });
      this.dropRecord(path);
      existing = undefined;
    }
    const path = existing ? workbenchRecordPath(existing) : undefined;
    const inFlight = path !== undefined && this.publishing.has(path);
    const baseSnapshot = existing && inFlight ? existing.base.snapshot : base;
    if (same(decisionRevisionContent(baseSnapshot as ProjectDecisionRequestRevision), content) && !inFlight) {
      if (path) this.dropRecord(path);
      this.selectDecision({ kind: "saved-decision-request-revision", revisionId: (existing?.base.revisionId ?? base.id) as typeof base.id });
      return undefined;
    }
    const record = parseWorkbenchRecord({
      schemaVersion: 1,
      kind: "draft",
      projectId: this.projectId,
      draftId: existing?.draftId ?? this.options.newDraftId?.() ?? `draft_${randomUUID()}`,
      asset,
      // A publication in flight keeps its base: the intent names it as parent.
      base: existing && inFlight ? existing.base : { revisionId: base.id, snapshot: structuredClone(base) },
      edited: structuredClone(content),
      ...(existing?.publishing ? { publishing: existing.publishing } : {}),
    }, this.projectId) as WorkbenchDecisionRequestDraftV1;
    const recordPath = workbenchRecordPath(record);
    this.records.set(recordPath, record);
    this.deletions.delete(recordPath);
    this.schedule(recordPath);
    this.selectDecision({ kind: "draft", draftId: record.draftId });
    return record;
  }

  /** A local decision request: a new one (Q2), or a draft kept aside (D6). Selected unless `select` is false. */
  createDecisionScratch(
    content: WorkbenchDecisionRequestContent,
    options: { parent?: DecisionScratchParent; select?: boolean },
  ): WorkbenchScratchV1 {
    const { parent } = options;
    const record = parseWorkbenchRecord({
      schemaVersion: 1,
      kind: "scratch",
      projectId: this.projectId,
      scratchId: this.options.newScratchId?.() ?? `scratch_${randomUUID()}`,
      createdAt: this.options.now?.() ?? new Date().toISOString(),
      // Decision traces carry no request pin (D12); the schema still asks for one.
      localConversationId: this.options.newLocalConversationId?.() ?? createEntityId("conversation", `local-${randomUUID()}`),
      request: { kind: "decision", content: structuredClone(content), ...(parent ? { parent } : {}) },
    }, this.projectId) as WorkbenchScratchV1;
    const path = workbenchRecordPath(record);
    this.records.set(path, record);
    this.schedule(path);
    if (options.select !== false) this.selectDecision({ kind: "scratch", scratchId: record.scratchId });
    return record;
  }

  updateDecisionScratch(scratchId: string, content: WorkbenchDecisionRequestContent): void {
    const existing = this.scratch(scratchId);
    if (!existing || existing.request.kind !== "decision") return;
    if (same(existing.request.content, content)) return;
    const record = parseWorkbenchRecord({
      ...existing,
      request: { ...existing.request, content: structuredClone(content) },
    }, this.projectId);
    const path = workbenchRecordPath(record);
    this.records.set(path, record);
    this.schedule(path);
  }

  /** Discards the request's draft and selects its base when the draft was selected. */
  async discardDecisionRequestDraft(decisionRequestId: DecisionRequestId): Promise<WorkbenchStoreOutcome | undefined> {
    const existing = this.draftFor({ kind: "decision-request", id: decisionRequestId }) as WorkbenchDecisionRequestDraftV1 | undefined;
    if (!existing) return undefined;
    const outcome = await this.discardDraft(existing.asset);
    if (outcome?.kind === "blocked" && outcome.reason === "reconciliation") return outcome;
    const selection = this.decisionSelection;
    if (selection?.kind === "draft" && selection.draftId === existing.draftId) {
      this.selectDecision({ kind: "saved-decision-request-revision", revisionId: existing.base.revisionId });
    }
    return outcome;
  }

  /** Saves the decision request's draft as a child revision (D11); see `publishRecord`. */
  async publishDecisionRequestDraft(decisionRequestId: DecisionRequestId, shared: ProjectFile, writeShared: WriteShared): Promise<PublishOutcome> {
    const blocked = this.publicationBlocked();
    if (blocked) return blocked;
    const existing = this.draftFor({ kind: "decision-request", id: decisionRequestId }) as WorkbenchDecisionRequestDraftV1 | undefined;
    if (!existing) return { kind: "failed", message: "There is no draft to save." };
    const pending = this.pendingPublication(existing);
    if (pending) return pending;
    const options = this.publicationOptions();
    let planned: ReturnType<typeof publishDecisionRequestDraft>;
    try {
      planned = publishDecisionRequestDraft(shared, existing, options);
    } catch (error) {
      return { kind: "failed", message: errorMessage(error, "Could not save the request.") };
    }
    const path = workbenchRecordPath(existing);
    if (planned.kind === "unchanged") {
      this.dropRecord(path);
      await this.persist(path);
      this.selectDecision({ kind: "saved-decision-request-revision", revisionId: existing.base.revisionId });
      return { kind: "published", revisionId: existing.base.revisionId, keptEdits: false, project: shared };
    }
    const outcome = await this.publishRecord(path, (project) => {
      const replanned = publishDecisionRequestDraft(project, existing, options);
      if (replanned.kind !== "publish") throw new ProjectValidationError([{ code: "custom", path: [], message: "The draft no longer differs from its base." }]);
      return replanned;
    }, shared, writeShared);
    if (outcome.kind === "published") this.selectAfterPublication(existing, outcome);
    return outcome;
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
        this.recoveryItems.push({ kind: "competing-draft", path, asset: record.asset, record, stored: true, message: "Another draft for this prompt is already active." });
        continue;
      }
      this.records.set(path, record);
    }
    for (const { path, record } of store.replaced) {
      this.recoveryFiles.add(path);
      this.recoveryItems.push({ kind: "replaced-draft", path, asset: record.asset, record, message: "A draft that \"Use this one\" replaced." });
    }
    // Read before carried records are written, so completion's activations are still exact.
    await this.loadMigrations();
    if (this.closed) return;
    const upgrade = this.options.upgrade;
    const activated = new Set(upgrade?.activated ?? []);
    for (const record of carried) {
      if (upgrade && record.kind === "selections") {
        const active = this.records.get(SELECTIONS_PATH);
        if (active && !(activated.has(SELECTIONS_PATH) && same(active, upgrade.stagedSelections))) {
          if (!same(active, record)) this.recoveryItems.push({
            kind: "record-conflict", path: SELECTIONS_PATH, record, memory: true,
            message: "Selections from this session were kept in memory because this folder already has personal selections.",
          });
          continue;
        }
      }
      if (record.kind === "draft" && upgrade && isPromptDraft(record)) {
        // The staged candidate preserves a draft the session never edited.
        const lifted = upgrade.lifted.find((draft) => assetKey(draft.asset) === assetKey(record.asset));
        if (lifted && same({ base: lifted.base.revisionId, edited: lifted.edited }, { base: record.base.revisionId, edited: record.edited })) continue;
        // An edited one is the newer version of the draft completion just activated.
        const active = this.draftFor(record.asset);
        const activePath = active && workbenchRecordPath(active);
        if (lifted && active && activePath && activated.has(activePath) && same(active, { ...lifted, draftId: active.draftId })) {
          this.records.set(activePath, parseWorkbenchRecord({ ...active, base: record.base, edited: record.edited }, this.projectId));
          this.dirty.add(activePath);
          continue;
        }
      }
      if (record.kind === "draft" && this.draftFor(record.asset)) {
        this.recoveryItems.push({
          kind: "competing-draft", path: workbenchRecordPath(record), asset: record.asset, record, memory: true,
          message: "A draft from this session was kept in memory because this folder already has a draft for the same item.",
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
    const blocked = this.publicationBlocked();
    if (blocked) return blocked;
    const existing = this.draftFor(asset);
    if (!existing || !isPromptDraft(existing)) {
      return { kind: "failed", message: "There is no draft to save." };
    }
    const path = workbenchRecordPath(existing);
    const pending = this.pendingPublication(existing);
    if (pending) return pending;
    const options = this.publicationOptions();
    let planned: ReturnType<typeof publishPromptDraft>;
    try {
      planned = publishPromptDraft(shared, existing, options);
    } catch (error) {
      return { kind: "failed", message: errorMessage(error, "Could not save the prompt.") };
    }
    if (planned.kind === "unchanged") {
      this.publishing.add(path);
      this.setSaving();
      try {
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
      } finally {
        this.publishing.delete(path);
        this.setSaving();
        this.changed();
      }
    }
    return this.publishRecord(path, (project) => {
      const replanned = publishPromptDraft(project, existing, options);
      if (replanned.kind !== "publish") {
        throw new ProjectValidationError([{ code: "custom", path: [], message: "The draft no longer differs from its base." }]);
      }
      return { ...replanned, project: extend(replanned.project) };
    }, shared, writeShared);
  }

  // ---- Recovery (step 6b) -------------------------------------------------

  /**
   * Reads the migration inventory and records every candidate whose exact
   * bytes are active as `used`, so a later edit or save of that draft never
   * brings the candidate back ("Candidates are assessed without the manifest").
   */
  private async loadMigrations(): Promise<void> {
    const reader = this.options.migrations;
    if (!reader || !this.store) return;
    let inventory: Awaited<ReturnType<typeof assessMigrationRecovery>>;
    try {
      inventory = await assessMigrationRecovery(await reader.read(), this.projectId);
    } catch (error) {
      this.recoveryItems.push({ kind: "unreadable", path: "migrations", message: errorMessage(error, "Could not read the migration backups.") });
      return;
    }
    for (const entry of inventory.unreadable) this.recoveryItems.push({ kind: "unreadable", path: entry.path, message: entry.message });
    for (const operation of inventory.operations) {
      this.migrationOperations.set(operation.operationId, operation);
      for (const path of operation.files) if (isMigrationRecoveryPath(path)) this.recoveryFiles.add(path);
      if (operation.present.length && !operation.removing) await this.recordPresent(operation.operationId);
    }
    this.syncMigrationItems();
  }

  private async recordPresent(operationId: string): Promise<boolean> {
    const operation = this.migrationOperations.get(operationId);
    if (!operation) return true;
    const settledAt = this.options.now?.() ?? new Date().toISOString();
    const written = await this.writeResolutions(operationId, (current) => {
      const settled = new Set(current?.resolutions.map(({ candidate }) => candidate));
      let resolutions = current;
      for (const candidate of operation.present) {
        if (!settled.has(candidate)) {
          resolutions = settleMigrationCandidate(resolutions, { projectId: this.projectId, operationId, candidate, outcome: "used", settledAt });
        }
      }
      return resolutions;
    });
    if (written !== true) {
      const path = migrationResolutionsPath(operationId);
      this.recoveryItems = [
        ...this.recoveryItems.filter((item) => !(item.kind === "write-failed" && item.path === path)),
        { kind: "write-failed", path, message: `Could not record the drafts this upgrade restored: ${written.message}` },
      ];
      return false;
    }
    operation.present = [];
    return true;
  }

  /** Writes the operation's next resolutions record and adopts it once confirmed. */
  private writeResolutions(
    operationId: string,
    next: (current: MigrationResolutionsV1 | undefined) => MigrationResolutionsV1 | undefined,
  ): Promise<true | Exclude<ReconcileOutcome, { kind: "settled" }>> {
    // Queue the read and derivation as well as the write. Otherwise two
    // decisions in this window can each build on the same older record.
    const write = this.resolutionWrites.then(() => this.updateResolutions(operationId, next));
    this.resolutionWrites = write.then(() => {}, () => {});
    return write;
  }

  private async updateResolutions(
    operationId: string,
    next: (current: MigrationResolutionsV1 | undefined) => MigrationResolutionsV1 | undefined,
  ): Promise<true | Exclude<ReconcileOutcome, { kind: "settled" }>> {
    const store = this.store;
    const operation = this.migrationOperations.get(operationId);
    if (!store || !operation) return refused("blocked", "The personal workbench is not ready.");
    const path = migrationResolutionsPath(operationId);
    const refreshed = await store.refresh(path);
    if (refreshed.kind !== "refreshed") return refused("failed", refreshed.message);
    let record: MigrationResolutionsV1 | undefined;
    try {
      const current = refreshed.contents === null ? undefined : readMigrationResolutions(refreshed.contents, this.projectId, operationId);
      if (!current && operation.resolutions) return refused("blocked", "The resolutions file was removed. Reopen the folder to review the backup.");
      record = next(current);
      if (current?.backupRemovedAt && !same(current, record)) return refused("blocked", "Migration backup removal has started.");
    } catch (error) {
      return refused("failed", errorMessage(error, "Could not settle the candidate."));
    }
    if (!record) return true;
    const contents = serializeMigrationResolutions(record);
    if (contents !== refreshed.contents) {
      const outcome = await store.writeRecovery(path, contents);
      if (outcome.kind !== "saved") return refused(outcome.kind === "blocked" ? "blocked" : "failed", storeMessage(outcome));
    }
    operation.resolutions = record;
    this.recoveryFiles.add(path);
    if (!operation.files.includes(path)) operation.files = [...operation.files, path].sort();
    return true;
  }

  private syncMigrationItems(): void {
    this.recoveryItems = this.recoveryItems.filter((item) => item.kind !== "migration-candidate");
    for (const operation of this.migrationOperations.values()) {
      for (const candidate of operation.pending) {
        this.recoveryItems.push({
          kind: "migration-candidate",
          path: candidate.path,
          message: candidate.reason,
          operationId: operation.operationId,
          candidate: candidate.candidate,
          state: candidate.state,
          record: candidate.record,
          ...(candidate.record.kind === "draft" ? { asset: candidate.record.asset } : {}),
          ...(candidate.competitor ? { competitor: candidate.competitor } : {}),
        });
      }
    }
    this.changed();
  }

  private recoveryItem(id: string): RecoveryItem | undefined {
    return this.recoveryItems.find((item) => recoveryId(item) === id);
  }

  private settleItem(item: RecoveryItem): ReconcileOutcome {
    this.recoveryItems = this.recoveryItems.filter((entry) => entry !== item);
    this.changed();
    return SETTLED;
  }

  private reconcileStore(): Store | ReconcileOutcome {
    if (this.statusValue.kind !== "ready" || !this.store) return refused("blocked", "The personal workbench is not ready to reconcile.");
    return this.store;
  }

  /** Both sides of an item, for Compare. Undefined when it has nothing to compare. */
  async compareRecovery(id: string, shared: ProjectFile): Promise<RecoveryComparison | undefined> {
    const item = this.recoveryItem(id);
    if (!item || !recoveryActions(item).includes("compare")) return undefined;
    const active = (asset?: WorkbenchAssetRef) => {
      const record = asset && this.draftFor(asset);
      return record ? { label: "Active draft", record: structuredClone(record) } : undefined;
    };
    switch (item.kind) {
      case "migration-candidate": {
        const competitor = item.competitor ? this.records.get(item.competitor) : undefined;
        return {
          incoming: { label: "From the migration backup", record: structuredClone(item.record) },
          ...(competitor ? { current: { label: competitor.kind === "selections" ? "Current selections" : "Active draft", record: structuredClone(competitor) } } : {}),
        };
      }
      case "competing-draft":
      case "replaced-draft": {
        const current = active(item.asset);
        const label = item.kind === "replaced-draft" ? "Replaced draft" : item.stored ? "Other draft" : "From this session";
        return { incoming: { label, record: structuredClone(item.record) }, ...(current ? { current } : {}) };
      }
      case "orphaned-draft": {
        const record = this.records.get(item.path);
        if (record?.kind !== "draft") return undefined;
        return { incoming: { label: "Draft", record: structuredClone(record.edited) }, current: { label: "Base revision", record: structuredClone(record.base.snapshot) } };
      }
      case "publication-conflict": {
        const record = this.records.get(item.path);
        if (!record || record.kind === "selections" || !record.publishing) return undefined;
        const saved = savedRevision(shared, record.publishing.revisionId as string);
        return {
          incoming: { label: "This draft", record: structuredClone(record.publishing.content) },
          ...(saved ? { current: { label: "Saved revision", record: structuredClone(saved) } } : {}),
        };
      }
      case "record-conflict": {
        const mine = item.memory ? item.record : this.records.get(item.path);
        if (item.memory) {
          const current = this.records.get(item.path);
          return { incoming: { label: "From this session", record: structuredClone(mine) }, ...(current ? { current: { label: "In this folder", record: structuredClone(current) } } : {}) };
        }
        let onDisk: unknown;
        try {
          const file = (await this.storage?.list())?.find((entry) => entry.path === item.path);
          onDisk = file && "contents" in file ? parseWorkbenchRecordJson(file.contents, this.projectId) : undefined;
        } catch {
          onDisk = undefined;
        }
        // A deletion that met an edit on disk leaves nothing in memory: say so.
        const label = mine ? "This window" : "This window: deleted";
        return { incoming: { label, record: structuredClone(mine) }, ...(onDisk ? { current: { label: "On disk", record: onDisk } } : {}) };
      }
      default:
        return undefined;
    }
  }

  /** "Use this one" (D6, W1): the item's copy becomes active; whatever it replaces is kept. */
  async useRecovery(id: string): Promise<ReconcileOutcome> {
    const item = this.recoveryItem(id);
    if (!item || !recoveryActions(item).includes("use")) return refused("failed", "This item cannot be used.");
    const store = this.reconcileStore();
    if (!("save" in store)) return store;
    switch (item.kind) {
      case "migration-candidate": {
        const operationId = item.operationId!;
        if (item.record?.kind === "selections") {
          await this.flush();
          if (this.records.has(SELECTIONS_PATH)) return refused("failed", "Personal selections exist now. Compare them, then discard this candidate.");
          const saved = await store.save(item.record);
          if (saved.kind !== "saved") return refused("failed", storeMessage(saved));
          this.records.set(SELECTIONS_PATH, item.record);
          return this.settleCandidate(item, "used");
        }
        const activated = await this.activateReplacing(item.record as WorkbenchDraftV1, (draftId) => migrationReplacedCopyPath(operationId, draftId));
        if (activated.kind !== "activated") return activated;
        return this.settleCandidate(item, "used", activated.replacedCopy);
      }
      case "competing-draft": {
        const activated = await this.activateReplacing(item.record as WorkbenchDraftV1, replacedDraftPath, item.stored ? { path: item.path, consume: false } : undefined);
        return activated.kind === "activated" ? this.settleItem(item) : activated;
      }
      case "replaced-draft": {
        const activated = await this.activateReplacing(item.record as WorkbenchDraftV1, replacedDraftPath, { path: item.path, consume: true });
        return activated.kind === "activated" ? this.settleItem(item) : activated;
      }
      case "record-conflict":
        return this.keepThisWindowsCopy(item, store);
      default:
        return refused("failed", "This item cannot be used.");
    }
  }

  async discardRecovery(id: string): Promise<ReconcileOutcome> {
    const item = this.recoveryItem(id);
    if (!item || !recoveryActions(item).includes("discard")) return refused("failed", "This item cannot be discarded.");
    if (item.memory) return this.settleItem(item);
    switch (item.kind) {
      case "migration-candidate":
        return this.settleCandidate(item, "discarded");
      case "competing-draft":
      case "replaced-draft": {
        const store = this.reconcileStore();
        if (!("save" in store)) return store;
        const outcome = item.kind === "replaced-draft" ? await store.writeRecovery(item.path, null) : await store.delete(item.path);
        if (outcome.kind !== "deleted") return refused("failed", storeMessage(outcome));
        this.recoveryFiles.delete(item.path);
        return this.settleItem(item);
      }
      case "orphaned-draft":
      case "publication-conflict": {
        const record = this.records.get(item.path);
        if (!record || record.kind === "selections") return this.settleItem(item);
        const outcome = record.kind === "scratch"
          ? await this.discardScratch(record.scratchId)
          : record.asset.kind === "chat-request"
            ? await this.discardChatRequestDraft(record.asset.id)
            : record.asset.kind === "decision-request"
              ? await this.discardDecisionRequestDraft(record.asset.id)
              : await this.discardDraft(record.asset);
        if (outcome && outcome.kind !== "deleted" && outcome.kind !== "saved") return refused("failed", storeMessage(outcome));
        return this.settleItem(item);
      }
      case "record-conflict":
        return this.takeTheCopyOnDisk(item);
      default:
        return refused("failed", "This item cannot be discarded.");
    }
  }

  /** A publication conflict's edits stay as a draft over their original base. */
  async keepRecoveryAsDraft(id: string): Promise<ReconcileOutcome> {
    const item = this.recoveryItem(id);
    if (!item || !recoveryActions(item).includes("keep-as-draft")) return refused("failed", "This item cannot be kept as a draft.");
    const record = this.records.get(item.path);
    if (!record || record.kind === "selections") return refused("failed", "The draft is no longer here.");
    this.cancelTimer(item.path);
    this.records.set(item.path, clearPublication(record));
    this.dirty.add(item.path);
    const outcome = await this.persist(item.path);
    if (outcome && outcome.kind !== "saved") return refused("failed", storeMessage(outcome));
    return this.settleItem(item);
  }

  /** An orphaned draft saved as a new prompt or request named `name`; never rebased (V4). */
  async saveRecoveryAsNew(id: string, name: string, shared: ProjectFile, writeShared: WriteShared): Promise<ReconcileOutcome> {
    const item = this.recoveryItem(id);
    if (!item || !recoveryActions(item).includes("save-as-new")) return refused("failed", "This item cannot be saved as new.");
    const record = this.records.get(item.path);
    if (record?.kind !== "draft") return refused("failed", "The draft is no longer here.");
    const trimmed = name.trim();
    if (!trimmed) return refused("failed", "Name the new item.");
    if (isPromptDraft(record)) {
      const idSuffix = randomUUID();
      const createdAt = this.options.now?.() ?? new Date().toISOString();
      const edited = record.edited;
      const update = (project: ProjectFile) => "messages" in edited
        ? createPromptTemplate(project, { name: trimmed, messages: edited.messages, variableDefaults: edited.variableDefaults, idSuffix, revisionIdSuffix: idSuffix, createdAt })
        : createDecisionPromptTemplate(project, { name: trimmed, decision: edited.decision, variableDefaults: edited.variableDefaults, idSuffix, revisionIdSuffix: idSuffix, createdAt });
      try {
        update(shared);
      } catch (error) {
        return refused("failed", errorMessage(error, "Could not save the draft as a new prompt."));
      }
      const outcome = await writeShared(update);
      if (outcome.kind !== "confirmed") return refused(outcome.kind === "blocked" ? "blocked" : "failed", outcome.message);
      this.cancelTimer(item.path);
      this.dropRecord(item.path);
      await this.persist(item.path);
      return this.settleItem(item);
    }
    // A request draft becomes a parentless local request, then publishes as a new one.
    const chat = record.asset.kind === "chat-request";
    const selection = chat ? this.chatSelection : this.decisionSelection;
    const select = selection?.kind === "draft" && selection.draftId === record.draftId;
    const scratch = chat
      ? this.createChatScratch((record as WorkbenchChatRequestDraftV1).edited.items, { select })
      : this.createDecisionScratch((record as WorkbenchDecisionRequestDraftV1).edited, { select });
    this.cancelTimer(item.path);
    this.dropRecord(item.path);
    this.settleItem(item);
    const published = await this.publishScratch(scratch.scratchId, shared, writeShared, trimmed);
    if (published.kind !== "published") return refused("failed", `Kept as a local request: ${published.message}`);
    return SETTLED;
  }

  async retryRecovery(id: string, shared: ProjectFile): Promise<ReconcileOutcome> {
    const item = this.recoveryItem(id);
    if (!item || !recoveryActions(item).includes("retry")) return refused("failed", "This item cannot be retried.");
    const store = this.reconcileStore();
    if (!("save" in store)) return store;
    if (item.kind === "publication-conflict") {
      this.recoveryItems = this.recoveryItems.filter((entry) => entry !== item);
      await this.settlePublications(shared, item.path);
      await this.flush();
      this.changed();
      return this.recoveryItems.some((entry) => entry.path === item.path) ? refused("failed", "The save is still not settled.") : SETTLED;
    }
    const operationId = /^migrations\/(migration_[a-f0-9]{64})\/resolutions\.json$/.exec(item.path)?.[1];
    if (operationId) {
      if (!await this.recordPresent(operationId)) return refused("failed", "Could not record the restored drafts.");
      return this.settleItem(item);
    }
    // An earlier failure may have changed the file: read it before writing again.
    const attempted = this.records.get(item.path);
    const refreshed = await store.refresh(item.path, attempted ? serializeWorkbenchRecord(attempted) : null);
    if (refreshed.kind === "conflict") {
      this.recoveryItems = this.recoveryItems.map((entry) => entry === item
        ? { ...entry, kind: "record-conflict", message: refreshed.message }
        : entry);
      this.changed();
      return refused("blocked", refreshed.message);
    }
    if (refreshed.kind !== "refreshed") return refused("failed", refreshed.message);
    const record = this.records.get(item.path);
    if (!record && refreshed.contents === null) return this.settleItem(item);
    if (record && refreshed.contents === serializeWorkbenchRecord(record)) {
      this.dirty.delete(item.path);
      return this.settleItem(item);
    }
    if (record) this.dirty.add(item.path);
    else this.deletions.add(item.path);
    this.cancelTimer(item.path);
    const outcome = await this.persist(item.path);
    if (outcome && outcome.kind !== "saved" && outcome.kind !== "deleted") return refused("failed", storeMessage(outcome));
    return this.settleItem(item);
  }

  /**
   * W3: records the removal's intent, then the host deletes the operation's
   * directory with `resolutions.json` last.
   */
  async removeMigrationBackup(operationId: string): Promise<ReconcileOutcome> {
    const store = this.reconcileStore();
    if (!("save" in store)) return store;
    const operation = this.migrationOperations.get(operationId);
    if (!operation) return refused("failed", "There is no such migration backup.");
    if (!removableMigrationOperation(operation)) return refused("blocked", "Settle every item from this upgrade before removing its backup.");
    if (!operation.removing) {
      const at = this.options.now?.() ?? new Date().toISOString();
      const written = await this.writeResolutions(operationId, (current) => markMigrationBackupRemoval(current, { projectId: this.projectId, operationId, at }));
      if (written !== true) return written;
      operation.removing = true;
    }
    const removed = await store.removeMigrationOperation(operationId);
    if (removed.kind !== "removed") return refused(removed.kind === "blocked" ? "blocked" : "failed", removed.message);
    this.migrationOperations.delete(operationId);
    for (const path of [...this.recoveryFiles]) if (path.startsWith(`migrations/${operationId}/`)) this.recoveryFiles.delete(path);
    this.recoveryItems = this.recoveryItems.filter((item) => item.operationId !== operationId && !item.path.startsWith(`migrations/${operationId}/`));
    this.changed();
    return SETTLED;
  }

  private async settleCandidate(item: RecoveryItem, outcome: "used" | "discarded", replacedCopy?: string): Promise<ReconcileOutcome> {
    const operationId = item.operationId!;
    const settledAt = this.options.now?.() ?? new Date().toISOString();
    const written = await this.writeResolutions(operationId, (current) => settleMigrationCandidate(current, {
      projectId: this.projectId, operationId, candidate: item.candidate!, outcome, settledAt, ...(replacedCopy ? { replacedCopy } : {}),
    }));
    if (written !== true) return written;
    const operation = this.migrationOperations.get(operationId);
    if (operation) operation.pending = operation.pending.filter(({ candidate }) => candidate !== item.candidate);
    return this.settleItem(item);
  }

  /**
   * Makes `incoming` the asset's one active draft (D6). The draft it replaces
   * is kept at `target(draftId)`. Writes go in a crash-safe order: the replaced
   * copy, then the incoming draft, then the old draft's deletion. A swap whose
   * copy overwrites the incoming record's own file writes the incoming draft
   * first. An interruption leaves at worst two drafts for one asset.
   */
  private async activateReplacing(
    incoming: WorkbenchDraftV1,
    target: (draftId: string) => string,
    source?: { path: string; consume: boolean },
  ): Promise<{ kind: "activated"; replacedCopy?: string } | Exclude<ReconcileOutcome, { kind: "settled" }>> {
    const store = this.store;
    if (!store) return refused("blocked", "The personal workbench is not ready to reconcile.");
    await this.flush();
    const active = this.draftFor(incoming.asset);
    const activePath = active ? workbenchRecordPath(active) : undefined;
    if (activePath && (active!.publishing || this.publishing.has(activePath))) {
      return refused("blocked", "The active draft is being saved, or an earlier save needs review first.");
    }
    let record = clearPublication(incoming) as WorkbenchDraftV1;
    const destination = workbenchRecordPath(record);
    const occupied = (path: string) => this.records.has(path) || store.hasRecord(path);
    const needsNewId = source?.path !== destination && occupied(destination);
    if (needsNewId) {
      record = parseWorkbenchRecord({ ...record, draftId: this.options.newDraftId?.() ?? `draft_${randomUUID()}` }, this.projectId) as WorkbenchDraftV1;
    }
    const path = workbenchRecordPath(record);
    if (needsNewId && occupied(path)) return refused("failed", "The new draft ID is already in use.");
    const copy = active ? target(active.draftId) : undefined;
    if (copy && copy !== source?.path && this.recoveryFiles.has(copy)) {
      return refused("failed", `A replaced copy of the active draft is already kept at ${copy}. Discard it first.`);
    }
    const writeIncoming = async () => {
      if (source?.path === path) return undefined;
      const outcome = await store.save(record);
      return outcome.kind === "saved" ? undefined : refused("failed", storeMessage(outcome));
    };
    const writeCopy = async () => {
      if (!copy || !active) return undefined;
      const outcome = await store.writeRecovery(copy, serializeWorkbenchRecord(active));
      if (outcome.kind !== "saved") return refused("failed", storeMessage(outcome));
      this.recoveryFiles.add(copy);
      if (isMigrationRecoveryPath(copy)) {
        const operation = this.migrationOperations.get(copy.split("/")[1]);
        if (operation && !operation.files.includes(copy)) operation.files = [...operation.files, copy].sort();
      }
      return undefined;
    };
    const steps = copy && copy === source?.path ? [writeIncoming, writeCopy] : [writeCopy, writeIncoming];
    for (const step of steps) {
      const failure = await step();
      if (failure) return failure;
    }
    this.records.set(path, record);
    this.dirty.delete(path);
    this.deletions.delete(path);
    if (activePath && active) {
      this.records.delete(activePath);
      const deleted = await store.delete(activePath);
      if (deleted.kind !== "deleted" && !(deleted.kind === "blocked" && deleted.reason === "not-loaded")) {
        return refused("failed", `The draft is active, but the one it replaced is still in drafts/: ${storeMessage(deleted)}`);
      }
      this.moveDraftSelection(active.draftId, record.draftId);
    }
    if (source?.consume && source.path !== copy) {
      const consumed = await store.writeRecovery(source.path, null);
      if (consumed.kind === "deleted") this.recoveryFiles.delete(source.path);
    }
    if (copy && active && copy.startsWith("replaced/")) {
      this.recoveryItems = this.recoveryItems.filter((item) => item.path !== copy);
      this.recoveryItems.push({ kind: "replaced-draft", path: copy, asset: active.asset, record: active, message: "A draft that \"Use this one\" replaced." });
    }
    this.changed();
    return { kind: "activated", ...(copy ? { replacedCopy: copy } : {}) };
  }

  /** A selection of the replaced request draft follows the draft that replaced it. */
  private moveDraftSelection(from: string, to: string): void {
    if (from === to) return;
    if (same(this.chatSelection, { kind: "draft", draftId: from })) this.selectChat({ kind: "draft", draftId: to as WorkbenchDraftV1["draftId"] });
    if (same(this.decisionSelection, { kind: "draft", draftId: from })) this.selectDecision({ kind: "draft", draftId: to as WorkbenchDraftV1["draftId"] });
  }

  /** A store conflict: keep this window's copy; the copy on disk is kept aside first. */
  private async keepThisWindowsCopy(item: RecoveryItem, store: Store): Promise<ReconcileOutcome> {
    const record = this.records.get(item.path);
    if (!record) return refused("failed", "This window no longer holds the record.");
    const refreshed = await store.refresh(item.path);
    if (refreshed.kind !== "refreshed") return refused("failed", refreshed.message);
    if (refreshed.contents !== null) {
      let onDisk: WorkbenchRecordV1 | undefined;
      try { onDisk = parseWorkbenchRecordJson(refreshed.contents, this.projectId); } catch { onDisk = undefined; }
      if (onDisk?.kind === "draft") {
        const copy = replacedDraftPath(onDisk.draftId);
        if (this.recoveryFiles.has(copy)) return refused("failed", `A replaced copy is already kept at ${copy}. Discard it first.`);
        const kept = await store.writeRecovery(copy, refreshed.contents);
        if (kept.kind !== "saved") return refused("failed", storeMessage(kept));
        this.recoveryFiles.add(copy);
        this.recoveryItems.push({ kind: "replaced-draft", path: copy, asset: onDisk.asset, record: onDisk, message: "The copy on disk that this window's draft replaced." });
      } else if (onDisk?.kind === "scratch") {
        const aside = parseWorkbenchRecord({ ...onDisk, scratchId: this.options.newScratchId?.() ?? `scratch_${randomUUID()}`, publishing: undefined }, this.projectId);
        const kept = await store.save(aside);
        if (kept.kind !== "saved") return refused("failed", storeMessage(kept));
        this.records.set(workbenchRecordPath(aside), aside);
      }
    }
    this.cancelTimer(item.path);
    this.dirty.add(item.path);
    const outcome = await this.persist(item.path);
    if (outcome && outcome.kind !== "saved") return refused("failed", storeMessage(outcome));
    return this.settleItem(item);
  }

  /** A store conflict: this window's copy gives way to the one on disk. */
  private async takeTheCopyOnDisk(item: RecoveryItem): Promise<ReconcileOutcome> {
    const store = this.reconcileStore();
    if (!("save" in store)) return store;
    const refreshed = await store.refresh(item.path);
    if (refreshed.kind !== "refreshed") return refused("failed", refreshed.message);
    this.cancelTimer(item.path);
    this.dirty.delete(item.path);
    if (refreshed.contents === null) {
      this.records.delete(item.path);
    } else {
      try {
        this.records.set(item.path, parseWorkbenchRecordJson(refreshed.contents, this.projectId));
      } catch (error) {
        this.records.delete(item.path);
        this.recoveryItems.push({ kind: "unreadable", path: item.path, message: errorMessage(error, "The copy on disk cannot be read.") });
      }
    }
    return this.settleItem(item);
  }

  /** A Save already running, or an earlier one that needs review. */
  private pendingPublication(record: WorkbenchDraftV1 | WorkbenchScratchV1): PublishOutcome | undefined {
    if (this.publishing.has(workbenchRecordPath(record))) return { kind: "blocked", message: "This draft is already being saved." };
    if (record.publishing) {
      return { kind: "conflict", message: "An earlier save of this draft needs review before it can be saved again." };
    }
    return undefined;
  }

  private publicationBlocked(): PublishOutcome | undefined {
    if (this.statusValue.kind === "blocked" || this.statusValue.kind === "loading" || this.statusValue.kind === "off") {
      return { kind: "blocked", message: "The personal workbench is not ready to save." };
    }
    return undefined;
  }

  /** Fixed once per Save, so the workspace can re-apply the plan deterministically. */
  private publicationOptions(): { idSuffix: string; createdAt: string } {
    return { idSuffix: randomUUID(), createdAt: this.options.now?.() ?? new Date().toISOString() };
  }

  /**
   * The four-step protocol for any draft or scratch. `plan` must be
   * deterministic: it runs against `shared` for the intent and again inside
   * the workspace's queued write against the latest document.
   *  1. Write the intent into the record and read it back.
   *  2. The shared write.
   *  3. Reparent a scratch's local children and read each back, then clear the
   *     record, or keep later edits based on the published revision.
   * A failure before the shared write drops the intent; a failure in step 3
   * keeps it, and the next open settles it.
   */
  private async publishRecord(
    path: string,
    plan: (project: ProjectFile) => { project: ProjectFile; intent: unknown },
    shared: ProjectFile,
    writeShared: WriteShared,
  ): Promise<PublishOutcome> {
    const existing = this.records.get(path);
    if (!existing || existing.kind === "selections") return { kind: "failed", message: "There is nothing to save." };
    if (this.publishing.has(path)) return { kind: "blocked", message: "This draft is already being saved." };
    if (existing.publishing) {
      return { kind: "conflict", message: "An earlier save of this draft needs review before it can be saved again." };
    }
    this.publishing.add(path);
    this.setSaving();
    try {
      let planned: { project: ProjectFile; intent: unknown };
      try {
        planned = plan(shared);
      } catch (error) {
        return { kind: "failed", message: errorMessage(error, "Could not save.") };
      }
      const revisionId = (planned.intent as { revisionId: string }).revisionId;
      // Step 1: the intent, written and read back before the shared write.
      const latest = this.records.get(path) ?? existing;
      const withIntent = parseWorkbenchRecord({ ...latest, publishing: planned.intent }, this.projectId) as WorkbenchDraftV1 | WorkbenchScratchV1;
      this.records.set(path, withIntent);
      this.dirty.add(path);
      const recorded = await this.persist(path);
      if (recorded && recorded.kind !== "saved") {
        this.restoreWithoutIntent(path);
        return { kind: recorded.kind === "conflict" ? "conflict" : recorded.kind === "blocked" ? "blocked" : "failed", message: storeMessage(recorded) };
      }
      // Step 2: the shared write, re-applied deterministically by the workspace.
      const outcome = await writeShared((current) => plan(current).project);
      if (outcome.kind !== "confirmed") {
        this.restoreWithoutIntent(path);
        await this.persist(path);
        return outcome;
      }
      // Step 3: children first, then clear or keep later edits.
      const current = (this.records.get(path) ?? withIntent) as WorkbenchDraftV1 | WorkbenchScratchV1;
      const completion = completePublication(outcome.project, current, this.scratches);
      const cleaned = await this.applyScratchRewrites(completion.scratchRewrites);
      if (!cleaned) {
        this.recoveryItems.push({ kind: "publication-conflict", path, settle: "children", message: "The request was saved, but a local request that branched from it could not be updated. Retry, or it is settled the next time the project opens." });
        return { kind: "published", revisionId, keptEdits: true, project: outcome.project };
      }
      if (!completion.record && !await this.persistPublishedSelection(current, revisionId)) {
        return { kind: "published", revisionId, keptEdits: true, project: outcome.project };
      }
      if (completion.record) {
        this.records.set(path, completion.record);
        this.dirty.add(path);
      } else {
        this.dropRecord(path);
      }
      await this.persist(path);
      return { kind: "published", revisionId, keptEdits: Boolean(completion.record), project: outcome.project };
    } finally {
      this.publishing.delete(path);
      this.setSaving();
      this.changed();
    }
  }

  /** Persists each child's new parent, checking it is still the planned `before`. */
  private async applyScratchRewrites(rewrites: Array<{ before: WorkbenchScratchV1; after: WorkbenchScratchV1 }>): Promise<boolean> {
    for (const { before, after } of rewrites) {
      const path = workbenchRecordPath(after);
      const current = this.records.get(path);
      if (!current || current.kind !== "scratch") return false;
      // Keep edits made since planning; only the parent moves.
      const next = same(current, before) ? after : parseWorkbenchRecord({ ...current, request: { ...current.request, parent: after.request.parent } }, this.projectId);
      this.cancelTimer(path);
      this.records.set(path, next);
      this.dirty.add(path);
      const outcome = await this.persist(path);
      if (outcome && outcome.kind !== "saved") return false;
    }
    return true;
  }

  /** A published record that was selected selects its revision, unless it kept later edits. */
  private selectAfterPublication(record: WorkbenchDraftV1 | WorkbenchScratchV1, outcome: Extract<PublishOutcome, { kind: "published" }>): void {
    if (outcome.keptEdits) return;
    this.moveSelectionToPublished(record, outcome.revisionId);
  }

  /**
   * Which selection a request record answers to, and the selection of its
   * published revision. Undefined for a prompt draft, which no selection names.
   */
  private moveSelectionToPublished(record: WorkbenchDraftV1 | WorkbenchScratchV1, revisionId: string): boolean {
    const local = record.kind === "scratch"
      ? { kind: "scratch" as const, scratchId: record.scratchId }
      : { kind: "draft" as const, draftId: record.draftId };
    const decision = record.kind === "scratch" ? record.request.kind === "decision" : record.asset.kind === "decision-request";
    const chat = record.kind === "scratch" ? record.request.kind === "chat" : record.asset.kind === "chat-request";
    if (chat) {
      if (same(this.chatSelection, local)) {
        this.selectChat({ kind: "saved-conversation-revision", revisionId: revisionId as ProjectConversationRevision["id"] });
      }
      return true;
    }
    if (decision) {
      if (same(this.decisionSelection, local)) {
        this.selectDecision({ kind: "saved-decision-request-revision", revisionId: revisionId as ProjectDecisionRequestRevision["id"] });
      }
      return true;
    }
    return false;
  }

  /** Persist the selection before deleting its published record, so reopening
   * cannot fall back to the launch default between cleanup and selection save.
   * On failure the caller retains the intent for recovery on the next open.
   */
  private async persistPublishedSelection(record: WorkbenchDraftV1 | WorkbenchScratchV1, revisionId: string): Promise<boolean> {
    if (!this.moveSelectionToPublished(record, revisionId)) return true;
    // Also flush a newer selection: disk may still select this record.
    this.cancelTimer(SELECTIONS_PATH);
    const outcome = await this.persist(SELECTIONS_PATH);
    return !outcome || outcome.kind === "saved";
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

  /** Removes a record now; its file is deleted after the debounce, like any write (D14). */
  private dropRecord(path: string): void {
    this.cancelTimer(path);
    this.records.delete(path);
    this.dirty.delete(path);
    this.deletions.add(path);
    this.changed();
    this.scheduleWrite(path);
  }

  private async settlePublications(shared: ProjectFile, only?: string): Promise<void> {
    for (const [path, record] of [...this.records]) {
      if (record.kind === "selections" || !record.publishing) continue;
      if (only !== undefined && path !== only) continue;
      const asset = record.kind === "draft" ? { asset: record.asset } : {};
      let state: ReturnType<typeof reconcilePublication>;
      try {
        state = reconcilePublication(shared, record);
      } catch (error) {
        this.recoveryItems.push({ kind: "publication-conflict", path, ...asset, message: errorMessage(error, "Could not check an earlier save.") });
        continue;
      }
      if (state === "conflict") {
        this.recoveryItems.push({
          kind: "publication-conflict", path, ...asset,
          message: "An earlier save of this draft found different content under the same revision. Compare before saving again.",
        });
        continue;
      }
      if (state === "published" && record.kind === "scratch") {
        // Children are reparented and read back before the scratch is cleared.
        const completion = completePublication(shared, record, this.scratches);
        if (!await this.applyScratchRewrites(completion.scratchRewrites)) {
          this.recoveryItems.push({ kind: "publication-conflict", path, settle: "children", message: "A local request that branched from a saved one could not be updated." });
          continue;
        }
        if (completion.record) {
          this.records.set(path, completion.record);
          this.dirty.add(path);
        } else {
          if (!await this.persistPublishedSelection(record, record.publishing.revisionId as string)) continue;
          this.records.delete(path);
          this.deletions.add(path);
        }
        continue;
      }
      if (state === "not-published") {
        this.records.set(path, clearPublication(record));
      } else {
        const { record: next } = completePublication(shared, record, []);
        if (next) {
          this.records.set(path, next);
        } else {
          if (!await this.persistPublishedSelection(record, record.publishing.revisionId as string)) continue;
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
      if (record.kind === "draft" && record.asset.kind === "chat-request") {
        const request = record as WorkbenchChatRequestDraftV1;
        const base = shared.conversationRevisions.find(({ id }) => id === request.base.revisionId);
        if (!base || base.conversationId !== request.asset.id) {
          this.recoveryItems.push({ kind: "orphaned-draft", path, asset: record.asset, message: "This request draft's base revision no longer exists." });
        }
        continue;
      }
      if (record.kind === "draft" && record.asset.kind === "decision-request") {
        const request = record as WorkbenchDecisionRequestDraftV1;
        const base = shared.decisionRequestRevisions.find(({ id }) => id === request.base.revisionId);
        if (!base || base.decisionRequestId !== request.asset.id) {
          this.recoveryItems.push({ kind: "orphaned-draft", path, asset: record.asset, message: "This decision request draft's base revision no longer exists." });
        }
        continue;
      }
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
    this.scheduleWrite(path);
  }

  /** Persists the path's current state, a record or its deletion, after the debounce. */
  private scheduleWrite(path: string): void {
    if (!this.store || this.closed) return;
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
      const conflict = this.recoveryItems.find((item) => item.kind === "record-conflict" && !item.memory && item.path === path);
      if (conflict && outcome.kind === "blocked" && outcome.reason === "reconciliation") return outcome;
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

/** The saved revision with this ID, in any prompt or request. */
function savedRevision(project: ProjectFile, revisionId: string): unknown {
  for (const template of project.promptTemplates) {
    const revision = (template.revisions as Array<{ id: string }>).find(({ id }) => id === revisionId);
    if (revision) return revision;
  }
  return project.conversationRevisions.find(({ id }) => id === revisionId)
    ?? project.decisionRequestRevisions.find(({ id }) => id === revisionId);
}
