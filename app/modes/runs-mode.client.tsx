"use client";

import type { ReactNode } from "react";
import type { ExperimentCellId, RunId, RunState, RunTrace } from "../../packages/core/src/run-kernel";
import { PaneEmptyState } from "../pane-empty-state.client";
import { EvaluationComparisonWorkspace } from "../evaluations/evaluation-comparison-workspace.client";
import type { EvaluationComparisonReturnTarget } from "../evaluations/evaluation-comparison-workspace.client";
import type {
  LoadedComparisonSide,
  LoadedEvaluationComparison,
} from "../evaluations/use-evaluation-baselines.client";
import { EvaluationResultsWorkspace } from "../evaluations/evaluation-results-workspace.client";
import type { EvaluationExecution } from "../evaluations/use-evaluation-execution-session.client";
import type { EvaluationReassessmentHandle } from "../evaluations/use-evaluation-reassessment.client";
import { RepeatedExperimentWorkspace } from "../run/repeated-experiment-workspace.client";
import type { RepeatedExperimentExecution } from "../run/use-repeated-experiment-session.client";
import {
  RunsEvidenceList,
  type RunsHistoryFilter,
  type RunsSelection,
} from "../run/runs-evidence-list.client";
import type {
  ProjectExperimentHistoryItem,
  ProjectRunHistoryItem,
  ProjectRunHistoryState,
} from "../use-project-run-history.client";
import styles from "./runs-mode.module.css";

interface RunsModeProps {
  browser?: {
    projectId?: string;
    currentRun?: { runId: RunId; model: string; status: RunState["status"]["kind"]; startedAt?: string };
    history?: ProjectRunHistoryState;
    selection?: RunsSelection;
    filter: RunsHistoryFilter;
    scrollTop: number;
    selectedEvidence?: ReactNode;
    loading?: boolean;
    error?: string;
    onFilterChange(filter: RunsHistoryFilter): void;
    onScrollTopChange(scrollTop: number): void;
    onSelectCurrent(runId: RunId): void;
    onSelectRun(item: ProjectRunHistoryItem): void;
    onSelectExperiment(item: ProjectExperimentHistoryItem): void;
  };
  comparison?: {
    loaded: LoadedEvaluationComparison;
    onOpenTrace(side: LoadedComparisonSide, runId: RunId, target: EvaluationComparisonReturnTarget): void;
    onPromoteCandidate(trace: RunTrace, experimentCellId: ExperimentCellId): void;
    onDismiss(): void;
    returnTarget?: EvaluationComparisonReturnTarget;
    onReturnTargetChange(target?: EvaluationComparisonReturnTarget): void;
  };
  evaluation?: {
    execution: EvaluationExecution;
    onStop(): void;
    onOpenTrace(runId: RunId): void;
    onPromoteTrace?(trace: RunTrace, experimentCellId: string): void;
    onReturnToList(): void;
    onDismiss(): void;
    /** Which interpretation the results are read under; see the owner hook. */
    reassessment?: EvaluationReassessmentHandle;
  };
  repeated?: {
    execution: RepeatedExperimentExecution;
    onStop(): void;
    onOpenTrace(runId: RunId): void;
    onReturnToList(): void;
    onDismiss(): void;
  };
  /**
   * The single run selected out of a batch, composed by the route from the
   * response and trace features it already owns. Results browsing is this
   * mode's job; rendering one run's output is not, and duplicating it here
   * would give the app a second response surface.
   */
  detail?: ReactNode;
  /**
   * An ordinary request keeps rendering in Compose's response surface. Runs
   * owns the route back to it, not another copy of that surface.
   */
  currentRequest?: {
    onOpen(): void;
  };
  /** Saved evidence exists only for a folder-backed project. */
  savedHistory?: {
    disabled: boolean;
    disabledReason?: string;
    onOpen(): void;
  };
  /** Where an empty Runs mode sends someone who has nothing to look at yet. */
  onStartSomething(): void;
}

/**
 * Where results are read. Evaluation results, repeated-experiment results, and
 * baseline comparison are wide tabular things; each one used to claim whichever
 * half-pane happened to be free, which is what gave the response pane three
 * identities. Here they are the only thing on screen.
 */
