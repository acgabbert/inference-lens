"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type {
  ProjectConversationItem,
  ProjectConversationRevision,
  ProjectDecisionRequestRevision,
} from "../../packages/core/src/project.ts";
import type {
  LocalChatInput,
  LocalDecisionInput,
  WorkbenchChatRequestDraftV1,
  WorkbenchDecisionRequestContent,
  WorkbenchDecisionRequestDraftV1,
  WorkbenchDraftV1,
  WorkbenchRecordV1,
  WorkbenchScratchV1,
} from "../../packages/core/src/personal-workbench.ts";
import type { ConversationId, DecisionRequestId } from "../../packages/core/src/run-kernel/types.ts";
import type { MigrationSnapshot } from "../../packages/core/src/migration-journal.ts";
import type { WorkbenchStorage, WorkbenchStoreOutcome } from "../../packages/core/src/workbench-store.ts";
import type { ProjectSession, SharedWriteOutcome } from "../use-project-workspace.client.ts";
import { PersonalWorkbenchController } from "./personal-workbench-controller.ts";
import type {
  ChatExecutionOverrides,
  ChatScratchParent,
  DecisionScratchParent,
  PersonalWorkbenchStatus,
  PromptAssetRef,
  PromptDraftBase,
  PromptDraftContent,
  MigrationBackupSummary,
  PublishOutcome,
  ReconcileOutcome,
  RecoveryAction,
  RecoveryComparison,
  RecoveryEntry,
  RecoveryItem,
  ScratchBranchPoint,
  UnsavedDraftSummary,
  WorkbenchAssetRef,
} from "./personal-workbench-controller.ts";

export type {
  ChatExecutionOverrides,
  ChatScratchParent,
  DecisionScratchParent,
  PersonalWorkbenchStatus,
  ScratchBranchPoint,
  PromptAssetRef,
  MigrationBackupSummary,
  PublishOutcome,
  ReconcileOutcome,
  RecoveryAction,
  RecoveryComparison,
  RecoveryEntry,
  RecoveryItem,
  UnsavedDraftSummary,
  WorkbenchAssetRef,
};

/**
 * The personal owner (D3): record load and save, recovery status and
 * publication. Step 2 routes prompt drafts, step 3 chat request drafts, chat
 * scratch and the chat selection, step 4 their decision equivalents, and
 * step 5 execution overrides and the launch-default write, and step 6b the
 * recovery inventory and its reconcile actions
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Delivery inside the gate").
 */
