"use client";

import { useState } from "react";

import type { RunId } from "../packages/core/src/run-kernel";
import type {
  ProjectExperimentHistoryItem,
  ProjectRunHistoryItem,
  ProjectRunHistoryState,
} from "./use-project-run-history.client";
import type { ExperimentId } from "../packages/core/src/run-kernel/index.ts";
import { formatDuration, formatTokens } from "./run-metrics-format.client";
import { SideDrawer } from "./workbench-shell.client";

interface RunHistoryDrawerProps {
  open: boolean;
  projectName?: string;
  selectedRunId?: RunId;
  selectedExperimentId?: ExperimentId;
  history: ProjectRunHistoryState;
  onClose(): void;
  onSelect(item: ProjectRunHistoryItem): Promise<void>;
  onSelectExperiment(item: ProjectExperimentHistoryItem): Promise<void>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function historyMeta(item: ProjectRunHistoryItem): string {
  const { summary } = item;
  return [
    formatDuration(summary.durationMs),
    `${formatTokens(summary.usage.totalTokens)} tokens`,
    `${summary.turnCount} ${summary.turnCount === 1 ? "turn" : "turns"}`,
    ...(summary.retryCount > 0
      ? [
          `${summary.retryCount} ${
            summary.retryCount === 1 ? "retry" : "retries"
          }`,
        ]
      : []),
  ].join(" · ");
}

function experimentMeta(item: ProjectExperimentHistoryItem): string {
  const outcomes = [
    item.completed ? `${item.completed} completed` : undefined,
    item.failed ? `${item.failed} failed` : undefined,
    item.cancelled ? `${item.cancelled} cancelled` : undefined,
    item.notRun ? `${item.notRun} not run` : undefined,
    item.missingTrace ? `${item.missingTrace} missing` : undefined,
  ].filter(Boolean);
  return outcomes.length > 0 ? outcomes.join(" · ") : `${item.requested} planned`;
}

export function RunHistoryDrawer({
  open,
  projectName,
  selectedRunId,
  selectedExperimentId,
  history,
  onClose,
  onSelect,
  onSelectExperiment,
}: RunHistoryDrawerProps) {
  const [pendingFileName, setPendingFileName] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  // `idle` means the listing has not been attempted, which must not render as
  // an empty project.
  const busy = history.status === "idle" || history.status === "loading";

  async function selectItem(item: ProjectRunHistoryItem): Promise<void> {
    setPendingFileName(item.fileName);
    setOpenError(undefined);
    try {
      await onSelect(item);
    } catch (error) {
      setOpenError(
        error instanceof Error ? error.message : "Could not open the trace.",
      );
    } finally {
      setPendingFileName(undefined);
    }
  }

  async function selectExperiment(item: ProjectExperimentHistoryItem): Promise<void> {
    setPendingFileName(item.planFileName);
    setOpenError(undefined);
    try {
      await onSelectExperiment(item);
    } catch (error) {
      setOpenError(
        error instanceof Error ? error.message : "Could not open the experiment.",
      );
    } finally {
      setPendingFileName(undefined);
    }
  }

  return (
    <SideDrawer
      open={open}
      eyebrow="Project evidence"
      title="Run history"
      description={
        projectName
          ? `Immutable traces saved in ${projectName}.`
          : "Open a project folder to browse its saved traces."
      }
      onClose={onClose}
    >
      <div className="run-history">
        <div className="run-history-toolbar">
          <span>
            {busy
              ? "Loading…"
              : `${history.entries.length} saved ${
                  history.entries.length === 1 ? "entry" : "entries"
                }`}
          </span>
          <button
            className="text-button"
            type="button"
            disabled={busy || Boolean(pendingFileName)}
            onClick={() => void history.refresh()}
          >
            Refresh
          </button>
        </div>

        {history.error && (
          <div className="run-history-notice error" role="alert">
            <strong>History unavailable</strong>
            <span>{history.error}</span>
          </div>
        )}

        {openError && (
          <div className="run-history-notice error" role="alert">
            <strong>Could not open that run</strong>
            <span>{openError}</span>
          </div>
        )}

        {history.largeHistory && (
          <div className="run-history-notice" role="status">
            <strong>Large project history</strong>
            <span>{history.artifactCount.toLocaleString()} immutable artifacts are loaded only when you refresh. Nothing was deleted.</span>
          </div>
        )}

        {!busy && !history.error && history.entries.length === 0 && (
          <div className="run-history-empty">
            <span aria-hidden="true">↗</span>
            <h3>No saved evidence yet</h3>
            <p>
              Runs and repeated experiments for this project appear here.
            </p>
          </div>
        )}

        <div className="run-history-list">
          {history.entries.map((entry) => {
            if (entry.kind === "experiment") {
              const item = entry.item;
              const selected = item.experimentId === selectedExperimentId;
              const pending = item.planFileName === pendingFileName;
              return (
                <button
                  aria-current={selected ? "true" : undefined}
                  aria-busy={pending ? "true" : undefined}
                  className={selected ? "run-history-item experiment selected" : "run-history-item experiment"}
                  disabled={Boolean(pendingFileName)}
                  key={item.planFileName}
                  type="button"
                  onClick={() => void selectExperiment(item)}
                >
                  <span className="run-history-item-heading">
                    <strong>{item.kind === "evaluation" ? "Evaluation" : "Repeated experiment"} · {item.model}</strong>
                    <span className={`run-history-status ${item.lifecycle}`}>
                      {pending ? "opening" : item.lifecycle}
                    </span>
                  </span>
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                  <span>{item.requested} {item.kind === "evaluation" ? "planned runs" : "repetitions"} · {experimentMeta(item)}</span>
                  <code>{item.planFileName}</code>
                </button>
              );
            }
            const item = entry.item;
            const selected = item.summary.runId === selectedRunId;
            const pending = item.fileName === pendingFileName;
            return (
              <button
                aria-current={selected ? "true" : undefined}
                aria-busy={pending ? "true" : undefined}
                className={
                  selected ? "run-history-item selected" : "run-history-item"
                }
                disabled={Boolean(pendingFileName)}
                key={item.fileName}
                type="button"
                onClick={() => void selectItem(item)}
              >
                <span className="run-history-item-heading">
                  <strong>{item.summary.model}</strong>
                  <span className={`run-history-status ${item.summary.status}`}>
                    {pending ? "opening" : item.summary.status}
                  </span>
                </span>
                <time dateTime={item.summary.startedAt}>
                  {formatDate(item.summary.startedAt)}
                </time>
                <span>{historyMeta(item)}</span>
                <code>{item.fileName}</code>
              </button>
            );
          })}
        </div>

        {history.failures.length > 0 && (
          <details className="run-history-failures">
            <summary>
              {history.failures.length} invalid history{" "}
              {history.failures.length === 1 ? "artifact was" : "artifacts were"}{" "}
              skipped
            </summary>
            {history.failures.map((failure) => (
              <p key={failure.fileName}>
                <code>{failure.fileName}</code>
                <span>{failure.message}</span>
              </p>
            ))}
          </details>
        )}
      </div>
    </SideDrawer>
  );
}
