"use client";

import { useEffect, useRef, useState } from "react";

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
  const generationRef = useRef(0);

  useEffect(() => {
    if (
      selection &&
      selection.kind !== "current-run" &&
      selection.projectId !== projectId
    ) {
      generationRef.current += 1;
      setSelection(undefined);
      setInspection(undefined);
      setScrollTop(0);
    }
  }, [projectId, selection]);

  function selectCurrent(runId: RunId): void {
    generationRef.current += 1;
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
    const generation = ++generationRef.current;
    setSelection(next);
    setInspection({ selection: next, status: "loading" });
    try {
      const trace = await readTrace(item.fileName);
      if (generation !== generationRef.current) return;
      if (trace.runId !== item.summary.runId) {
        throw new Error("The saved trace now contains a different run.");
      }
      setInspection({ selection: next, status: "ready", trace });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setInspection({
        selection: next,
        status: "error",
        error: error instanceof Error ? error.message : "The saved trace could not be read.",
      });
    }
  }

  function selectExperiment(item: ProjectExperimentHistoryItem): void {
    if (!projectId) return;
    generationRef.current += 1;
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
