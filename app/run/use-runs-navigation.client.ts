"use client";

import { useState } from "react";

import type { RunId, RunTrace } from "../../packages/core/src/run-kernel";
import type {
  ProjectExperimentHistoryItem,
  ProjectRunHistoryItem,
} from "../use-project-run-history.client";
import type { RunsHistoryFilter, RunsSelection } from "./runs-evidence-list.client";

interface RunsInspection {
  selection: Extract<RunsSelection, { kind: "saved-run" }>;
  status: "loading" | "ready" | "error";
  trace?: RunTrace;
  error?: string;
}

/**
 * Owns transient Runs navigation independently from both the live execution
 * session and project serialization. Selection stores stable identities;
 * loaded traces are replaceable read models and never become Compose state.
 */
export function useRunsNavigation({
  projectId,
  readTrace,
}: {
  projectId?: string;
  readTrace(fileName: string): Promise<RunTrace>;
}) {
  const [selection, setSelection] = useState<RunsSelection>();
  const [filter, setFilter] = useState<RunsHistoryFilter>("all");
  const [scrollTop, setScrollTop] = useState(0);
  const [inspection, setInspection] = useState<RunsInspection>();
  const [navigationProjectId, setNavigationProjectId] = useState(projectId);

  if (navigationProjectId !== projectId) {
    setNavigationProjectId(projectId);
    setSelection(undefined);
    setInspection(undefined);
    setScrollTop(0);
  }

  function selectCurrent(runId: RunId): void {
    setInspection(undefined);
    setSelection({ kind: "current-run", runId });
  }

  async function selectSavedRun(item: ProjectRunHistoryItem): Promise<void> {
    if (!projectId) return;
    const next = {
      kind: "saved-run" as const,
      projectId,
      runId: item.summary.runId,
      fileName: item.fileName,
    };
    setSelection(next);
    setInspection({ selection: next, status: "loading" });
    try {
      const trace = await readTrace(item.fileName);
      if (trace.runId !== item.summary.runId) {
        throw new Error("The saved trace now contains a different run.");
      }
      setInspection((current) =>
        current?.selection.projectId === next.projectId &&
        current.selection.runId === next.runId &&
        current.selection.fileName === next.fileName
          ? { selection: next, status: "ready", trace }
          : current,
      );
    } catch (error) {
      setInspection((current) =>
        current?.selection.projectId === next.projectId &&
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
    setInspection(undefined);
    setSelection({ kind: "experiment", projectId, experimentId: item.experimentId });
  }

  return {
    selection,
    filter,
    scrollTop,
    inspection,
    setFilter,
    setScrollTop,
    selectCurrent,
    selectSavedRun,
    selectExperiment,
  };
}
