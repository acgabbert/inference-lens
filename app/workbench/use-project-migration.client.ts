"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkbenchPromptDraftV1 } from "../../packages/core/src/personal-workbench.ts";
import type { ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import type { ProjectSession } from "../use-project-workspace.client.ts";
import type { UpgradeCarry } from "./personal-workbench-controller.ts";
import {
  findUnfinishedUpgrade,
  finishUpgrade,
  inspectProjectUpgrade,
  previewProjectMigration,
  upgradeProject,
} from "./project-migration.ts";
import type { ProjectMigrationPreview, ProjectUpgradeOutcome, UnfinishedUpgrade } from "./project-migration.ts";

export type ProjectUpgradeDialogState =
  | { phase: "loading" }
  | { phase: "preview"; preview: ProjectMigrationPreview; notice?: string }
  | { phase: "upgrading"; preview: ProjectMigrationPreview }
  | { phase: "failed"; preview?: ProjectMigrationPreview; message: string };

/**
 * The migration owner (I2): preview, staging and completion, then the reopen
 * that adopts the folder as v19. Reconciliation of what it could not restore
 * belongs to the personal workbench (6b). Every write is an explicit action;
 * opening a folder never migrates it (D4).
 */
export interface ProjectMigrationHandle {
  /** A pre-v19 folder in a personal session, in the tab that edits it. */
  available: boolean;
  dialog?: ProjectUpgradeDialogState;
  /** Unsaved shared changes this session holds; the reopen discards them. */
  discardsSharedChanges: boolean;
  openUpgrade(): void;
  closeUpgrade(): void;
  confirmUpgrade(): void;
  /** An upgrade interrupted after the shared write, on a v19 folder. */
  unfinished?: UnfinishedUpgrade & { finishing: boolean; message?: string };
  finish(): void;
  /** D5, V3: the shared write could not be confirmed; shared saves stay off. */
  inspection?: { message: string; checking: boolean };
  checkAgain(): void;
  /** What the upgrade could not restore automatically. */
  result?: string;
  dismissResult(): void;
}

function resultMessage(outcome: Extract<ProjectUpgradeOutcome, { kind: "upgraded" }>): string | undefined {
  const { pending, stopped } = outcome.recovery;
  if (stopped) return `Restoring personal drafts stopped at ${stopped.destination}: ${stopped.message} Finish the upgrade to try again.`;
  if (!pending.length) return undefined;
  const drafts = pending.filter((candidate) => candidate.kind === "draft").length;
  return drafts
    ? `${drafts} ${drafts === 1 ? "draft" : "drafts"} from the old project file met a personal draft already in this folder, so ${drafts === 1 ? "it is" : "they are"} kept in .workbench/migrations/ for review.`
    : "Your existing personal selections were kept; the ones copied from the old project file are in .workbench/migrations/.";
}

export function useProjectMigration(input: {
  session: ProjectSession | undefined;
  workspace: ProjectWorkspaceHandle | null;
  /** False in a tab that views the project while another edits it. */
  editable: boolean;
  /** Shared edits this session could not save, which a reopen discards. */
  sharedChangesUnsaved: boolean;
  /** The workspace's in-place reopen. */
  reopen(upgrade?: UpgradeCarry, expectedManifest?: string): Promise<boolean>;
}): ProjectMigrationHandle {
  const { session, workspace, editable } = input;
  const personal = session?.mode === "personal" && workspace ? session : undefined;
  const available = Boolean(personal && personal.format?.kind === "legacy" && editable);
  // Each piece of state names the adoption or project it belongs to, so a
  // later adoption hides it while rendering rather than resetting it in an effect.
  const adoptionKey = personal ? `${personal.projectId}:${personal.adoption}` : undefined;
  const [dialogState, setDialogState] = useState<{ key: string; state: ProjectUpgradeDialogState }>();
  const dialog = available && dialogState && dialogState.key === adoptionKey ? dialogState.state : undefined;
  const setDialog = (state: ProjectUpgradeDialogState | undefined) => {
    setDialogState(state && adoptionKey ? { key: adoptionKey, state } : undefined);
  };
  const [unfinishedState, setUnfinished] = useState<{ key: string; value: NonNullable<ProjectMigrationHandle["unfinished"]> }>();
  const unfinished = unfinishedState?.key === adoptionKey ? unfinishedState?.value : undefined;
  const [inspectionState, setInspection] = useState<{ projectId: ProjectSession["projectId"]; operationId: string; message: string; checking: boolean; lifted: readonly WorkbenchPromptDraftV1[] }>();
  const inspection = inspectionState?.projectId === personal?.projectId ? inspectionState : undefined;
  const [resultState, setResult] = useState<{ projectId: string; message: string }>();
  const result = resultState?.projectId === personal?.projectId ? resultState?.message : undefined;
  const reopenRef = useRef(input.reopen);
  useEffect(() => {
    reopenRef.current = input.reopen;
  });
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  });

  // A v19 folder may hold an upgrade that stopped after the shared write.
  const adoption = personal?.adoption;
  const projectId = personal?.projectId;
  const shared = personal?.format?.kind === "shared";
  useEffect(() => {
    if (!workspace || !projectId || !shared || !editable || adoption === undefined) return;
    const key = `${projectId}:${adoption}`;
    let cancelled = false;
    void findUnfinishedUpgrade(workspace.storage, projectId)
      .then((found) => {
        if (!cancelled && found) setUnfinished({ key, value: { ...found, finishing: false } });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspace, projectId, shared, editable, adoption]);

  async function loadPreview(notice?: string): Promise<void> {
    const current = workspaceRef.current;
    if (!current) return;
    setDialog({ phase: "loading" });
    const outcome = await previewProjectMigration(current.storage);
    if (workspaceRef.current !== current) return;
    setDialog(outcome.kind === "preview"
      ? { phase: "preview", preview: outcome.preview, ...(notice ? { notice } : {}) }
      : { phase: "failed", message: outcome.message });
  }

  async function runUpgrade(preview: ProjectMigrationPreview): Promise<void> {
    const current = workspaceRef.current;
    if (!current) return;
    setDialog({ phase: "upgrading", preview });
    const outcome = await upgradeProject(current.storage, preview);
    if (workspaceRef.current !== current) return;
    switch (outcome.kind) {
      case "stale":
        await loadPreview(outcome.message);
        return;
      case "failed":
        setDialog({ phase: "failed", preview, message: outcome.message });
        return;
      case "inspection":
        setDialog(undefined);
        setInspection({ projectId: preview.projectId, operationId: preview.operationId, message: outcome.message, checking: false, lifted: outcome.lifted });
        return;
      case "upgraded": {
        setDialog(undefined);
        setInspection(undefined);
        const message = resultMessage(outcome);
        setResult(message ? { projectId: preview.projectId, message } : undefined);
        const reopened = await reopenRef.current({ activated: outcome.activated, lifted: outcome.lifted });
        if (!reopened) setInspection({ projectId: preview.projectId, operationId: preview.operationId, message: "The project was upgraded, but the folder could not be reopened. Check again to open it.", checking: false, lifted: outcome.lifted });
      }
    }
  }

  async function runFinish(found: UnfinishedUpgrade): Promise<void> {
    const current = workspaceRef.current;
    if (!current || !projectId) return;
    const key = adoptionKey;
    if (!key) return;
    setUnfinished({ key, value: { ...found, finishing: true } });
    const outcome = await finishUpgrade(current.storage, projectId, found.operationId);
    if (workspaceRef.current !== current) return;
    if (outcome.kind !== "upgraded") {
      setUnfinished({ key, value: { ...found, finishing: false, message: outcome.message } });
      return;
    }
    const message = resultMessage(outcome);
    setResult(message ? { projectId, message } : undefined);
    await reopenRef.current();
  }

  async function runCheckAgain(): Promise<void> {
    const current = inspection;
    const workspace = workspaceRef.current;
    if (!current || !workspace) return;
    setInspection({ ...current, checking: true });
    const checked = await inspectProjectUpgrade(workspace.storage, current.projectId, current.operationId);
    if (workspaceRef.current !== workspace) return;
    if (checked.kind === "blocked") {
      setInspection({ ...current, checking: false, message: checked.message });
      return;
    }
    // A write that never landed reopens the pre-v19 folder, whose session keeps
    // its records, and Upgrade is offered again. A confirmed one carries them
    // over: drafts the session never edited are covered by the staged copies (V2).
    const reopened = checked.kind === "unchanged"
      ? await reopenRef.current(undefined, checked.manifest)
      : await reopenRef.current({ activated: [], lifted: current.lifted }, checked.manifest);
    if (!reopened && workspaceRef.current !== workspace) return;
    setInspection(reopened ? undefined : { ...current, checking: false });
  }

  return {
    available,
    ...(dialog ? { dialog } : {}),
    discardsSharedChanges: input.sharedChangesUnsaved,
    openUpgrade() {
      if (available) void loadPreview();
    },
    closeUpgrade() {
      if (dialog?.phase !== "upgrading") setDialog(undefined);
    },
    confirmUpgrade() {
      if (dialog?.phase === "preview" || (dialog?.phase === "failed" && dialog.preview)) void runUpgrade(dialog.preview!);
    },
    ...(unfinished ? { unfinished } : {}),
    finish() {
      if (unfinished && !unfinished.finishing) void runFinish(unfinished);
    },
    ...(inspection ? { inspection: { message: inspection.message, checking: inspection.checking } } : {}),
    checkAgain() {
      if (inspection && !inspection.checking) void runCheckAgain();
    },
    ...(result ? { result } : {}),
    dismissResult() {
      setResult(undefined);
    },
  };
}
