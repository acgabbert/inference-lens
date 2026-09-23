"use client";

import type { ExperimentId, RunId, RunState } from "../../packages/core/src/run-kernel";
import type { ProjectHistoryEntry } from "../../packages/core/src/experiment-history";
import type {
  ProjectExperimentHistoryItem,
  ProjectRunHistoryItem,
  ProjectRunHistoryState,
} from "../use-project-run-history.client";
import { formatDuration, formatTokens } from "../run-metrics-format.client";
import {
  evaluationPassSummary,
  evaluationPassTone,
} from "../evaluations/evaluation-history-format.client";

export type RunsHistoryFilter = "all" | "runs" | "repeated" | "evaluations";

export type RunsSelection =
  | { kind: "current-run"; runId: RunId }
  | { kind: "saved-run"; projectId: string; runId: RunId; fileName: string }
  | { kind: "experiment"; projectId: string; experimentId: ExperimentId };

const filterLabels: Record<RunsHistoryFilter, string> = {
  all: "All",
  runs: "Runs",
  repeated: "Repeated",
  evaluations: "Evaluations",
};

function matchesFilter(entry: ProjectHistoryEntry, filter: RunsHistoryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "runs") return entry.kind === "run";
  return entry.kind === "experiment" &&
    entry.item.kind === (filter === "repeated" ? "repeated-request" : "evaluation");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function runMeta(item: ProjectRunHistoryItem): string {
  const { summary } = item;
  return [
    formatDuration(summary.durationMs),
    `${formatTokens(summary.usage.totalTokens)} tokens`,
    `${summary.turnCount} ${summary.turnCount === 1 ? "turn" : "turns"}`,
  ].join(" · ");
}

function experimentMeta(item: ProjectExperimentHistoryItem): string {
  if (item.kind === "evaluation") {
    const cases = item.evaluation.variants[0]?.caseCounts.total;
    return [
      ...(cases === undefined ? [] : [`${cases} ${cases === 1 ? "case" : "cases"}`]),
      `${item.requested} planned ${item.requested === 1 ? "run" : "runs"}`,
    ].join(" · ");
  }
  return `${item.requested} repetitions · ${item.completed} completed`;
}

function selectionKey(selection: RunsSelection | undefined): string | undefined {
  if (!selection) return undefined;
  if (selection.kind === "current-run") return `current:${selection.runId}`;
  if (selection.kind === "saved-run") return `run:${selection.runId}`;
  return `experiment:${selection.experimentId}`;
}

interface RunsEvidenceListProps {
  projectId?: string;
  currentRun?: {
    runId: RunId;
    model: string;
    status: RunState["status"]["kind"];
    startedAt?: string;
  };
  history?: ProjectRunHistoryState;
  selection?: RunsSelection;
  filter: RunsHistoryFilter;
  scrollTop: number;
  onFilterChange(filter: RunsHistoryFilter): void;
  onScrollTopChange(scrollTop: number): void;
  onSelectCurrent(runId: RunId): void;
  onSelectRun(item: ProjectRunHistoryItem): void;
  onSelectExperiment(item: ProjectExperimentHistoryItem): void;
}

