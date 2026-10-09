"use client";

import type { ExperimentId, ProviderProtocol, RunId, RunState } from "../../packages/core/src/run-kernel";
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
import { protocolName } from "./runs-evidence-labels";

export type RunsHistoryFilter = "all" | "runs" | "repeated" | "evaluations";

/**
 * What the user chose to look at. `current-batch` stands for whichever batch
 * the session has open, because a batch the user just started has no
 * experiment ID until its plan is frozen.
 */
export type RunsSelection =
  | { kind: "current-run"; runId: RunId }
  | { kind: "current-batch" }
  | { kind: "saved-run"; projectId: string; runId: RunId; fileName: string }
  | { kind: "experiment"; projectId: string; experimentId: ExperimentId };

/** The one ordinary run this session holds in memory. */
export interface RunsCurrentRun {
  runId: RunId;
  model: string;
  protocol: ProviderProtocol;
  requestExcerpt?: string;
  status: RunState["status"]["kind"];
  startedAt?: string;
  /** Where it lives; see `currentRunStorageLabel`. */
  storageLabel: string;
  saved: boolean;
}

/** The one batch this session holds in memory, live or reopened. */
export interface RunsCurrentBatch {
  experimentId: ExperimentId;
  kind: "repeated-request" | "evaluation";
  title: string;
  status: string;
  detail: string;
  storageLabel: string;
}

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

function batchMatchesFilter(batch: RunsCurrentBatch, filter: RunsHistoryFilter): boolean {
  return filter === "all" ||
    (filter === "repeated" && batch.kind === "repeated-request") ||
    (filter === "evaluations" && batch.kind === "evaluation");
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
    ...(summary.retryCount > 0
      ? [`${summary.retryCount} ${summary.retryCount === 1 ? "retry" : "retries"}`]
      : []),
  ].join(" · ");
}

function runTarget(model: string, protocol: ProviderProtocol | undefined): string {
  const name = protocolName(protocol);
  return name ? `${model} · ${name}` : model;
}

function experimentMeta(item: ProjectExperimentHistoryItem): string {
  // An evaluation's outcome is its strict pass rate, carried by the row's own
  // badge. Reporting "2 completed" for a batch whose checks failed would
  // describe the runs and hide the result, so run-status counts stay with
  // repeated experiments only.
  if (item.kind === "evaluation") {
    const cases = item.evaluation.variants[0]?.caseCounts.total;
    const models = item.evaluation.variants.map((variant) => variant.model);
    return [
      ...(cases === undefined ? [] : [`${cases} ${cases === 1 ? "case" : "cases"}`]),
      `${item.requested} planned ${item.requested === 1 ? "run" : "runs"}`,
      models.length > 0 ? models.join(", ") : "unscored",
    ].join(" · ");
  }
  const outcomes = [
    item.completed ? `${item.completed} completed` : undefined,
    item.failed ? `${item.failed} failed` : undefined,
    item.cancelled ? `${item.cancelled} cancelled` : undefined,
    item.notRun ? `${item.notRun} not run` : undefined,
    item.missingTrace ? `${item.missingTrace} missing` : undefined,
  ].filter(Boolean);
  return `${item.requested} repetitions · ${
    outcomes.length > 0 ? outcomes.join(" · ") : `${item.requested} planned`
  }`;
}

function evaluationBadge(item: Extract<ProjectExperimentHistoryItem, { kind: "evaluation" }>): string {
  const { variants } = item.evaluation;
  if (variants.length === 0) return evaluationPassSummary(undefined);
  if (variants.length === 1) return evaluationPassSummary(variants[0]);
  return `${variants.length} configurations`;
}