export interface PersonalWorkbenchHandle {
  /** False until a project session exists: without one, every owner takes its session-less path. */
  enabled: boolean;
  status: PersonalWorkbenchStatus;
  /** Counts the controller's changes, for a view that reads a record outside render, such as Compare. */
  revision: number;
  /** One active draft per asset (D6). */
  draftFor(asset: WorkbenchAssetRef): WorkbenchDraftV1 | undefined;
  unsavedDrafts: UnsavedDraftSummary[];
  /** Drafts and scratch requests that replacing the session would lose (Z3). Read from commands. */
  sessionOnlyWorkCount(): number;
  /**
   * Writes this session's records into a folder it was just saved to, and
   * resolves once they are on disk (S2, Z3). "Save and switch" waits for it:
   * the session's own carry-over runs after the next render, which the switch
   * would overtake.
   */
  persistSessionInto(target: {
    project: ProjectFile;
    storage: WorkbenchStorage;
    migrations: { read(): Promise<MigrationSnapshot> };
  }): Promise<void>;
  /** D8: everything the Recovery drawer lists, each with the actions it offers (V4). */
  recovery: readonly RecoveryEntry[];
  /** Migration backups, for "Remove migration backup" (D7, W3). */
  migrationBackups: MigrationBackupSummary[];
  reconcile: {
    compare(id: string): Promise<RecoveryComparison | undefined>;
    use(id: string): Promise<ReconcileOutcome>;
    discard(id: string): Promise<ReconcileOutcome>;
    keepAsDraft(id: string): Promise<ReconcileOutcome>;
    saveAsNew(id: string, name: string): Promise<ReconcileOutcome>;
    retry(id: string): Promise<ReconcileOutcome>;
    removeMigrationBackup(operationId: string): Promise<ReconcileOutcome>;
  };
  /** Held in memory at once and persisted after a short debounce (D14). */
  updateDraft(asset: PromptAssetRef, base: PromptDraftBase, edited: PromptDraftContent): void;
  discardDraft(asset: WorkbenchAssetRef): Promise<WorkbenchStoreOutcome | undefined>;
  /**
   * The four-step protocol: intent then read-back, then the workspace's shared
   * write, then clear or rebase the record. `extend` adds the direct shared
   * edits that ride with this Save, such as a template rename; it must be
   * deterministic, since the workspace may apply it twice.
   */
  publish(asset: PromptAssetRef, options?: { extend?(project: ProjectFile): ProjectFile }): Promise<PublishOutcome>;
  /** Before replacement or close: persist queued debounced writes. */
  flush(): Promise<void>;
  /** The selected chat input; undefined inherits the launch default. */
  chatSelection: LocalChatInput | undefined;
  scratches: WorkbenchScratchV1[];
  scratch(scratchId: string): WorkbenchScratchV1 | undefined;
  draftById(draftId: string): WorkbenchDraftV1 | undefined;
  selectChat(input: LocalChatInput | undefined): void;
  /** See `PersonalWorkbenchController.updateChatRequestDraft`. */
  updateChatRequestDraft(
    base: ProjectConversationRevision,
    items: ProjectConversationItem[],
    options?: { draftId?: string },
  ): WorkbenchChatRequestDraftV1 | undefined;
  createChatScratch(
    items: ProjectConversationItem[],
    options: { parent?: ChatScratchParent; branchedFrom?: ScratchBranchPoint },
  ): WorkbenchScratchV1 | undefined;
  updateChatScratch(scratchId: string, items: ProjectConversationItem[]): void;
  discardChatRequestDraft(conversationId: ConversationId): Promise<WorkbenchStoreOutcome | undefined>;
  discardScratch(scratchId: string): Promise<WorkbenchStoreOutcome | undefined>;
  publishChatRequestDraft(conversationId: ConversationId): Promise<PublishOutcome>;
  /** `name` names the new request when the scratch has no saved ancestor. */
  publishScratch(scratchId: string, name?: string): Promise<PublishOutcome>;
  /** The selected decision input; undefined inherits the launch default. */
  decisionSelection: LocalDecisionInput | undefined;
  selectDecision(input: LocalDecisionInput | undefined): void;
  /** See `PersonalWorkbenchController.updateDecisionRequestDraft`. */
  updateDecisionRequestDraft(
    base: ProjectDecisionRequestRevision,
    content: WorkbenchDecisionRequestContent,
    options?: { draftId?: string },
  ): WorkbenchDecisionRequestDraftV1 | undefined;
  createDecisionScratch(
    content: WorkbenchDecisionRequestContent,
    options: { parent?: DecisionScratchParent },
  ): WorkbenchScratchV1 | undefined;
  updateDecisionScratch(scratchId: string, content: WorkbenchDecisionRequestContent): void;
  discardDecisionRequestDraft(decisionRequestId: DecisionRequestId): Promise<WorkbenchStoreOutcome | undefined>;
  publishDecisionRequestDraft(decisionRequestId: DecisionRequestId): Promise<PublishOutcome>;
  /** Personal execution choices over the launch defaults (step 5); undefined inherits them. */
  chatExecution: ChatExecutionOverrides | undefined;
  /** Applies `update` to the overrides as they are now, not as last rendered. */
  updateChatExecution(update: (current: ChatExecutionOverrides | undefined) => ChatExecutionOverrides | undefined): void;
  /**
   * The D13 launch-default actions' one shared write. `update` must be
   * deterministic, since the workspace may apply it twice.
   */
  writeLaunchDefaults(update: (project: ProjectFile) => ProjectFile): Promise<SharedWriteOutcome>;
}

const OFF: PersonalWorkbenchStatus = { kind: "off" };
const NOT_OPEN: ReconcileOutcome = { kind: "blocked", message: "Open a project first." };

