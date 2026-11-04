import type { AppBanner } from "../notifications/banner-priority.client.ts";
import type { ProjectMigrationHandle } from "./use-project-migration.client.ts";

/**
 * The upgrade's standing conditions, most pressing first: a shared write that
 * could not be confirmed (V3), an upgrade that stopped before restoring every
 * draft, the offer to upgrade a pre-v19 folder (D4), and what an upgrade
 * could not restore automatically.
 */
export function projectUpgradeBanner(
  migration: ProjectMigrationHandle,
  actions: { exportCopy(): void },
): AppBanner | undefined {
  if (migration.inspection) {
    return {
      id: "project-upgrade",
      tone: "failure",
      title: migration.inspection.message,
      detail: "Shared saves stay off. Viewing, running and run history still work. Check again verifies the upgrade before reopening the folder.",
      actions: [
        { key: "check", label: migration.inspection.checking ? "Checking…" : "Check again", primary: true, onSelect: migration.checkAgain },
        { key: "export", label: "Export JSON copy…", onSelect: actions.exportCopy },
      ],
    };
  }
  if (migration.unfinished) {
    const { remaining, finishing, message } = migration.unfinished;
    return {
      id: "project-upgrade",
      tone: "advisory",
      title: "An earlier upgrade of this project did not finish restoring your personal records.",
      detail: message ?? `${remaining} ${remaining === 1 ? "record waits" : "records wait"} in .workbench/migrations/.`,
      actions: [{ key: "finish", label: finishing ? "Finishing…" : "Finish upgrade", primary: true, onSelect: migration.finish }],
    };
  }
  if (migration.available) {
    return {
      id: "project-upgrade",
      tone: "advisory",
      title: "This folder uses an older project format.",
      detail: "Viewing, running and run history work, but shared saves are off until the project is upgraded.",
      actions: [{ key: "upgrade", label: "Upgrade project…", primary: true, onSelect: migration.openUpgrade }],
    };
  }
  if (migration.result) {
    return {
      id: "project-upgrade",
      tone: "advisory",
      title: "Project upgraded.",
      detail: migration.result,
      actions: [{ key: "dismiss", label: "Dismiss", onSelect: migration.dismissResult }],
    };
  }
  return undefined;
}
