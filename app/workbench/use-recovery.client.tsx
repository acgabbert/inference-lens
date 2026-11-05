"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { ProjectFile } from "../../packages/core/src/project";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client";
import { StatusChip } from "../notifications/status-chip.client";
import { RecoveryDrawer } from "./recovery-drawer.client";
import { recoveryChip, recoveryTargetKey, recoveryTargets } from "./recovery-view";
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
   * Counts settled actions. An editor that holds its own copy of a record,
   * such as the prompt editor, keys on it to reload what Recovery activated.
   */
  generation: number;
  drawer: ReactNode;
}

const NONE: ReadonlySet<string> = new Set();

export function useRecovery(input: {
  personal: Pick<PersonalWorkbenchHandle, "enabled" | "recovery" | "migrationBackups" | "reconcile">;
  project: ProjectFile | null | undefined;
  requestConfirmation(request: ConfirmationDialogRequest): void;
}): RecoveryHandle {
  const { personal, project } = input;
  const [drawer, setDrawer] = useState<{ focus?: string }>();
  const [generation, setGeneration] = useState(0);
  const recovery = personal.enabled ? personal.recovery : [];
  const backups = personal.enabled ? personal.migrationBackups : [];
  const chip = recoveryChip(recovery, backups);
  const marked = recovery.length > 0 ? recoveryTargets(recovery) : NONE;

  function nameOf(asset: WorkbenchAssetRef): string | undefined {
    if (!project) return undefined;
    switch (asset.kind) {
      case "chat-prompt":
      case "decision-prompt":
        return project.promptTemplates.find(({ id }) => id === asset.id)?.name;
      case "chat-request":
        return project.conversations.find(({ id }) => id === asset.id)?.name;
      case "decision-request":
        return project.decisionRequests.find(({ id }) => id === asset.id)?.name;
    }
  }

  return {
    chip: chip ? { label: chip.label, onOpen: () => setDrawer({}) } : undefined,
    marked,
    generation,
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
        reconcile={personal.reconcile}
        nameOf={nameOf}
        {...(drawer?.focus ? { focus: drawer.focus } : {})}
        onShowAll={() => setDrawer({})}
        onSettled={() => setGeneration((current) => current + 1)}
        requestConfirmation={input.requestConfirmation}
      />
    ) : null,
  };
}
