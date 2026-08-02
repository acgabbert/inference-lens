export const LARGE_EVALUATION_BATCH_WARNING_THRESHOLD = 25;
export const MAX_EVALUATION_REPETITIONS = 100;
export const MAX_EVALUATION_PROVIDER_CALLS = 1_000;

export interface EvaluationBatchGuardrail {
  plannedCalls: number;
  warning?: string;
  error?: string;
}

/**
 * Keeps paid-batch policy in one place for preflight, keyboard routing, and
 * confirmation. Values are diagnosed, never silently rewritten.
 */
export function evaluationBatchGuardrail(
  selectedCases: number,
  repetitions: number,
): EvaluationBatchGuardrail {
  const plannedCalls = selectedCases * repetitions;
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    return { plannedCalls, error: "Repetitions must be a positive whole number." };
  }
  if (repetitions > MAX_EVALUATION_REPETITIONS) {
    return {
      plannedCalls,
      error: `Evaluations support at most ${MAX_EVALUATION_REPETITIONS} repetitions. The value was not changed.`,
    };
  }
  if (plannedCalls > MAX_EVALUATION_PROVIDER_CALLS) {
    return {
      plannedCalls,
      error: `This evaluation would make ${plannedCalls.toLocaleString()} provider calls; the safety maximum is ${MAX_EVALUATION_PROVIDER_CALLS.toLocaleString()}. Reduce the selected cases or repetitions.`,
    };
  }
  return {
    plannedCalls,
    ...(plannedCalls >= LARGE_EVALUATION_BATCH_WARNING_THRESHOLD
      ? { warning: `Large evaluation batch: ${plannedCalls.toLocaleString()} provider calls will run sequentially.` }
      : {}),
  };
}