export function RunsEvidenceList({
  projectId,
  currentRun,
  history,
  selection,
  filter,
  scrollTop,
  onFilterChange,
  onScrollTopChange,
  onSelectCurrent,
  onSelectRun,
  onSelectExperiment,
}: RunsEvidenceListProps) {
  const selected = selectionKey(selection);
  const currentSaved = Boolean(
    currentRun && history?.items.some((item) => item.summary.runId === currentRun.runId),
  );
  const entries = (history?.entries ?? []).filter((entry) => {
    if (!matchesFilter(entry, filter)) return false;
    return entry.kind !== "run" || entry.item.summary.runId !== currentRun?.runId;
  });
  const showCurrent = Boolean(currentRun && (filter === "all" || filter === "runs"));
  const busy = history?.status === "idle" || history?.status === "loading";

  return (
    <nav aria-label="Run evidence" className="runs-evidence-list">
      <div className="run-history-toolbar">
        <span>{busy ? "Loading saved evidence…" : `${entries.length + (showCurrent ? 1 : 0)} available`}</span>
        {history && (
          <button className="text-button" disabled={busy} type="button" onClick={() => void history.refresh()}>
            Refresh
          </button>
        )}
      </div>
      <div className="run-history-filter" role="group" aria-label="Filter run evidence">
        {(Object.keys(filterLabels) as RunsHistoryFilter[]).map((option) => (
          <button
            aria-pressed={filter === option}
            className={filter === option ? "selected" : undefined}
            key={option}
            type="button"
            onClick={() => onFilterChange(option)}
          >
            {filterLabels[option]}
          </button>
        ))}
      </div>
      {history?.error && <p className="run-history-notice error" role="alert">{history.error}</p>}
      <div
        className="runs-evidence-items"
        ref={(node) => {
          if (node && node.scrollTop !== scrollTop) node.scrollTop = scrollTop;
        }}
        onScroll={(event) => onScrollTopChange(event.currentTarget.scrollTop)}
      >
        {showCurrent && currentRun && (
          <button
            aria-current={selected === `current:${currentRun.runId}` ? "true" : undefined}
            className={selected === `current:${currentRun.runId}` ? "runs-evidence-item selected" : "runs-evidence-item"}
            type="button"
            onClick={() => onSelectCurrent(currentRun.runId)}
          >
            <span className="runs-evidence-item-heading">
              <strong>{currentRun.model}</strong>
              <span className={`run-history-status ${currentRun.status}`}>{currentRun.status}</span>
            </span>
            {currentRun.startedAt && <time dateTime={currentRun.startedAt}>{formatDate(currentRun.startedAt)}</time>}
            <span>{currentSaved ? "Current session · Saved to folder" : "Current session"}</span>
          </button>
        )}
        {entries.map((entry) => {
          if (entry.kind === "run") {
            const item = entry.item;
            const key = `run:${item.summary.runId}`;
            return (
              <button
                aria-current={selected === key ? "true" : undefined}
                className={selected === key ? "runs-evidence-item selected" : "runs-evidence-item"}
                key={item.fileName}
                type="button"
                onClick={() => onSelectRun(item)}
              >
                <span className="runs-evidence-item-heading">
                  <strong>{item.summary.model}</strong>
                  <span className={`run-history-status ${item.summary.status}`}>{item.summary.status}</span>
                </span>
                <time dateTime={item.summary.startedAt}>{formatDate(item.summary.startedAt)}</time>
                <span>{runMeta(item)}</span>
                <span>Saved to folder</span>
              </button>
            );
          }
          const item = entry.item;
          const key = `experiment:${item.experimentId}`;
          return (
            <button
              aria-current={selected === key ? "true" : undefined}
              className={selected === key ? "runs-evidence-item experiment selected" : "runs-evidence-item experiment"}
              key={item.planFileName}
              type="button"
              onClick={() => onSelectExperiment(item)}
            >
              <span className="runs-evidence-item-heading">
                <strong>{item.kind === "evaluation" ? `Evaluation · ${item.evaluation.suiteName}` : `Repeated experiment · ${item.model}`}</strong>
                {item.kind === "evaluation" && (
                  <span className={`evaluation-pass ${evaluationPassTone(item.evaluation.variants[0])}`}>
                    {evaluationPassSummary(item.evaluation.variants[0])}
                  </span>
                )}
                <span className={`run-history-status ${item.lifecycle}`}>{item.lifecycle}</span>
              </span>
              <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
              <span>{experimentMeta(item)}</span>
              <span>Saved to folder</span>
            </button>
          );
        })}
        {!busy && !history?.error && !showCurrent && entries.length === 0 && (
          <div className="run-history-empty">
            <h3>No evidence here</h3>
            <p>{projectId ? "Run a request or choose another filter." : "Open a project folder or run a request."}</p>
          </div>
        )}
      </div>
    </nav>
  );
}
