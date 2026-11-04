"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type { WorkbenchDraftV1, WorkbenchRecordV1 } from "../../packages/core/src/personal-workbench.ts";
import type { WorkbenchStorage, WorkbenchStoreOutcome } from "../../packages/core/src/workbench-store.ts";
import type { ProjectSession, SharedWriteOutcome } from "../use-project-workspace.client.ts";
import { PersonalWorkbenchController } from "./personal-workbench-controller.ts";
import type {
  PersonalWorkbenchStatus,
  PromptAssetRef,
  PromptDraftBase,
  PromptDraftContent,
  PublishOutcome,
  RecoveryItem,
  UnsavedDraftSummary,
  WorkbenchAssetRef,
} from "./personal-workbench-controller.ts";

export type {
  PersonalWorkbenchStatus,
  PromptAssetRef,
  PublishOutcome,
  RecoveryItem,
  UnsavedDraftSummary,
  WorkbenchAssetRef,
};

/**
 * The personal owner (D3): record load and save, recovery status and
 * publication. Step 2 routes prompt drafts; selections, request drafts,
 * scratch and reconciliation arrive in steps 3–6
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Delivery inside the gate").
 */
export interface PersonalWorkbenchHandle {
  /** False in a legacy session: every owner takes today's path. */
  enabled: boolean;
  status: PersonalWorkbenchStatus;
  /** One active draft per asset (D6). */
  draftFor(asset: WorkbenchAssetRef): WorkbenchDraftV1 | undefined;
  unsavedDrafts: UnsavedDraftSummary[];
  recovery: readonly RecoveryItem[];
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
}

const OFF: PersonalWorkbenchStatus = { kind: "off" };

export function usePersonalWorkbench(input: {
  session: ProjectSession | undefined;
  /** Null without a folder, or for a legacy folder (S1): session-only. */
  storage: WorkbenchStorage | null;
  shared: ProjectFile | null;
  writeShared(update: (current: ProjectFile) => ProjectFile): Promise<SharedWriteOutcome>;
}): PersonalWorkbenchHandle {
  const [controller, setController] = useState<PersonalWorkbenchController | null>(null);
  const [, setRevision] = useState(0);
  const controllerRef = useRef<PersonalWorkbenchController | null>(null);
  const sharedRef = useRef(input.shared);
  const writeSharedRef = useRef(input.writeShared);
  useEffect(() => {
    sharedRef.current = input.shared;
    writeSharedRef.current = input.writeShared;
  });

  const personalSession = input.session?.mode === "personal" ? input.session : undefined;
  const sessionRef = useRef(personalSession);
  useEffect(() => {
    sessionRef.current = personalSession;
  });
  // The workspace returns a fresh session object each render; reopen only
  // when the adoption, the project or the storage actually changes.
  const sessionKey = personalSession ? `${personalSession.adoption}:${personalSession.projectId}` : undefined;
  const { storage } = input;
  useEffect(() => {
    const personal = sessionRef.current;
    const previous = controllerRef.current;
    if (!personal) {
      controllerRef.current = null;
      setController(null);
      if (previous) void previous.flush().finally(() => previous.close());
      return;
    }
    // A session saved into a folder keeps the drafts it made meanwhile (S2).
    const carried = previous && previous.status.kind === "session" && previous.projectId === personal.projectId
      ? previous.allRecords
      : [];
    const seeds: WorkbenchRecordV1[] = [...carried, ...personal.personalSeeds];
    const next = new PersonalWorkbenchController({
      projectId: personal.projectId,
      storage,
      seeds,
      onChange: () => setRevision((current) => current + 1),
    });
    controllerRef.current = next;
    setController(next);
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
  const unsaved = controller?.unsavedDrafts.some(({ persisted }) => !persisted) ?? false;
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

  return {
    enabled: Boolean(personalSession),
    status: controller?.status ?? OFF,
    draftFor: (asset) => controller?.draftFor(asset),
    unsavedDrafts: controller?.unsavedDrafts ?? [],
    recovery: controller?.recovery ?? [],
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
  };
}
