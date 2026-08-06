import { DEFAULT_EXPERIMENT_TURN_CEILING } from "../../packages/core/src/turn-ceiling.ts";

export const LARGE_EVALUATION_BATCH_WARNING_THRESHOLD = 25;
export const MAX_EVALUATION_REPETITIONS = 100;
export const MAX_EVALUATION_PROVIDER_CALLS = 1_000;

export interface EvaluationBatchGuardrail {
  /** The floor: one provider call per planned cell. */
  plannedCalls: number;
  /**
   * The bound the thresholds are applied to. Equal to `plannedCalls` when the
   * suite exposes no tools, and `plannedCalls × turnCeiling` when it does,
   * because a tool-serving repetition may buy another turn up to its ceiling.
   */
  worstCaseCalls: number;
  warning?: string;
  error?: string;
}

export interface EvaluationBatchInput {
  selectedCases: number;
  repetitions: number;
  /** Absent or zero means no tools are exposed and a repetition is one call. */
  exposedToolCount?: number;
  /** The suite's authored ceiling; the shared default when it authored none. */
  turnCeiling?: number;
}

/** Reads a cell range as one string, collapsing to a single number at parity. */
export function evaluationCallRange(guardrail: EvaluationBatchGuardrail): string {
  return guardrail.worstCaseCalls === guardrail.plannedCalls
    ? guardrail.plannedCalls.toLocaleString()
    : `${guardrail.plannedCalls.toLocaleString()}–${guardrail.worstCaseCalls.toLocaleString()}`;
}

/**
 * Keeps paid-batch policy in one place for preflight, keyboard routing, and
 * confirmation. Values are diagnosed, never silently rewritten.
 *
 * The thresholds gate the worst case, not the floor. Before tools, one cell
 * meant exactly one provider call and the two were the same number; a suite
 * that serves tools is bounded only by its turn ceiling, and a maximum that
 * a confirmed batch can exceed by 5× is not a maximum.
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
  const plannedCalls = selectedCases * selectedVariants * repetitions;
  const ceiling = (tools.exposedToolCount ?? 0) > 0
    ? tools.turnCeiling ?? DEFAULT_EXPERIMENT_TURN_CEILING
    : 1;
  const worstCaseCalls = plannedCalls * ceiling;
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    return { plannedCalls, worstCaseCalls, error: "Repetitions must be a positive whole number." };
  }
  if (repetitions > MAX_EVALUATION_REPETITIONS) {
    return {
      plannedCalls,
      worstCaseCalls,
      error: `Evaluations support at most ${MAX_EVALUATION_REPETITIONS} repetitions. The value was not changed.`,
    };
  }
  if (worstCaseCalls > MAX_EVALUATION_PROVIDER_CALLS) {
    return {
      plannedCalls,
      worstCaseCalls,
      error: ceiling === 1
        ? `This evaluation would make ${worstCaseCalls.toLocaleString()} provider calls; the safety maximum is ${MAX_EVALUATION_PROVIDER_CALLS.toLocaleString()}. Reduce the selected cases or repetitions.`
        : `This evaluation exposes tools, so each of its ${plannedCalls.toLocaleString()} repetitions may spend up to ${ceiling} provider turns — ${worstCaseCalls.toLocaleString()} calls against a safety maximum of ${MAX_EVALUATION_PROVIDER_CALLS.toLocaleString()}. Reduce the cases, the repetitions, or the turn ceiling.`,
    };
  }
  return {
    plannedCalls,
    worstCaseCalls,
    ...(worstCaseCalls >= LARGE_EVALUATION_BATCH_WARNING_THRESHOLD
      ? {
          warning: ceiling === 1
            ? `Large evaluation batch: ${worstCaseCalls.toLocaleString()} provider calls will run sequentially.`
            : `Large evaluation batch: ${plannedCalls.toLocaleString()} repetitions will run sequentially, up to ${worstCaseCalls.toLocaleString()} provider calls if every one keeps calling tools.`,
        }
      : {}),
  };
}
