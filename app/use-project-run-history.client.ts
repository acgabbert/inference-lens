"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadRunHistoryFiles,
  type RunHistoryFailure,
  type RunHistoryItem,
} from "../packages/core/src/run-history";
import {
  listRunTraceWorkspace,
  type ProjectWorkspaceHandle,
} from "./project-workspace.client";

export type ProjectRunHistoryItem = RunHistoryItem;
export type ProjectRunHistoryFailure = RunHistoryFailure;

export interface ProjectRunHistoryState {
  items: ProjectRunHistoryItem[];
  failures: ProjectRunHistoryFailure[];
  loading: boolean;
  error?: string;
  refresh(): Promise<void>;
}

/** Loads immutable traces whenever the active project workspace changes. */
export function useProjectRunHistory(
  workspace: ProjectWorkspaceHandle | null,
  refreshVersion = 0,
): ProjectRunHistoryState {
  const [items, setItems] = useState<ProjectRunHistoryItem[]>([]);
  const [failures, setFailures] = useState<ProjectRunHistoryFailure[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generationRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    if (!workspace) {
      setItems([]);
      setFailures([]);
      setError(undefined);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const result = loadRunHistoryFiles(
        await listRunTraceWorkspace(workspace),
      );
      if (generation !== generationRef.current) return;
      setItems(result.items);
      setFailures(result.failures);
    } catch (loadError) {
      if (generation !== generationRef.current) return;
      setItems([]);
      setFailures([]);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load project run history.",
      );
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    const refreshId = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(refreshId);
      generationRef.current += 1;
    };
  }, [refresh, refreshVersion]);

  return { items, failures, loading, error, refresh };
}
