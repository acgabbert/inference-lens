import { evaluationExperimentAggregate } from "../../packages/core/src/experiment.ts";
import {
  evaluationPassSummary,
  evaluationPassTone,
} from "../evaluations/evaluation-history-format.client.ts";
import type { EvaluationPassTone } from "../evaluations/evaluation-history-format.client.ts";
import type { EvaluationExecution } from "../evaluations/use-evaluation-execution-session.client.ts";
import type { ModeIndicator, ModeIndicatorTone } from "../modes/app-mode.ts";
import type { ToastAction, ToastRequest } from "../notifications/toast-queue.client.ts";

/**
 * A batch that finished in this session and has not been announced yet.
 *
 * Held as a small queue rather than announced from the session hook directly:
 * the hook reports completion in the same tick it stores the result, so the
 * pass rate the toast wants is not readable until React has committed. The
 * effect that drains this runs after that commit and derives the summary from
 * the same execution state the Runs indicator reads, which is what keeps the
 * two from disagreeing about the same batch.
 */
export type FinishedBatch =
  | { kind: "evaluation"; experimentId: string }
  | { kind: "repeated"; experimentId: string; repetitions: number };

/** The part of an evaluation execution its outcome is derived from. */
export type FinishedEvaluation = Pick<EvaluationExecution, "plan" | "result" | "states" | "error">;

/**
 * `pending` and `unscored` both mean the batch decided nothing — interrupted,
 * or an aggregate that could not be derived. Neither is a failure, so neither
 * gets a failure colour on the strip.
 */
const indicatorToneForPassTone: Record<EvaluationPassTone, ModeIndicatorTone> = {
  passed: "passed",
  partial: "partial",
  failed: "failed",
  pending: "neutral",
  unscored: "neutral",
};

const UNREAD: ModeIndicator = { tone: "neutral", label: "finished, not yet viewed" };

/**
 * What the Runs dot says. A running batch outranks an unread one because it
 * is the thing still changing; an unread evaluation is coloured by its own
 * pass rate, and anything that decided nothing — an interrupted batch, a
 * repeated experiment, a comparison — stays neutral rather than borrowing a
 * verdict it does not have.
 */
export function runsIndicator(input: {
  running: boolean;
  unread: boolean;
  evaluation?: FinishedEvaluation;
}): ModeIndicator | undefined {
  if (input.running) return { tone: "running", label: "running" };
  if (!input.unread) return undefined;
  const { evaluation } = input;
  if (evaluation && !evaluation.error) {
    try {
      const score = evaluationExperimentAggregate(
        evaluation.plan,
        evaluation.result,
        evaluation.states,
      );
      const active = score.variants[0];
      return active ? {
        tone: indicatorToneForPassTone[evaluationPassTone(active)],
        label: score.variants.length === 1
          ? `finished, ${evaluationPassSummary(active)}, not yet viewed`
          : `finished, ${active.variant.name}: ${evaluationPassSummary(active)}, not yet viewed`,
      } : UNREAD;
    } catch {
      // An aggregate that cannot be derived is not a failed batch. The dot
      // says there is something to read and lets the workspace explain it.
      return UNREAD;
    }
  }
  return UNREAD;
}

/**
 * The completion toast for one finished batch. `evaluation` is the open
 * evaluation execution, read for the pass rate only when it is still the batch
 * being announced.
 */
export function finishedBatchToast(
  batch: FinishedBatch,
  evaluation: FinishedEvaluation | undefined,
  viewResults: ToastAction,
): ToastRequest {
  if (batch.kind === "repeated") {
    return {
      key: `batch-finished:${batch.experimentId}`,
      title: "Repeated experiment finished",
      detail: `${batch.repetitions} ${batch.repetitions === 1 ? "repetition" : "repetitions"} completed.`,
      action: viewResults,
      durableHome: "the Runs mode indicator, until the results are opened",
    };
  }
  let detail = "Every selected case has a verdict.";
  if (evaluation?.plan.experimentId === batch.experimentId) {
    try {
      const assessment = evaluationExperimentAggregate(evaluation.plan, evaluation.result, evaluation.states);
      detail = assessment.variants.length
        ? `${assessment.variants.map((variant) => `${variant.variant.name}: ${evaluationPassSummary(variant)}`).join(" · ")}.`
        : detail;
    } catch {
      // An aggregate that cannot be derived is not a failed batch. The toast
      // says there is something to read and lets the workspace explain it.
    }
  }
  return {
    key: `batch-finished:${batch.experimentId}`,
    title: "Evaluation finished",
    detail,
    action: viewResults,
    durableHome: "the Runs mode indicator, which also carries the pass rate",
  };
}