export function usePersonalWorkbench(input: {
  session: ProjectSession | undefined;
  /** Null without a folder, or for a legacy folder (S1): session-only. */
  storage: WorkbenchStorage | null;
  /** The folder's migration inventory as bytes; null whenever `storage` is. */
  migrations?: { read(): Promise<MigrationSnapshot> } | null;
  shared: ProjectFile | null;
  writeShared(update: (current: ProjectFile) => ProjectFile): Promise<SharedWriteOutcome>;
}): PersonalWorkbenchHandle {
  const [controller, setController] = useState<PersonalWorkbenchController | null>(null);
  // The session key the controller was opened for. A new adoption renders
  // before the effect below replaces the controller.
  const [controllerKey, setControllerKey] = useState<string>();
  const [revision, setRevision] = useState(0);
  const controllerRef = useRef<PersonalWorkbenchController | null>(null);
  const sharedRef = useRef(input.shared);
  const writeSharedRef = useRef(input.writeShared);
  useEffect(() => {
    sharedRef.current = input.shared;
    writeSharedRef.current = input.writeShared;
  });

  const personalSession = input.session;
  const sessionRef = useRef(personalSession);
  useEffect(() => {
    sessionRef.current = personalSession;
  });
  // The workspace returns a fresh session object each render; reopen only
  // when the adoption, the project or the storage actually changes.
  const sessionKey = personalSession ? `${personalSession.adoption}:${personalSession.projectId}` : undefined;
  const { storage } = input;
  const migrationsRef = useRef(input.migrations ?? null);
  useEffect(() => {
    migrationsRef.current = input.migrations ?? null;
  });
  useEffect(() => {
    const personal = sessionRef.current;
    const previous = controllerRef.current;
    if (!personal) {
      controllerRef.current = null;
      setController(null);
      setControllerKey(undefined);
      if (previous) void previous.flush().finally(() => previous.close());
      return;
    }
    // A session saved into a folder keeps the drafts it made meanwhile (S2).
    // Any other adoption of the same project, such as a re-import after
    // "Discard and switch", starts from that document's own records.
    const carried = personal.carriesSessionWork && previous && previous.status.kind === "session" && previous.projectId === personal.projectId
      ? previous.allRecords
      : [];
    const seeds: WorkbenchRecordV1[] = [...carried, ...personal.personalSeeds];
    const next = new PersonalWorkbenchController({
      projectId: personal.projectId,
      storage,
      migrations: storage ? migrationsRef.current : null,
      seeds,
      ...(personal.upgrade ? { upgrade: personal.upgrade } : {}),
      onChange: () => setRevision((current) => current + 1),
    });
    controllerRef.current = next;
    setController(next);
    setControllerKey(sessionKey);
    let cancelled = false;
    void (async () => {
      // The outgoing session's queued writes land before the new one reads.
      if (previous) {
        await previous.flush().catch(() => undefined);
        previous.close();
      }
      if (cancelled) return;
      const shared = sharedRef.current;
      if (shared && shared.projectId === personal.projectId) await next.open(shared);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionKey, storage]);

  useEffect(() => () => {
    const current = controllerRef.current;
    if (current) void current.flush().finally(() => current.close());
  }, []);

  // Work that is only in memory, or not yet written, is lost on unload.
  const unsaved = controller?.hasUnpersistedWork ?? false;
  useEffect(() => {
    if (!unsaved) return;
    function warnBeforeUnload(event: BeforeUnloadEvent): void {
      void controllerRef.current?.flush();
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [unsaved]);

  // Until then, render reads skip a previous session that held its records
  // only in memory: this adoption discards them unless it carries them (S2).
  // A folder's records are on disk, so the next controller reads the same ones.
  const stale = controller && controllerKey !== sessionKey && controller.status.kind === "session" && !personalSession?.carriesSessionWork;
  const live = stale ? null : controller;

  return {
    enabled: Boolean(personalSession),
    status: live?.status ?? OFF,
    revision,
    draftFor: (asset) => live?.draftFor(asset),
    unsavedDrafts: live?.unsavedDrafts ?? [],
    sessionOnlyWorkCount: () => controllerRef.current?.sessionOnlyWorkCount ?? 0,
    async persistSessionInto(target) {
      // Snapshot now, before the save's adoption renders a new controller.
      const records = controllerRef.current?.allRecords ?? [];
      if (!records.some((record) => record.kind !== "selections")) return;
      const writer = new PersonalWorkbenchController({
        projectId: target.project.projectId,
        storage: target.storage,
        migrations: target.migrations,
        seeds: records,
        onChange: () => undefined,
      });
      try {
        await writer.open(target.project);
        if (writer.status.kind !== "ready" || writer.hasUnpersistedWork) {
          throw new Error(writer.status.kind === "blocked"
            ? writer.status.message
            : "Could not write this session's drafts to the new folder.");
        }
      } finally {
        writer.close();
      }
    },
    recovery: live?.recovery ?? [],
    migrationBackups: live?.migrationBackups ?? [],
    reconcile: {
      async compare(id) {
        const current = controllerRef.current;
        const shared = sharedRef.current;
        return current && shared ? current.compareRecovery(id, shared) : undefined;
      },
      async use(id) {
        return controllerRef.current?.useRecovery(id) ?? NOT_OPEN;
      },
      async discard(id) {
        return controllerRef.current?.discardRecovery(id) ?? NOT_OPEN;
      },
      async keepAsDraft(id) {
        return controllerRef.current?.keepRecoveryAsDraft(id) ?? NOT_OPEN;
      },
      async saveAsNew(id, name) {
        const current = controllerRef.current;
        const shared = sharedRef.current;
        if (!current || !shared) return NOT_OPEN;
        return current.saveRecoveryAsNew(id, name, shared, (update) => writeSharedRef.current(update));
      },
      async retry(id) {
        const current = controllerRef.current;
        const shared = sharedRef.current;
        return current && shared ? current.retryRecovery(id, shared) : NOT_OPEN;
      },
      async removeMigrationBackup(operationId) {
        return controllerRef.current?.removeMigrationBackup(operationId) ?? NOT_OPEN;
      },
    },
    updateDraft(asset, base, edited) {
      controllerRef.current?.updatePromptDraft(asset, base, edited);
    },
    async discardDraft(asset) {
      return controllerRef.current?.discardDraft(asset);
    },
    async publish(asset, options) {
      const current = controllerRef.current;
      const shared = sharedRef.current;
      if (!current || !shared) return { kind: "blocked", message: "Open a project before saving a prompt." };
      return current.publishPromptDraft(asset, shared, (update) => writeSharedRef.current(update), options?.extend);
    },
    async flush() {
      await controllerRef.current?.flush();
    },
    chatSelection: live?.chatSelection,
    scratches: live?.scratches ?? [],
    scratch: (scratchId) => live?.scratch(scratchId),
    draftById: (draftId) => live?.draftById(draftId),
    selectChat(selection) {
      controllerRef.current?.selectChat(selection);
    },
    updateChatRequestDraft(base, items, options) {
      return controllerRef.current?.updateChatRequestDraft(base, items, options);
    },
    createChatScratch(items, options) {
      return controllerRef.current?.createChatScratch(items, options);
    },
    updateChatScratch(scratchId, items) {
      controllerRef.current?.updateChatScratch(scratchId, items);
    },
    async discardChatRequestDraft(conversationId) {
      return controllerRef.current?.discardChatRequestDraft(conversationId);
    },
    async discardScratch(scratchId) {
      return controllerRef.current?.discardScratch(scratchId);
    },
    async publishChatRequestDraft(conversationId) {
      const current = controllerRef.current;
      const shared = sharedRef.current;
      if (!current || !shared) return { kind: "blocked", message: "Open a project before saving a request." };
      return current.publishChatRequestDraft(conversationId, shared, (update) => writeSharedRef.current(update));
    },
    async publishScratch(scratchId, name) {
      const current = controllerRef.current;
      const shared = sharedRef.current;
      if (!current || !shared) return { kind: "blocked", message: "Open a project before saving a request." };
      return current.publishScratch(scratchId, shared, (update) => writeSharedRef.current(update), name);
    },
    decisionSelection: live?.decisionSelection,
    selectDecision(selection) {
      controllerRef.current?.selectDecision(selection);
    },
    updateDecisionRequestDraft(base, content, options) {
      return controllerRef.current?.updateDecisionRequestDraft(base, content, options);
    },
    createDecisionScratch(content, options) {
      return controllerRef.current?.createDecisionScratch(content, options);
    },
    updateDecisionScratch(scratchId, content) {
      controllerRef.current?.updateDecisionScratch(scratchId, content);
    },
    async discardDecisionRequestDraft(decisionRequestId) {
      return controllerRef.current?.discardDecisionRequestDraft(decisionRequestId);
    },
    async publishDecisionRequestDraft(decisionRequestId) {
      const current = controllerRef.current;
      const shared = sharedRef.current;
      if (!current || !shared) return { kind: "blocked", message: "Open a project before saving a request." };
      return current.publishDecisionRequestDraft(decisionRequestId, shared, (update) => writeSharedRef.current(update));
    },
    chatExecution: live?.chatExecution,
    updateChatExecution(update) {
      const current = controllerRef.current;
      current?.setChatExecution(update(current.chatExecution));
    },
    writeLaunchDefaults(update) {
      return writeSharedRef.current(update);
    },
  };
}
