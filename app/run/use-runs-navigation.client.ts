"use client";

import { useRef, useState } from "react";

import type { RunId } from "../../packages/core/src/run-kernel";
import type {
  ProjectExperimentHistoryItem,
  ProjectRunHistoryItem,
} from "../use-project-run-history.client";
import type { RunsHistoryFilter, RunsSelection } from "./runs-evidence-list.client";

import type { SavedRunTrace } from "../../packages/core/src/run-trace";
import type { ProjectWorkspaceHandle } from "../project-workspace.client";
import { isSameProjectWorkspace } from "../project-workspace.client";

interface RunsInspection {
  selection: Extract<RunsSelection, { kind: "saved-run" }>;
  status: "loading" | "ready" | "error";
  saved?: SavedRunTrace;
  diagnosticsOpen?: boolean;
  error?: string;
}

/**
 * Owns transient Runs navigation independently from both the live execution
 * session and project serialization. Selection stores stable identities;
 * loaded traces are replaceable read models and never become Compose state.
 */
export function useRunsNavigation({
  projectId,
  readSavedTrace,
  workspace,
}: {
  projectId?: string;
  readSavedTrace(fileName: string): Promise<SavedRunTrace>;
  workspace: ProjectWorkspaceHandle | null;
}) {
  const [selection, setSelection] = useState<RunsSelection>();
  const [filter, setFilter] = useState<RunsHistoryFilter>("all");
  const [scrollTop, setScrollTop] = useState(0);
  const [inspection, setInspection] = useState<RunsInspection>();
  const [navigationProjectId, setNavigationProjectId] = useState(projectId);
  const [navigationWorkspace, setNavigationWorkspace] = useState(workspace);
  const generation = useRef(0);

  if (navigationWorkspace !== workspace || navigationProjectId !== projectId) {
    setNavigationProjectId(projectId);
    setNavigationWorkspace(workspace);
    if (navigationProjectId !== projectId || !isSameProjectWorkspace(navigationWorkspace, workspace)) {
      generation.current++;
      setSelection(undefined);
      setInspection(undefined);
      setScrollTop(0);
    }
  }

  function selectCurrent(runId: RunId): void {
    generation.current++;
    setInspection(undefined);
    setSelection({ kind: "current-run", runId });
  }

  /**
   * Shows the session's batch. A batch the user starts selects itself through
   * this; one that merely finishes in the background never calls it, so it
   * cannot replace evidence the user is reading.
   */
  function selectCurrentBatch(): void {
    generation.current++;
    setInspection(undefined);
    setSelection({ kind: "current-batch" });
  }

  /** Gives the main area back to whatever results are open, such as a comparison. */
  function clearSelection(): void {
    generation.current++;
    setInspection(undefined);
    setSelection(undefined);
  }

  async function selectSavedRun(item: ProjectRunHistoryItem): Promise<void> {
    if (!projectId) return;
    const token = ++generation.current;
    const next = {
      kind: "saved-run" as const,
      projectId,
      runId: item.summary.runId,
      fileName: item.fileName,
    };
    setSelection(next);
    setInspection({ selection: next, status: "loading" });
    try {
      const saved = await readSavedTrace(item.fileName);
      if (saved.trace.runId !== item.summary.runId) {
        throw new Error("The saved trace now contains a different run.");
      }
      setInspection((current) =>
        generation.current === token && current?.selection.projectId === next.projectId &&
        current.selection.runId === next.runId &&
        current.selection.fileName === next.fileName
          ? { selection: next, status: "ready", saved }
          : current,
      );
    } catch (error) {
      setInspection((current) =>
        generation.current === token && current?.selection.projectId === next.projectId &&
        current.selection.runId === next.runId &&
        current.selection.fileName === next.fileName
          ? {
              selection: next,
              status: "error",
              error:
                error instanceof Error
                  ? error.message
                  : "The saved trace could not be read.",
            }
          : current,
      );
    }
  }

  function selectExperiment(item: ProjectExperimentHistoryItem): void {
    if (!projectId) return;
    generation.current++;
    setInspection(undefined);
    setSelection({ kind: "experiment", projectId, experimentId: item.experimentId });
  }

  function selectResolved(projectId: string, fileName: string, saved: SavedRunTrace, owner: ProjectWorkspaceHandle): void {
    generation.current++;
    setNavigationProjectId(projectId);
    setNavigationWorkspace(owner);
    const selection = { kind: "saved-run" as const, projectId, runId: saved.trace.runId, fileName };
    setSelection(selection);
    setFilter("all");
    setInspection({ selection, status: "ready", saved, diagnosticsOpen: true });
  }

  return {
    selection,
    filter,
    scrollTop,
    inspection,
    setFilter,
    setScrollTop,
    selectCurrent,
    selectCurrentBatch,
    clearSelection,
    selectSavedRun,
    selectResolved,
    selectExperiment,
  };
}
