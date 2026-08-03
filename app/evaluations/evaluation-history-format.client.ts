"use client";

import type { EvaluationHistoryFacet } from "../../packages/core/src/experiment-history.ts";

export type EvaluationPassTone =
  | "passed"
  | "failed"
  | "partial"
  | "pending"
  | "unscored";

/**
 * How a saved evaluation reads in a list. Both the run-history drawer and the
 * suite editor's past-execution list render from here, so one artifact cannot
 * summarize differently depending on where it is listed.
 *
 * `unscored` means the aggregate could not be derived, not that nothing passed.
 * A missing pass rate and a zero pass rate are different facts.
 */
export function evaluationPassTone(facet?: EvaluationHistoryFacet): EvaluationPassTone {
  if (!facet) return "unscored";
  if (facet.passed) return "passed";
  // An interrupted batch decides nothing: no case passed, but none failed
  // either. Colouring that as a failure would report a fault the evidence does
  // not support, so it stays neutral and the row's lifecycle chip carries why.
  if (facet.caseCounts.failed === 0) return "pending";
  return facet.caseCounts.passed > 0 ? "partial" : "failed";
}

export function evaluationPassSummary(facet?: EvaluationHistoryFacet): string {
  if (!facet) return "not scored";
  const { passed, total } = facet.caseCounts;
  return `${passed}/${total} ${total === 1 ? "case" : "cases"} passed`;
}
