"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { ProjectFile } from "../../packages/core/src/project";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client";
import { StatusChip } from "../notifications/status-chip.client";
import { RecoveryDrawer } from "./recovery-drawer.client";
import { changesActiveCopy, recoveryChip, recoveryTargetKey, recoveryTargets } from "./recovery-view";
import type { PersonalWorkbenchHandle, WorkbenchAssetRef } from "./use-personal-workbench.client";

/** The topbar's Recovery chip (X1). */
export interface RecoveryChipProps {
  label: string;
  onOpen(): void;
}

/**
 * The Recovery surface's owner (D8; docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md,
 * "Step 6b-2 decisions"): whether the drawer is open and on what, the chip,
 * the pane marks and the in-pane notice. Reconciliation itself stays with the
 * personal workbench. Everything is empty outside a personal session.
 */
export interface RecoveryHandle {
  chip: RecoveryChipProps | undefined;
  /** X3: `prompt:<id>`, `request:<id>` and `scratch:<id>` keys with items. */
  marked: ReadonlySet<string>;
  /** X3: the notice for a pane editing this key, or nothing. */
  notice(key: string | undefined): ReactNode;
  /**
   * Counts the settled actions that changed this key's active copy. An editor
   * that holds its own copy of a record, such as the prompt editor, keys on it
   * to reload what Recovery activated.
   */
  generation(key: string): number;
  drawer: ReactNode;
}

/** What a pane that marks and notices Recovery items reads. */
export type RecoveryMarks = Pick<RecoveryHandle, "marked" | "notice">;

const NONE: ReadonlySet<string> = new Set();
const NO_GENERATIONS: ReadonlyMap<string, number> = new Map();

export function useRecovery(input: {
  personal: Pick<PersonalWorkbenchHandle, "enabled" | "revision" | "recovery" | "migrationBackups" | "reconcile">;
  project: ProjectFile | null | undefined;
  /** A prompt's name outside the shared project, such as a session prompt. */
  promptName?(id: string): string | undefined;
  /** A settled action changed this key's active copy; owners drop what they remembered of the old one. */
  onActiveCopyChanged?(key: string): void;
  requestConfirmation(request: ConfirmationDialogRequest): void;
}): RecoveryHandle {
  const { personal, project } = input;
  const [drawer, setDrawer] = useState<{ focus?: string }>();
  const [generations, setGenerations] = useState(NO_GENERATIONS);
  // The drawer and its counts belong to one personal project: start over when it changes.
  const scope = personal.enabled ? project?.projectId ?? "" : undefined;
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setDrawer(undefined);
    setGenerations(NO_GENERATIONS);
  }
  const recovery = personal.enabled ? personal.recovery : [];
  const backups = personal.enabled ? personal.migrationBackups : [];
  const chip = recoveryChip(recovery, backups);
  const marked = recovery.length > 0 ? recoveryTargets(recovery) : NONE;

  function nameOf(asset: WorkbenchAssetRef): string | undefined {
    switch (asset.kind) {
      case "chat-prompt":
      case "decision-prompt":
        return project?.promptTemplates.find(({ id }) => id === asset.id)?.name ?? input.promptName?.(asset.id);
      case "chat-request":
        return project?.conversations.find(({ id }) => id === asset.id)?.name;
      case "decision-request":
        return project?.decisionRequests.find(({ id }) => id === asset.id)?.name;
    }
  }

  return {
    chip: chip ? { label: chip.label, onOpen: () => setDrawer({}) } : undefined,
    marked,
    generation: (key) => generations.get(key) ?? 0,
    notice(key) {
      if (!key || !marked.has(key)) return null;
      const count = recovery.filter((item) => recoveryTargetKey(item) === key).length;
      return (
        <StatusChip
          tone="advisory"
          label="Needs recovery"
          detail={count === 1 ? "A copy of this work needs a decision." : `${count} copies of this work need a decision.`}
          actions={[{ key: "open", label: "Open Recovery", onSelect: () => setDrawer({ focus: key }) }]}
        />
      );
    },
    drawer: personal.enabled ? (
      <RecoveryDrawer
        open={Boolean(drawer)}
        onClose={() => setDrawer(undefined)}
        recovery={recovery}
        backups={backups}
        revision={personal.revision}
        reconcile={personal.reconcile}
        nameOf={nameOf}
        {...(drawer?.focus ? { focus: drawer.focus } : {})}
        onShowAll={() => setDrawer({})}
        onSettled={(item, action) => {
          const key = recoveryTargetKey(item);
          if (!key || !changesActiveCopy(item, action)) return;
          input.onActiveCopyChanged?.(key);
          setGenerations((current) => new Map(current).set(key, (current.get(key) ?? 0) + 1));
        }}
        requestConfirmation={input.requestConfirmation}
      />
    ) : null,
  };
}