export function RunsMode({
  browser,
  comparison,
  evaluation,
  repeated,
  detail,
  currentRequest,
  savedHistory,
  onStartSomething,
}: RunsModeProps) {
  // Mirrors the precedence the two-pane shell resolved by nesting: a live or
  // reopened execution outranks a loaded comparison, because it is the thing
  // the user most recently caused.
  const selectedRunId =
    evaluation?.execution.selectedRunId ?? repeated?.execution.selectedRunId ?? null;
  const showDetail = Boolean(detail && selectedRunId);

  const results = evaluation ? (
    <EvaluationResultsWorkspace
      execution={evaluation.execution}
      placement={showDetail ? "request" : "response"}
      onStop={evaluation.onStop}
      onOpenTrace={evaluation.onOpenTrace}
      onPromoteTrace={evaluation.onPromoteTrace}
      onReturnToEvaluation={evaluation.onReturnToList}
      onDismiss={evaluation.onDismiss}
      reassessment={evaluation.reassessment}
    />
  ) : repeated ? (
    <RepeatedExperimentWorkspace
      execution={repeated.execution}
      placement={showDetail ? "request" : "response"}
      onStop={repeated.onStop}
      onOpenTrace={repeated.onOpenTrace}
      onReturnToRequest={repeated.onReturnToList}
      onDismiss={repeated.onDismiss}
    />
  ) : comparison ? (
    <EvaluationComparisonWorkspace
      loaded={comparison.loaded}
      onOpenTrace={comparison.onOpenTrace}
      onPromoteCandidate={comparison.onPromoteCandidate}
      onDismiss={comparison.onDismiss}
      returnTarget={comparison.returnTarget}
      onReturnTargetChange={comparison.onReturnTargetChange}
    />
  ) : null;

  const browserDetail = browser?.selectedEvidence ? (
    <section aria-label="Selected run evidence" className={styles.results}>
      {browser.selectedEvidence}
    </section>
  ) : browser?.loading ? (
    <div className={styles.empty} role="status">Loading saved evidence…</div>
  ) : browser?.error ? (
    <div className={styles.empty} role="alert">
      <PaneEmptyState eyebrow="Runs" heading="Evidence unavailable" detail={browser.error} />
    </div>
  ) : null;

  if (!results && !browser) {
    return (
      <div className={styles.mode}>
        <div className={styles.empty}>
          <PaneEmptyState
            eyebrow="Runs"
            heading={currentRequest ? "Current request result" : "No results open"}
            detail={
              currentRequest
                ? "The latest ordinary request is still available in Compose."
                : "Ordinary request results appear here after a run. You can also browse saved project evidence or start an evaluation."
            }
            {...(currentRequest
              ? {
                  action: {
                    label: "View current response",
                    onClick: currentRequest.onOpen,
                  },
                }
              : {})}
          />
          <nav aria-label="Run destinations" className={styles.destinations}>
            {savedHistory ? (
              <div className={styles.destination}>
                <button
                  className="button secondary"
                  disabled={savedHistory.disabled}
                  title={savedHistory.disabledReason}
                  type="button"
                  onClick={savedHistory.onOpen}
                >
                  Open saved run history
                </button>
                <small>
                  Browse ordinary runs, repeated experiments, and evaluations saved in this project folder.
                </small>
              </div>
            ) : (
              <p className={styles.historyNote}>
                Save this project to a folder to build a browsable run history.
              </p>
            )}
            <div className={styles.destination}>
              <button className="button secondary" type="button" onClick={onStartSomething}>
                Go to Evaluations
              </button>
              <small>Start a batch or open a comparison in Runs.</small>
            </div>
          </nav>
        </div>
      </div>
    );
  }

  return (
    <div className={browser ? `${styles.mode} ${styles.withBrowser}` : styles.mode}>
      {browser && (
        <RunsEvidenceList
          {...(browser.projectId ? { projectId: browser.projectId } : {})}
          {...(browser.currentRun ? { currentRun: browser.currentRun } : {})}
          {...(browser.history ? { history: browser.history } : {})}
          {...(browser.selection ? { selection: browser.selection } : {})}
          filter={browser.filter}
          scrollTop={browser.scrollTop}
          onFilterChange={browser.onFilterChange}
          onScrollTopChange={browser.onScrollTopChange}
          onSelectCurrent={browser.onSelectCurrent}
          onSelectRun={browser.onSelectRun}
          onSelectExperiment={browser.onSelectExperiment}
        />
      )}
      <div className={showDetail && !browserDetail ? `${styles.content} ${styles.withDetail}` : styles.content}>
        {browserDetail ?? (results ? (
          <section aria-label="Run results" className={styles.results}>
            {results}
          </section>
        ) : (
          <div className={styles.empty}>
            <PaneEmptyState
              eyebrow="Runs"
              heading="No results open"
              detail="Ordinary request results appear here after a run. You can also browse saved project evidence or start an evaluation."
              action={{ label: "Go to Evaluations", onClick: onStartSomething }}
            />
          </div>
        ))}
        {showDetail && !browserDetail && (
          <section aria-label="Selected run" className={styles.detail}>
            {detail}
          </section>
        )}
      </div>
    </div>
  );
}
