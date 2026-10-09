"use client";

import type { ReactNode } from "react";
import type { ExperimentCellId, RunId, RunTrace } from "../../packages/core/src/run-kernel";
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
  type RunsCurrentBatch,
  type RunsCurrentRun,
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
  browser: {
    projectId?: string;
    currentRun?: RunsCurrentRun;
    currentBatch?: RunsCurrentBatch;
    history?: ProjectRunHistoryState;
    selection?: RunsSelection;
    filter: RunsHistoryFilter;
    scrollTop: number;
    experimentsLockedReason?: string;
    /** Evidence for an explicitly selected ordinary run, current or saved. */
    selectedEvidence?: ReactNode;
    loading?: boolean;
    error?: string;
    onFilterChange(filter: RunsHistoryFilter): void;
    onScrollTopChange(scrollTop: number): void;
    onSelectCurrent(runId: RunId): void;
    onSelectCurrentBatch(): void;
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
  detail?: {
    content: ReactNode;
    batchLabel: string;
    memberLabel: string;
  };
  /** Where an empty Runs mode sends someone who has nothing to look at yet. */
  onStartSomething(): void;
}

/**
 * Where results are read: a list of the session's and the project folder's
 * evidence beside whatever is selected. Evaluation results, repeated-experiment
 * results, and baseline comparison are wide tabular things, so each gets the
 * main area to itself, with a selected member beside it.
 */
export function RunsMode({
  browser,
  comparison,
  evaluation,
  repeated,
  detail,
  onStartSomething,
}: RunsModeProps) {
  // A live or reopened execution outranks a loaded comparison, because it is
  // the thing the user most recently caused. An explicitly selected ordinary
  // run outranks both; see `browserDetail`.
  const selectedRunId =
    evaluation?.execution.selectedRunId ?? repeated?.execution.selectedRunId ?? null;
  const showDetail = Boolean(detail && selectedRunId);
  const returnToBatch = evaluation?.onReturnToList ?? repeated?.onReturnToList;

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

  const browserDetail = browser.selectedEvidence ? (
    <section aria-label="Selected run evidence" className={styles.results}>
      {browser.selectedEvidence}
    </section>
  ) : browser.loading ? (
    <div className={styles.empty} role="status">Loading saved evidence…</div>
  ) : browser.error ? (
    <div className={styles.empty} role="alert">
      <PaneEmptyState eyebrow="Runs" heading="Evidence unavailable" detail={browser.error} />
    </div>
  ) : null;

  return (
    <div className={`${styles.mode} ${styles.withBrowser}`}>
      <RunsEvidenceList
        {...(browser.projectId ? { projectId: browser.projectId } : {})}
        {...(browser.currentRun ? { currentRun: browser.currentRun } : {})}
        {...(browser.currentBatch ? { currentBatch: browser.currentBatch } : {})}
        {...(browser.history ? { history: browser.history } : {})}
        {...(browser.selection ? { selection: browser.selection } : {})}
        {...(browser.experimentsLockedReason ? { experimentsLockedReason: browser.experimentsLockedReason } : {})}
        filter={browser.filter}
        scrollTop={browser.scrollTop}
        onFilterChange={browser.onFilterChange}
        onScrollTopChange={browser.onScrollTopChange}
        onSelectCurrent={browser.onSelectCurrent}
        onSelectCurrentBatch={browser.onSelectCurrentBatch}
        onSelectRun={browser.onSelectRun}
        onSelectExperiment={browser.onSelectExperiment}
      />
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
              detail="Run a request in Compose and its result appears here. Choose saved evidence from the list, or start an evaluation."
              action={{ label: "Go to Evaluations", onClick: onStartSomething }}
            />
          </div>
        ))}
        {showDetail && !browserDetail && detail && (
          <section aria-label="Selected run" className={styles.detail}>
            <nav aria-label="Breadcrumb" className={styles.breadcrumb}>
              <ol>
                <li>Runs</li>
                <li>
                  <span aria-hidden="true">/</span>
                  {returnToBatch ? (
                    <button className="text-button" type="button" onClick={returnToBatch}>
                      {detail.batchLabel}
                    </button>
                  ) : (
                    detail.batchLabel
                  )}
                </li>
                <li>
                  <span aria-hidden="true">/</span>
                  <span aria-current="page">{detail.memberLabel}</span>
                </li>
              </ol>
            </nav>
            {detail.content}
          </section>
        )}
      </div>
    </div>
  );
}
