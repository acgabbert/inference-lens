"use client";

import { useState } from "react";

import type { RunId } from "../packages/core/src/run-kernel";
import type {
  ProjectExperimentHistoryItem,
  ProjectRunHistoryItem,
  ProjectRunHistoryState,
} from "./use-project-run-history.client";
import type { ProjectHistoryEntry } from "../packages/core/src/experiment-history.ts";
import type { ExperimentId } from "../packages/core/src/run-kernel/index.ts";
import { formatDuration, formatTokens } from "./run-metrics-format.client";
import {
  evaluationPassSummary,
  evaluationPassTone,
} from "./evaluations/evaluation-history-format.client";
import { SideDrawer } from "./workbench-shell.client";

type HistoryFilter = "all" | "runs" | "repeated" | "evaluations";

const filterLabels: Record<HistoryFilter, string> = {
  all: "All",
  runs: "Runs",
  repeated: "Repeated",
  evaluations: "Evaluations",
};

function matchesFilter(entry: ProjectHistoryEntry, filter: HistoryFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "runs":
      return entry.kind === "run";
    case "repeated":
      return entry.kind === "experiment" && entry.item.kind === "repeated-request";
    case "evaluations":
      return entry.kind === "experiment" && entry.item.kind === "evaluation";
  }
}

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
  // An evaluation's outcome is its strict pass rate, carried by the row's own
  // badge. Reporting "2 completed" for a batch whose checks failed would
  // describe the runs and hide the result, so run-status counts stay with
  // repeated experiments only.
  if (item.kind === "evaluation") {
    const cases = item.evaluation?.caseCounts.total;
    return [
      ...(cases === undefined ? [] : [`${cases} ${cases === 1 ? "case" : "cases"}`]),
      `${item.requested} planned ${item.requested === 1 ? "run" : "runs"}`,
      item.model,
    ].join(" · ");
  }
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
  const [filter, setFilter] = useState<HistoryFilter>("all");
  // `idle` means the listing has not been attempted, which must not render as
  // an empty project.
  const busy = history.status === "idle" || history.status === "loading";
  const visible = history.entries.filter((entry) => matchesFilter(entry, filter));

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
              : filter === "all"
                ? `${history.entries.length} saved ${
                    history.entries.length === 1 ? "entry" : "entries"
                  }`
                : `${visible.length} of ${history.entries.length} shown`}
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

        <div className="run-history-filter" role="group" aria-label="Filter saved evidence">
          {(Object.keys(filterLabels) as HistoryFilter[]).map((option) => (
            <button
              aria-pressed={option === filter}
              className={option === filter ? "selected" : undefined}
              key={option}
              type="button"
              onClick={() => setFilter(option)}
            >
              {filterLabels[option]}
            </button>
          ))}
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

        {!busy && !history.error && history.entries.length > 0 && visible.length === 0 && (
          <div className="run-history-empty">
            <span aria-hidden="true">↗</span>
            <h3>Nothing matches this filter</h3>
            <p>
              {history.entries.length} saved{" "}
              {history.entries.length === 1 ? "entry is" : "entries are"} hidden by the{" "}
              {filterLabels[filter]} filter.
            </p>
          </div>
        )}

        <div className="run-history-list">
          {visible.map((entry) => {
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
                    <strong>
                      {item.kind === "evaluation"
                        ? `Evaluation · ${item.evaluation?.suiteName ?? item.model}`
                        : `Repeated experiment · ${item.model}`}
                    </strong>
                    {item.kind === "evaluation" && (
                      <span className={`evaluation-pass ${evaluationPassTone(item.evaluation)}`}>
                        {evaluationPassSummary(item.evaluation)}
                      </span>
                    )}
                    <span className={`run-history-status ${item.lifecycle}`}>
                      {pending ? "opening" : item.lifecycle}
                    </span>
                  </span>
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                  <span>
                    {item.kind === "evaluation"
                      ? experimentMeta(item)
                      : `${item.requested} repetitions · ${experimentMeta(item)}`}
                  </span>
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
