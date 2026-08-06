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
import { RepeatedExperimentWorkspace } from "../run/repeated-experiment-workspace.client";
import type { RepeatedExperimentExecution } from "../run/use-repeated-experiment-session.client";
import styles from "./runs-mode.module.css";

interface RunsModeProps {
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
  comparison,
  evaluation,
  repeated,
  detail,
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

  if (!results) {
    return (
      <div className={styles.mode}>
        <div className={styles.empty}>
          <PaneEmptyState
            eyebrow="Runs"
            heading="No results open"
            detail="Evaluation batches, repeated experiments, and baseline comparisons open here. Start one, or reopen a saved batch from run history."
            action={{ label: "Go to Evaluations", onClick: onStartSomething }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={showDetail ? `${styles.mode} ${styles.withDetail}` : styles.mode}>
      <section aria-label="Run results" className={styles.results}>
        {results}
      </section>
      {showDetail && (
        <section aria-label="Selected run" className={styles.detail}>
          {detail}
        </section>
      )}
    </div>
  );
}