function itemClass(selected: boolean, experiment = false): string {
  return ["runs-evidence-item", experiment ? "experiment" : "", selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
}

interface RunsEvidenceListProps {
  projectId?: string;
  currentRun?: RunsCurrentRun;
  currentBatch?: RunsCurrentBatch;
  history?: ProjectRunHistoryState;
  selection?: RunsSelection;
  filter: RunsHistoryFilter;
  scrollTop: number;
  /**
   * Why other batches cannot be opened right now. Opening one replaces the
   * session's batch, which would strand a batch that is still running.
   */
  experimentsLockedReason?: string;
  onFilterChange(filter: RunsHistoryFilter): void;
  onScrollTopChange(scrollTop: number): void;
  onSelectCurrent(runId: RunId): void;
  onSelectCurrentBatch(): void;
  onSelectRun(item: ProjectRunHistoryItem): void;
  onSelectExperiment(item: ProjectExperimentHistoryItem): void;
}

/**
 * Every piece of evidence Runs can show, newest first: the session's current
 * run and batch, then what the project folder holds. A run that is both in
 * memory and on disk appears once, under its stable run or experiment ID.
 */
export function RunsEvidenceList({
  projectId,
  currentRun,
  currentBatch,
  history,
  selection,
  filter,
  scrollTop,
  experimentsLockedReason,
  onFilterChange,
  onScrollTopChange,
  onSelectCurrent,
  onSelectCurrentBatch,
  onSelectRun,
  onSelectExperiment,
}: RunsEvidenceListProps) {
  const selectedRunId =
    selection?.kind === "current-run" || selection?.kind === "saved-run"
      ? selection.runId
      : undefined;
  const selectedExperimentId =
    selection?.kind === "experiment"
      ? selection.experimentId
      : selection?.kind === "current-batch" || !selection
        ? currentBatch?.experimentId
        : undefined;
  const allEntries = history?.entries ?? [];
  const batchListed = Boolean(
    currentBatch &&
      allEntries.some(
        (entry) => entry.kind === "experiment" && entry.item.experimentId === currentBatch.experimentId,
      ),
  );
  const entries = allEntries.filter((entry) => {
    if (!matchesFilter(entry, filter)) return false;
    return entry.kind !== "run" || entry.item.summary.runId !== currentRun?.runId;
  });
  const showCurrent = Boolean(currentRun && (filter === "all" || filter === "runs"));
  const showBatch = Boolean(currentBatch && !batchListed && batchMatchesFilter(currentBatch, filter));
  const shown = entries.length + (showCurrent ? 1 : 0) + (showBatch ? 1 : 0);
  // `idle` means the listing has not been attempted, which must not render as
  // an empty project.
  const busy = history?.status === "idle" || history?.status === "loading";

  return (
    <nav aria-label="Run evidence" className="runs-evidence-list">
      <div className="run-history-toolbar">
        <span>{busy ? "Loading saved evidence…" : `${shown} ${shown === 1 ? "entry" : "entries"}`}</span>
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
      {history?.error && (
        <div className="run-history-notice error" role="alert">
          <strong>History unavailable</strong>
          <span>{history.error}</span>
        </div>
      )}
      {history?.largeHistory && (
        <div className="run-history-notice" role="status">
          <strong>Large project history</strong>
          <span>{history.artifactCount.toLocaleString()} immutable artifacts are loaded only when you refresh. Nothing was deleted.</span>
        </div>
      )}
      <div
        className="runs-evidence-items"
        ref={(node) => {
          if (node && node.scrollTop !== scrollTop) node.scrollTop = scrollTop;
        }}
        onScroll={(event) => onScrollTopChange(event.currentTarget.scrollTop)}
      >
        {showBatch && currentBatch && (
          <button
            aria-current={selectedExperimentId === currentBatch.experimentId ? "true" : undefined}
            className={itemClass(selectedExperimentId === currentBatch.experimentId, true)}
            type="button"
            onClick={onSelectCurrentBatch}
          >
            <span className="runs-evidence-item-heading">
              <strong>{currentBatch.title}</strong>
              <span className={`run-history-status ${currentBatch.status}`}>{currentBatch.status}</span>
            </span>
            <span>{currentBatch.detail}</span>
            <span className="runs-evidence-storage">{currentBatch.storageLabel}</span>
          </button>
        )}
        {showCurrent && currentRun && (
          <button
            aria-current={selectedRunId === currentRun.runId ? "true" : undefined}
            className={itemClass(selectedRunId === currentRun.runId)}
            type="button"
            onClick={() => onSelectCurrent(currentRun.runId)}
          >
            <span className="runs-evidence-item-heading">
              <strong className="runs-evidence-excerpt">{currentRun.requestExcerpt ?? currentRun.model}</strong>
              <span className={`run-history-status ${currentRun.status}`}>{currentRun.status}</span>
            </span>
            <span>{runTarget(currentRun.model, currentRun.protocol)}</span>
            {currentRun.startedAt && <time dateTime={currentRun.startedAt}>{formatDate(currentRun.startedAt)}</time>}
            <span className={currentRun.saved ? "runs-evidence-storage" : "runs-evidence-storage unsaved"}>
              {currentRun.storageLabel}
            </span>
          </button>
        )}
        {entries.map((entry) => {
          if (entry.kind === "run") {
            const item = entry.item;
            const selected = selectedRunId === item.summary.runId;
            return (
              <button
                aria-current={selected ? "true" : undefined}
                className={itemClass(selected)}
                key={item.fileName}
                title={item.fileName}
                type="button"
                onClick={() => onSelectRun(item)}
              >
                <span className="runs-evidence-item-heading">
                  <strong className="runs-evidence-excerpt">{item.summary.requestExcerpt ?? item.summary.model}</strong>
                  <span className={`run-history-status ${item.summary.status}`}>{item.summary.status}</span>
                </span>
                <span>{runTarget(item.summary.model, item.summary.protocol)}</span>
                <time dateTime={item.summary.startedAt}>{formatDate(item.summary.startedAt)}</time>
                <span>{runMeta(item)}</span>
                <span className="runs-evidence-storage">Saved to folder</span>
              </button>
            );
          }
          const item = entry.item;
          const selected = selectedExperimentId === item.experimentId;
          const current = currentBatch?.experimentId === item.experimentId;
          const locked = Boolean(experimentsLockedReason) && !current;
          return (
            <button
              aria-current={selected ? "true" : undefined}
              className={itemClass(selected, true)}
              disabled={locked}
              key={item.planFileName}
              title={locked ? experimentsLockedReason : item.planFileName}
              type="button"
              onClick={() => (current ? onSelectCurrentBatch() : onSelectExperiment(item))}
            >
              <span className="runs-evidence-item-heading">
                <strong>{item.kind === "evaluation" ? `Evaluation · ${item.evaluation.suiteName}` : `Repeated experiment · ${item.model}`}</strong>
                {item.kind === "evaluation" && (
                  <span className={`evaluation-pass ${evaluationPassTone(item.evaluation.variants[0])}`}>
                    {evaluationBadge(item)}
                  </span>
                )}
                <span className={`run-history-status ${current && currentBatch ? currentBatch.status : item.lifecycle}`}>
                  {current && currentBatch ? currentBatch.status : item.lifecycle}
                </span>
              </span>
              <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
              <span>{experimentMeta(item)}</span>
              <span className="runs-evidence-storage">Saved to folder</span>
            </button>
          );
        })}
        {!busy && !history?.error && shown === 0 && (
          <div className="run-history-empty">
            {allEntries.length > 0 ? (
              <>
                <h3>Nothing matches this filter</h3>
                <p>
                  {allEntries.length} saved {allEntries.length === 1 ? "entry is" : "entries are"} hidden by the{" "}
                  {filterLabels[filter]} filter.
                </p>
              </>
            ) : (
              <>
                <h3>No evidence yet</h3>
                <p>
                  {history
                    ? "Runs, repeated experiments, and evaluations saved in this project folder appear here."
                    : projectId
                      ? "Run a request to see it here. Save the project to a folder to keep a browsable history."
                      : "Run a request to see it here."}
                </p>
              </>
            )}
          </div>
        )}
      </div>
      {history && history.failures.length > 0 && (
        <details className="run-history-failures">
          <summary>
            {history.failures.length} invalid history{" "}
            {history.failures.length === 1 ? "artifact was" : "artifacts were"} skipped
          </summary>
          {history.failures.map((failure) => (
            <p key={failure.fileName}>
              <code>{failure.fileName}</code>
              <span>{failure.message}</span>
            </p>
          ))}
        </details>
      )}
    </nav>
  );
}
