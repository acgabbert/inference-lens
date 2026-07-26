"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadRunHistoryFiles,
  type RunHistoryFailure,
  type RunHistoryItem,
} from "../packages/core/src/run-history";
import type { RunTrace } from "../packages/core/src/run-kernel";
import { parseRunTraceJson } from "../packages/core/src/run-trace";
import {
  listRunTraceWorkspace,
  readRunTraceWorkspace,
  type ProjectWorkspaceHandle,
} from "./project-workspace.client";

export type ProjectRunHistoryItem = RunHistoryItem;
export type ProjectRunHistoryFailure = RunHistoryFailure;

export type ProjectRunHistoryStatus = "idle" | "loading" | "loaded" | "failed";

export interface ProjectRunHistoryState {
  status: ProjectRunHistoryStatus;
  items: ProjectRunHistoryItem[];
  failures: ProjectRunHistoryFailure[];
  error?: string;
  refresh(): Promise<void>;
  readTrace(fileName: string): Promise<RunTrace>;
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
  const [items, setItems] = useState<ProjectRunHistoryItem[]>([]);
  const [failures, setFailures] = useState<ProjectRunHistoryFailure[]>([]);
  const [error, setError] = useState<string>();
  const generationRef = useRef(0);
  const loadedForRef = useRef<LoadedFor | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    loadedForRef.current = { workspace, savedRunVersion };
    if (!workspace) {
      setStatus("loaded");
      setItems([]);
      setFailures([]);
      setError(undefined);
      return;
    }

    setStatus("loading");
    setError(undefined);
    try {
      const result = loadRunHistoryFiles(await listRunTraceWorkspace(workspace));
      if (generation !== generationRef.current) return;
      setItems(result.items);
      setFailures(result.failures);
      setStatus("loaded");
    } catch (loadError) {
      if (generation !== generationRef.current) return;
      setItems([]);
      setFailures([]);
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

  return { status, items, failures, error, refresh, readTrace };
}
