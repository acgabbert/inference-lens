import type { AppBanner } from "./notifications/banner-priority.client.ts";
import type { ProjectTabState } from "./use-project-workspace.client.ts";

export interface ProjectTabBannerActions {
  becomeEditor(): void;
  confirmTakeover(): void;
  cancelTakeover(): void;
  exportCopy(): void;
}

/**
 * The banner a tab that does not save the project shows. It says plainly that
 * this tab's edits are not being saved, and offers the one way to change that.
 * Becoming editor reloads from disk, so a tab with edits is asked first, with
 * an export of its version on offer.
 */
export function projectTabBanner(
  tab: ProjectTabState | undefined,
  actions: ProjectTabBannerActions,
): AppBanner | undefined {
  if (!tab || tab.role !== "secondary") return undefined;
  const exportCopy = { key: "export", label: "Export JSON copy…", onSelect: actions.exportCopy };

  if (tab.confirmTakeover) {
    return {
      id: "project-tab",
      tone: "advisory",
      title: tab.confirmTakeover === "editor-closed"
        ? "The tab that was editing this project closed. Edit here and discard this tab's unsaved changes?"
        : "Edit here and discard this tab's unsaved changes?",
      detail: "The project reloads from its folder with the latest saved changes. Export a JSON copy first to keep this tab's version.",
      actions: [
        { key: "confirm", label: "Discard and edit here", primary: true, onSelect: actions.confirmTakeover },
        exportCopy,
        { key: "cancel", label: "Not now", onSelect: actions.cancelTakeover },
      ],
    };
  }

  const editHere = {
    key: "edit-here",
    label: tab.switching ? "Switching…" : "Edit here",
    primary: true,
    onSelect: actions.becomeEditor,
  };
  if (tab.lostEdits) {
    return {
      id: "project-tab",
      tone: "failure",
      title: "Another tab took over editing before this tab's changes were saved.",
      detail: "They are still in this tab. Export a JSON copy to keep them.",
      actions: [exportCopy, { ...editHere, primary: false }],
    };
  }
  return {
    id: "project-tab",
    tone: "advisory",
    title: "Another tab is editing this project. Changes in this tab are not saved.",
    detail: tab.behind
      ? "That tab has saved newer changes since this one loaded the project. Runs from this tab are still recorded."
      : "Runs from this tab are still recorded.",
    actions: [editHere],
  };
}
