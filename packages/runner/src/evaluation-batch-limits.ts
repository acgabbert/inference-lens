import { DEFAULT_EXPERIMENT_TURN_CEILING } from "../../core/src/turn-ceiling.ts";

export const LARGE_EVALUATION_BATCH_WARNING_THRESHOLD = 25;
export const MAX_EVALUATION_REPETITIONS = 100;
export const MAX_EVALUATION_PROVIDER_CALLS = 1_000;

/** Why a batch is refused before it starts. Each host phrases it. */
export type EvaluationBatchLimit =
  | { kind: "repetitions_invalid" }
  | { kind: "repetitions_exceeded"; maximum: number }
  | { kind: "calls_exceeded"; maximum: number };

export interface EvaluationBatchSize {
  /** The floor: one provider call per planned cell. */
  plannedCalls: number;
  /**
   * The bound the thresholds are applied to. Equal to `plannedCalls` when the
   * suite exposes no tools, and `plannedCalls × turnCeiling` when it does,
   * because a tool-serving repetition may buy another turn up to its ceiling.
   */
  worstCaseCalls: number;
  /** Provider turns one repetition may spend: 1 when no tools are exposed. */
  turnCeiling: number;
  limit?: EvaluationBatchLimit;
  /** At or above the large-batch warning threshold, and not refused. */
  large: boolean;
}

export interface EvaluationBatchInput {
  selectedCases: number;
  selectedVariants: number;
  repetitions: number;
  /** Absent or zero means no tools are exposed and a repetition is one call. */
  exposedToolCount?: number;
  /** The suite's authored ceiling; the shared default when it authored none. */
  turnCeiling?: number;
}

/**
 * Paid-batch policy in one place for every host. Values are diagnosed, never
 * silently rewritten.
 *
 * The thresholds gate the worst case, not the floor. Before tools, one cell
 * meant exactly one provider call and the two were the same number; a suite
 * that serves tools is bounded only by its turn ceiling, and a maximum that
 * a confirmed batch can exceed by 5× is not a maximum.
 */
export function evaluationBatchSize(input: EvaluationBatchInput): EvaluationBatchSize {
  const { repetitions } = input;
  const plannedCalls = input.selectedCases * input.selectedVariants * repetitions;
  const turnCeiling = (input.exposedToolCount ?? 0) > 0
    ? input.turnCeiling ?? DEFAULT_EXPERIMENT_TURN_CEILING
    : 1;
  const worstCaseCalls = plannedCalls * turnCeiling;
  const size = { plannedCalls, worstCaseCalls, turnCeiling };
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    return { ...size, limit: { kind: "repetitions_invalid" }, large: false };
  }
  if (repetitions > MAX_EVALUATION_REPETITIONS) {
    return { ...size, limit: { kind: "repetitions_exceeded", maximum: MAX_EVALUATION_REPETITIONS }, large: false };
  }
  if (worstCaseCalls > MAX_EVALUATION_PROVIDER_CALLS) {
    return { ...size, limit: { kind: "calls_exceeded", maximum: MAX_EVALUATION_PROVIDER_CALLS }, large: false };
  }
  return { ...size, large: worstCaseCalls >= LARGE_EVALUATION_BATCH_WARNING_THRESHOLD };
}
