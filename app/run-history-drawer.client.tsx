"use client";

import type { RunId } from "../packages/core/src/run-kernel";
import type {
  ProjectRunHistoryItem,
  ProjectRunHistoryState,
} from "./use-project-run-history.client";
import {
  formatDuration,
  formatTokens,
} from "./run-metrics-format.client";
import { SideDrawer } from "./workbench-shell.client";

interface RunHistoryDrawerProps {
  open: boolean;
  projectName?: string;
  selectedRunId?: RunId;
  history: ProjectRunHistoryState;
  onClose(): void;
  onSelect(item: ProjectRunHistoryItem): void;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function historyMeta(item: ProjectRunHistoryItem): string {
  const { summary } = item;
  return [
    formatDuration(summary.durationMs),
    `${formatTokens(summary.usage.totalTokens)} tokens`,
    `${summary.turnCount} ${summary.turnCount === 1 ? "turn" : "turns"}`,
  ].join(" · ");
}

export function RunHistoryDrawer({
  open,
  projectName,
  selectedRunId,
  history,
  onClose,
  onSelect,
}: RunHistoryDrawerProps) {
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
            {history.loading
              ? "Loading…"
              : `${history.items.length} saved ${
                  history.items.length === 1 ? "run" : "runs"
                }`}
          </span>
          <button
            className="text-button"
            type="button"
            disabled={history.loading}
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

        {!history.loading && !history.error && history.items.length === 0 && (
          <div className="run-history-empty">
            <span aria-hidden="true">↗</span>
            <h3>No saved runs yet</h3>
            <p>Run a request in this project and its terminal trace will appear here.</p>
          </div>
        )}

        <div className="run-history-list">
          {history.items.map((item) => {
            const selected = item.summary.runId === selectedRunId;
            return (
              <button
                aria-current={selected ? "true" : undefined}
                className={selected ? "run-history-item selected" : "run-history-item"}
                key={item.summary.runId}
                type="button"
                onClick={() => onSelect(item)}
              >
                <span className="run-history-item-heading">
                  <strong>{item.summary.model}</strong>
                  <span className={`run-history-status ${item.summary.status}`}>
                    {item.summary.status}
                  </span>
                </span>
                <time dateTime={item.summary.startedAt}>
                  {formatDate(item.summary.startedAt)}
                </time>
                <span>{historyMeta(item)}</span>
                <code>{item.summary.runId}</code>
              </button>
            );
          })}
        </div>

        {history.failures.length > 0 && (
          <details className="run-history-failures">
            <summary>
              {history.failures.length} invalid{" "}
              {history.failures.length === 1 ? "trace was" : "traces were"} skipped
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
