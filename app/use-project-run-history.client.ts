"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type RunHistoryFailure,
  type RunHistoryItem,
} from "../packages/core/src/run-history";
import {
  loadProjectHistoryFiles,
  type ExperimentHistoryItem,
  type ProjectHistoryEntry,
} from "../packages/core/src/experiment-history.ts";
import {
  parseExperimentPlanJson,
  parseExperimentResultJson,
  type ExperimentResultV3,
  type ExperimentPlanV3,
} from "../packages/core/src/experiment.ts";
import type { RunId, RunTrace } from "../packages/core/src/run-kernel";
import { parseRunTraceJson } from "../packages/core/src/run-trace";
import {
  listExperimentArtifactsWorkspace,
  listRunTraceWorkspace,
  readExperimentArtifactWorkspace,
  readRunTraceWorkspace,
  type ProjectWorkspaceHandle,
} from "./project-workspace.client";

export type ProjectRunHistoryItem = RunHistoryItem;
export type ProjectRunHistoryFailure = RunHistoryFailure;
export type ProjectExperimentHistoryItem = ExperimentHistoryItem;

export interface OpenedProjectExperiment {
  plan: ExperimentPlanV3;
  result?: ExperimentResultV3;
  traces: ReadonlyMap<RunId, RunTrace>;
  traceFileNames: ReadonlyMap<RunId, string>;
  /**
   * Cells whose referenced trace was listed but could not be read back, keyed
   * by run ID. A trace damaged or removed since the last refresh must stay
   * distinguishable from a repetition that never ran.
   */
  unreadableTraces: ReadonlyMap<RunId, string>;
}

export type ProjectRunHistoryStatus = "idle" | "loading" | "loaded" | "failed";

export interface ProjectRunHistoryState {
  status: ProjectRunHistoryStatus;
  entries: ProjectHistoryEntry[];
  items: ProjectRunHistoryItem[];
  experiments: ProjectExperimentHistoryItem[];
  failures: ProjectRunHistoryFailure[];
  artifactCount: number;
  largeHistory: boolean;
  error?: string;
  refresh(): Promise<void>;
  readTrace(fileName: string): Promise<RunTrace>;
  readExperiment(item: ProjectExperimentHistoryItem): Promise<OpenedProjectExperiment>;
}

interface LoadedFor {
  workspace: ProjectWorkspaceHandle | null;
  savedRunVersion: number;
}

/**
 * Loads a project's immutable traces on demand.
 *
 * Building the list costs a full parse and event reduction per artifact, and
 * no index is written that could make that cheaper, so the work happens only
 * while the caller reports the history is being looked at. Runs saved in the
 * meantime mark the list stale instead of re-reading the whole folder behind a
 * closed drawer.
 *
 * `status` starts at `idle` rather than at a loaded-but-empty state, so a
 * caller never renders "no runs" for a project whose listing has not been
 * attempted yet.
 */
export function useProjectRunHistory(
  workspace: ProjectWorkspaceHandle | null,
  active: boolean,
  savedRunVersion = 0,
): ProjectRunHistoryState {
  const [status, setStatus] = useState<ProjectRunHistoryStatus>("idle");
  const [entries, setEntries] = useState<ProjectHistoryEntry[]>([]);
  const [items, setItems] = useState<ProjectRunHistoryItem[]>([]);
  const [experiments, setExperiments] = useState<ProjectExperimentHistoryItem[]>([]);
  const [failures, setFailures] = useState<ProjectRunHistoryFailure[]>([]);
  const [artifactCount, setArtifactCount] = useState(0);
  const [largeHistory, setLargeHistory] = useState(false);
  const [error, setError] = useState<string>();
  const generationRef = useRef(0);
  const loadedForRef = useRef<LoadedFor | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    loadedForRef.current = { workspace, savedRunVersion };
    if (!workspace) {
      setStatus("loaded");
      setEntries([]);
      setItems([]);
      setExperiments([]);
      setFailures([]);
      setArtifactCount(0);
      setLargeHistory(false);
      setError(undefined);
      return;
    }

    setStatus("loading");
    setError(undefined);
    try {
      const [traceFiles, experimentFiles] = await Promise.all([
        listRunTraceWorkspace(workspace),
        listExperimentArtifactsWorkspace(workspace),
      ]);
      const result = loadProjectHistoryFiles(traceFiles, experimentFiles);
      if (generation !== generationRef.current) return;
      setEntries(result.entries);
      setItems(result.runs);
      setExperiments(result.experiments);
      setFailures(result.failures);
      setArtifactCount(result.artifactCount);
      setLargeHistory(result.largeHistory);
      setStatus("loaded");
    } catch (loadError) {
      if (generation !== generationRef.current) return;
      setEntries([]);
      setItems([]);
      setExperiments([]);
      setFailures([]);
      setArtifactCount(0);
      setLargeHistory(false);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load project run history.",
      );
      setStatus("failed");
      // A failed listing is not a loaded one, so reopening retries it.
      loadedForRef.current = null;
    }
  }, [savedRunVersion, workspace]);

  useEffect(() => {
    if (!active) return;
    const loaded = loadedForRef.current;
    if (
      loaded &&
      loaded.workspace === workspace &&
      loaded.savedRunVersion === savedRunVersion
    ) {
      return;
    }
    void refresh();
  }, [active, refresh, savedRunVersion, workspace]);

  useEffect(() => () => void (generationRef.current += 1), []);

  const readTrace = useCallback(
    async (fileName: string): Promise<RunTrace> => {
      if (!workspace) throw new Error("The project folder is no longer open.");
      return parseRunTraceJson(await readRunTraceWorkspace(workspace, fileName));
    },
    [workspace],
  );

  const readExperiment = useCallback(
    async (item: ProjectExperimentHistoryItem): Promise<OpenedProjectExperiment> => {
      if (!workspace) throw new Error("The project folder is no longer open.");
      const plan = parseExperimentPlanJson(
        await readExperimentArtifactWorkspace(workspace, item.planFileName),
      );
      if (plan.experimentId !== item.experimentId) {
        throw new Error("The experiment plan changed since history was refreshed.");
      }
      const result = item.resultFileName
        ? parseExperimentResultJson(
            await readExperimentArtifactWorkspace(workspace, item.resultFileName),
            plan,
          )
        : undefined;
      const traces = new Map<RunId, RunTrace>();
      const traceFileNames = new Map<RunId, string>();
      const unreadableTraces = new Map<RunId, string>();
      await Promise.all(item.cells.map(async (cell) => {
        if (!cell.traceFileName) return;
        try {
          const trace = parseRunTraceJson(
            await readRunTraceWorkspace(workspace, cell.traceFileName),
          );
          if (trace.runId !== cell.runId) {
            unreadableTraces.set(
              cell.runId,
              `${cell.traceFileName} now holds a different run.`,
            );
            return;
          }
          traces.set(cell.runId, trace);
          traceFileNames.set(cell.runId, cell.traceFileName);
        } catch (error) {
          // A trace removed or damaged after the last refresh is reported as
          // unreadable rather than silently shown as a repetition that never
          // ran; the plan itself remains independently openable.
          unreadableTraces.set(
            cell.runId,
            error instanceof Error ? error.message : `${cell.traceFileName} could not be read.`,
          );
        }
      }));
      return {
        plan,
        ...(result ? { result } : {}),
        traces,
        traceFileNames,
        unreadableTraces,
      };
    },
    [workspace],
  );

  return {
    status,
    entries,
    items,
    experiments,
    failures,
    artifactCount,
    largeHistory,
    error,
    refresh,
    readTrace,
    readExperiment,
  };
}
