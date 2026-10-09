import { evaluationBatchSize } from "../../packages/runner/src/evaluation-batch-limits.ts";
import type {
  EvaluationBatchInput,
  EvaluationBatchLimit,
} from "../../packages/runner/src/evaluation-batch-limits.ts";

export interface EvaluationBatchGuardrail {
  /** The floor: one provider call per planned cell. */
  plannedCalls: number;
  /** The bound the thresholds are applied to; see `evaluationBatchSize`. */
  worstCaseCalls: number;
  warning?: string;
  error?: string;
}

/** Reads a cell range as one string, collapsing to a single number at parity. */
export function evaluationCallRange(guardrail: EvaluationBatchGuardrail): string {
  return guardrail.worstCaseCalls === guardrail.plannedCalls
    ? guardrail.plannedCalls.toLocaleString()
    : `${guardrail.plannedCalls.toLocaleString()}–${guardrail.worstCaseCalls.toLocaleString()}`;
}

/** The app's wording for a refused batch. */
export function evaluationBatchLimitMessage(
  limit: EvaluationBatchLimit,
  size: { plannedCalls: number; worstCaseCalls: number; turnCeiling: number },
): string {
  switch (limit.kind) {
    case "repetitions_invalid":
      return "Repetitions must be a positive whole number.";
    case "repetitions_exceeded":
      return `Evaluations support at most ${limit.maximum} repetitions. The value was not changed.`;
    case "calls_exceeded":
      return size.turnCeiling === 1
        ? `This evaluation would make ${size.worstCaseCalls.toLocaleString()} provider calls; the safety maximum is ${limit.maximum.toLocaleString()}. Reduce the selected cases or repetitions.`
        : `This evaluation exposes tools, so each of its ${size.plannedCalls.toLocaleString()} repetitions may spend up to ${size.turnCeiling} provider turns — ${size.worstCaseCalls.toLocaleString()} calls against a safety maximum of ${limit.maximum.toLocaleString()}. Reduce the cases, the repetitions, or the turn ceiling.`;
  }
}

/**
 * The batch policy in `evaluationBatchSize`, phrased for preflight, keyboard
 * routing, and confirmation.
 */
export function evaluationBatchGuardrail(
  selectedCases: number,
  selectedVariantsOrRepetitions: number,
  repetitionsOrTools?: number | Pick<EvaluationBatchInput, "exposedToolCount" | "turnCeiling">,
  maybeTools: Pick<EvaluationBatchInput, "exposedToolCount" | "turnCeiling"> = {},
): EvaluationBatchGuardrail {
  // The two-argument form is retained only for callers outside evaluation
  // configuration selection; it means one selected configuration.
  const selectedVariants = typeof repetitionsOrTools === "number" ? selectedVariantsOrRepetitions : 1;
  const repetitions = typeof repetitionsOrTools === "number" ? repetitionsOrTools : selectedVariantsOrRepetitions;
  const tools = typeof repetitionsOrTools === "number" ? maybeTools : repetitionsOrTools ?? {};
  const size = evaluationBatchSize({ selectedCases, selectedVariants, repetitions, ...tools });
  const { plannedCalls, worstCaseCalls } = size;
  if (size.limit) return { plannedCalls, worstCaseCalls, error: evaluationBatchLimitMessage(size.limit, size) };
  return {
    plannedCalls,
    worstCaseCalls,
    ...(size.large
      ? {
          warning: size.turnCeiling === 1
            ? `Large evaluation batch: ${worstCaseCalls.toLocaleString()} provider calls will run sequentially.`
            : `Large evaluation batch: ${plannedCalls.toLocaleString()} repetitions will run sequentially, up to ${worstCaseCalls.toLocaleString()} provider calls if every one keeps calling tools.`,
        }
      : {}),
  };
}
