import type { CheckKind, CheckOutcome } from "./checks.ts";
import type {
  EvaluationBakeoffAssessment,
  EvaluationRepetitionClassification,
} from "./experiment.ts";
import type {
  CheckId,
  EvaluationCaseId,
  EvaluationVariantId,
  ExperimentCellId,
} from "./run-kernel/types.ts";

/**
 * What changed between two readings of one execution.
 *
 * Both sides are derived by `evaluationParsedExperimentAggregate` from the same
 * plan and the same traces, differing only in the criteria argument. That is
 * what lets this be a pure diff of two aggregates rather than a second scoring
 * path: there is no way for the comparison to disagree with what the surface
 * will render, because it is comparing exactly what the surface renders.
 *
 * Only flips are listed. An unchanged outcome is the overwhelming majority of
 * any correction, and reporting it would bury the handful the author needs to
 * read before deciding whether to save.
 */

/** A check absent from one side's criteria has no outcome there, not a failing one. */
export type CheckOutcomeState = CheckOutcome["status"] | "absent";

export interface CheckOutcomeFlip {
  variantId: EvaluationVariantId;
  caseId: EvaluationCaseId;
  cellId: ExperimentCellId;
  repetition: number;
  checkId: CheckId;
  /** The side that has this check; the candidate's where both do. */
  kind: CheckKind;
  from: CheckOutcomeState;
  to: CheckOutcomeState;
}

export interface RepetitionClassificationFlip {
  variantId: EvaluationVariantId;
  caseId: EvaluationCaseId;
  cellId: ExperimentCellId;
  repetition: number;
  from: EvaluationRepetitionClassification;
  to: EvaluationRepetitionClassification;
}

export interface CaseOutcomeFlip {
  variantId: EvaluationVariantId;
  caseId: EvaluationCaseId;
  name: string;
  from: boolean;
  to: boolean;
}

export interface VariantOutcomeFlip {
  variantId: EvaluationVariantId;
  name: string;
  from: boolean;
  to: boolean;
}

export interface EvaluationOutcomeDiff {
  checks: CheckOutcomeFlip[];
  repetitions: RepetitionClassificationFlip[];
  cases: CaseOutcomeFlip[];
  variants: VariantOutcomeFlip[];
  /** True when the candidate reading is indistinguishable from the baseline. */
  unchanged: boolean;
}

/**
 * Diffs a candidate reading against a baseline reading of the same execution.
 *
 * Alignment is by stable identity throughout — variant, case, cell, check —
 * because both aggregates come from one plan. Anything present on only one side
 * is skipped above the check level rather than reported as a flip: two
 * aggregates of different executions is a misuse this function has no way to
 * describe usefully, and a comparison feature already exists for that question.
 */
export function diffEvaluationOutcomes(
  baseline: EvaluationBakeoffAssessment,
  candidate: EvaluationBakeoffAssessment,
): EvaluationOutcomeDiff {
  const checks: CheckOutcomeFlip[] = [];
  const repetitions: RepetitionClassificationFlip[] = [];
  const cases: CaseOutcomeFlip[] = [];
  const variants: VariantOutcomeFlip[] = [];

  const baselineVariants = new Map(
    baseline.variants.map((item) => [item.variant.variantId, item]),
  );
  for (const candidateVariant of candidate.variants) {
    const variantId = candidateVariant.variant.variantId;
    const baselineVariant = baselineVariants.get(variantId);
    if (!baselineVariant) continue;
    if (baselineVariant.passed !== candidateVariant.passed) {
      variants.push({
        variantId,
        name: candidateVariant.variant.name,
        from: baselineVariant.passed,
        to: candidateVariant.passed,
      });
    }

    const baselineCases = new Map(baselineVariant.cases.map((item) => [item.caseId, item]));
    for (const candidateCase of candidateVariant.cases) {
      const baselineCase = baselineCases.get(candidateCase.caseId);
      if (!baselineCase) continue;
      if (baselineCase.passed !== candidateCase.passed) {
        cases.push({
          variantId,
          caseId: candidateCase.caseId,
          name: candidateCase.name,
          from: baselineCase.passed,
          to: candidateCase.passed,
        });
      }

      const baselineRepetitions = new Map(
        baselineCase.repetitions.map((item) => [item.cellId, item]),
      );
      for (const candidateRepetition of candidateCase.repetitions) {
        const baselineRepetition = baselineRepetitions.get(candidateRepetition.cellId);
        if (!baselineRepetition) continue;
        const location = {
          variantId,
          caseId: candidateCase.caseId,
          cellId: candidateRepetition.cellId,
          repetition: candidateRepetition.repetition,
        };
        if (baselineRepetition.classification !== candidateRepetition.classification) {
          repetitions.push({
            ...location,
            from: baselineRepetition.classification,
            to: candidateRepetition.classification,
          });
        }

        const baselineResults = new Map(
          baselineRepetition.checks.map((item) => [item.checkId, item]),
        );
        const candidateCheckIds = new Set(
          candidateRepetition.checks.map(({ checkId }) => checkId),
        );
        for (const candidateResult of candidateRepetition.checks) {
          const baselineResult = baselineResults.get(candidateResult.checkId);
          const from: CheckOutcomeState = baselineResult?.outcome.status ?? "absent";
          if (from === candidateResult.outcome.status) continue;
          checks.push({
            ...location,
            checkId: candidateResult.checkId,
            kind: candidateResult.kind,
            from,
            to: candidateResult.outcome.status,
          });
        }
        for (const baselineResult of baselineRepetition.checks) {
          if (candidateCheckIds.has(baselineResult.checkId)) continue;
          checks.push({
            ...location,
            checkId: baselineResult.checkId,
            kind: baselineResult.kind,
            from: baselineResult.outcome.status,
            to: "absent",
          });
        }
      }
    }
  }

  return {
    checks,
    repetitions,
    cases,
    variants,
    unchanged: checks.length === 0 &&
      repetitions.length === 0 &&
      cases.length === 0 &&
      variants.length === 0,
  };
}
