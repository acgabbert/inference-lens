import {
  evaluationParsedExperimentAggregate,
  evaluationVariantAssessment,
  type EvaluationBakeoffAssessment,
  type EvaluationCaseAssessment,
  type EvaluationExperimentPlanV3,
  type EvaluationRepetitionClassification,
  type ExperimentMetricRange,
  type ExperimentResultV3,
  type ExperimentUsageAggregate,
} from "./experiment.ts";
import {
  alignSuiteSnapshots,
  type AlignedCheck,
  type SuiteAlignmentCounts,
  type SuiteAlignmentReason,
  type SuiteAlignmentStatus,
} from "./evaluation-suite-alignment.ts";
import { runMetrics } from "./run-metrics.ts";
import { stableJsonValue } from "./stable-json.ts";
import type {
  EvaluationCaseId,
  EvaluationSuiteId,
  EvaluationVariantId,
  ExperimentCellId,
  ExperimentId,
  RunId,
  RunState,
} from "./run-kernel/types.ts";

/**
 * Compares two immutable evaluation executions of one suite.
 *
 * Derived, never stored: both sides are immutable artifacts plus ordinary run
 * states, so a comparison is reproducible from evidence and a pinned baseline
 * stays a pointer rather than a copy.
 */

/** One side of a comparison: the same triple an aggregate is derived from. */
export interface EvaluationComparisonInput {
  experimentId: ExperimentId;
  plan: EvaluationExperimentPlanV3;
  variantId: EvaluationVariantId;
  result?: ExperimentResultV3;
  states?: ReadonlyMap<RunId, RunState>;
}

/**
 * How a case's strict outcome moved. `incomparable` is not a hedge: it is the
 * finding that this case's definition changed, so its two outcomes are answers
 * to different questions and must not be read as a regression or a fix.
 */
export type CaseOutcomeDelta =
  | "unchanged-pass"
  | "unchanged-fail"
  | "fixed"
  | "regressed"
  | "incomparable"
  | "baseline-only"
  | "candidate-only";

export interface EvaluationCaseSideSummary {
  passed: boolean;
  repetitions: number;
  /**
   * Repetitions with no readable trace. Surfaced per side rather than folded
   * into the failure count: "the evidence is gone" is not "the check failed",
   * and a comparison that silently drops it overstates its own denominator.
   */
  missingTrace: number;
  notRun: number;
  checkCounts: { total: number; passed: number; failed: number; notEvaluated: number };
  totalDurationMs: ExperimentMetricRange;
}

export interface EvaluationCheckComparison extends AlignedCheck {
  baseline?: { passed: number; failed: number; notEvaluated: number };
  candidate?: { passed: number; failed: number; notEvaluated: number };
}

/**
 * The two immutable cells at one repetition number. This is deliberately
 * evidence-level data rather than another aggregate: a case can regress only
 * on one repetition, and the reader must be able to open that exact pair.
 */
export interface EvaluationRepetitionComparison {
  repetition: number;
  delta: CaseOutcomeDelta;
  baseline?: { cellId: ExperimentCellId; runId: RunId; classification: EvaluationRepetitionClassification };
  candidate?: { cellId: ExperimentCellId; runId: RunId; classification: EvaluationRepetitionClassification };
}

export interface EvaluationCaseComparison {
  caseId: EvaluationCaseId;
  name: string;
  alignment: SuiteAlignmentStatus;
  reasons: SuiteAlignmentReason[];
  delta: CaseOutcomeDelta;
  baseline?: EvaluationCaseSideSummary;
  candidate?: EvaluationCaseSideSummary;
  repetitions: EvaluationRepetitionComparison[];
  checks: EvaluationCheckComparison[];
}

/** A field that differs between the two executions, with both values. */
export interface EvaluationDriftField<Value> {
  baseline: Value;
  candidate: Value;
}

/**
 * Execution-level differences between the two sides. Every field is absent
 * when the two agree, so a rendered drift section lists only real differences.
 *
 * This is context, not incompatibility: a pass-rate change under a changed
 * model is a genuine comparison of two configurations, unlike a changed case
 * definition, which compares two different questions.
 */
export interface EvaluationExecutionDrift {
  inputRevision?: EvaluationDriftField<string>;
  model?: EvaluationDriftField<string>;
  endpoint?: EvaluationDriftField<string>;
  responseMode?: EvaluationDriftField<string>;
  /** `true` when the serialized inference options differ in any way. */
  optionsChanged?: boolean;
  repetitions?: EvaluationDriftField<number>;
  // No `checkSchemaVersion` field: the plan pins it as a `z.literal`, so both
  // sides must equal this build's version to have parsed at all. A version
  // range — and the drift reporting it would justify — arrives with the PR
  // that next bumps the check vocabulary.
  /** Convenience for callers that only need "is there anything to show". */
  any: boolean;
}

export interface EvaluationComparisonSideSummary {
  experimentId: ExperimentId;
  variantId: EvaluationVariantId;
  variantName: string;
  createdAt: string;
  lifecycle: EvaluationBakeoffAssessment["lifecycle"];
  passed: boolean;
  caseCounts: import("./experiment.ts").EvaluationCaseCounts;
  checkCounts: import("./experiment.ts").EvaluationVariantAssessment["checkCounts"];
  repetitionCounts: Record<EvaluationRepetitionClassification, number>;
  totalTokens: ExperimentUsageAggregate;
  outputTokens: ExperimentUsageAggregate;
  totalDurationMs: ExperimentMetricRange;
}

export interface EvaluationComparisonCounts extends SuiteAlignmentCounts {
  regressed: number;
  fixed: number;
  unchangedPass: number;
  unchangedFail: number;
}

export interface EvaluationComparison {
  /** Absent when the two executions are of different suites. */
  suiteId?: EvaluationSuiteId;
  sameSuite: boolean;
  baseline: EvaluationComparisonSideSummary;
  candidate: EvaluationComparisonSideSummary;
  drift: EvaluationExecutionDrift;
  cases: EvaluationCaseComparison[];
  counts: EvaluationComparisonCounts;
}

export class EvaluationComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationComparisonError";
  }
}

function range(values: readonly number[]): ExperimentMetricRange {
  const sorted = [...values].sort((left, right) => left - right);
  const count = sorted.length;
  if (count === 0) return { count };
  const middle = Math.floor(count / 2);
  const median = count % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return { count, min: sorted[0]!, median, max: sorted.at(-1)! };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

interface SideDerivation {
  input: EvaluationComparisonInput;
  states: ReadonlyMap<RunId, RunState>;
  aggregate: EvaluationBakeoffAssessment;
  variant: import("./experiment.ts").EvaluationVariantAssessment;
  assessments: Map<EvaluationCaseId, EvaluationCaseAssessment>;
}

function derive(input: EvaluationComparisonInput): SideDerivation {
  if (input.plan.kind !== "evaluation") {
    throw new EvaluationComparisonError("Evaluation comparison requires evaluation plans.");
  }
  const states = input.states ?? new Map<RunId, RunState>();
  const aggregate = evaluationParsedExperimentAggregate(input.plan, input.result, states);
  const variant = evaluationVariantAssessment(aggregate, input.variantId);
  return {
    input,
    states,
    aggregate,
    variant,
    assessments: new Map(variant.cases.map((item) => [item.caseId, item])),
  };
}

function durations(
  side: SideDerivation,
  assessment: EvaluationCaseAssessment | undefined,
): number[] {
  const values: number[] = [];
  for (const repetition of assessment?.repetitions ?? []) {
    const state = side.states.get(repetition.runId);
    if (!state) continue;
    const { totalDurationMs } = runMetrics(state);
    if (totalDurationMs !== undefined) values.push(totalDurationMs);
  }
  return values;
}

function caseSide(
  side: SideDerivation,
  assessment: EvaluationCaseAssessment | undefined,
): EvaluationCaseSideSummary | undefined {
  if (!assessment) return undefined;
  const checkCounts = { total: 0, passed: 0, failed: 0, notEvaluated: 0 };
  const planCase = side.input.plan.suite.cases.find(({ caseId }) => caseId === assessment.caseId);
  let missingTrace = 0;
  let notRun = 0;
  for (const repetition of assessment.repetitions) {
    if (repetition.classification === "trace-unavailable") missingTrace += 1;
    if (repetition.classification === "not-run") notRun += 1;
    checkCounts.total += planCase?.checks.length ?? 0;
    for (const check of repetition.checks) {
      if (check.outcome.status === "passed") checkCounts.passed += 1;
      else if (check.outcome.status === "failed") checkCounts.failed += 1;
      else checkCounts.notEvaluated += 1;
    }
  }
  checkCounts.notEvaluated +=
    checkCounts.total - checkCounts.passed - checkCounts.failed - checkCounts.notEvaluated;
  return {
    passed: assessment.passed,
    repetitions: assessment.repetitions.length,
    missingTrace,
    notRun,
    checkCounts,
    totalDurationMs: range(durations(side, assessment)),
  };
}

function checkTally(
  assessment: EvaluationCaseAssessment | undefined,
  checkId: string,
): { passed: number; failed: number; notEvaluated: number } | undefined {
  if (!assessment) return undefined;
  const tally = { passed: 0, failed: 0, notEvaluated: 0 };
  let seen = false;
  for (const repetition of assessment.repetitions) {
    for (const result of repetition.checks) {
      if (result.checkId !== checkId) continue;
      seen = true;
      if (result.outcome.status === "passed") tally.passed += 1;
      else if (result.outcome.status === "failed") tally.failed += 1;
      else tally.notEvaluated += 1;
    }
  }
  return seen ? tally : undefined;
}

function sideSummary(side: SideDerivation): EvaluationComparisonSideSummary {
  const values: number[] = [];
  for (const assessment of side.variant.cases) values.push(...durations(side, assessment));
  return {
    experimentId: side.input.experimentId,
    variantId: side.variant.variant.variantId,
    variantName: side.variant.variant.name,
    createdAt: side.input.plan.createdAt,
    lifecycle: side.aggregate.lifecycle,
    passed: side.variant.passed,
    caseCounts: side.variant.caseCounts,
    checkCounts: side.variant.checkCounts,
    repetitionCounts: side.variant.repetitionCounts,
    totalTokens: side.variant.totalTokens,
    outputTokens: side.variant.outputTokens,
    totalDurationMs: range(values),
  };
}

function executionDrift(
  baseline: SideDerivation,
  candidate: SideDerivation,
): EvaluationExecutionDrift {
  const baselineInput = baseline.variant.variant;
  const candidateInput = candidate.variant.variant;
  const drift: EvaluationExecutionDrift = { any: false };

  if (baseline.input.plan.suite.conversationRevisionId !== candidate.input.plan.suite.conversationRevisionId) {
    drift.inputRevision = {
      baseline: baseline.input.plan.suite.conversationRevisionId,
      candidate: candidate.input.plan.suite.conversationRevisionId,
    };
  }
  if (baselineInput && candidateInput) {
    if (baselineInput.target.model !== candidateInput.target.model) {
      drift.model = {
        baseline: baselineInput.target.model,
        candidate: candidateInput.target.model,
      };
    }
    if (baselineInput.target.endpoint !== candidateInput.target.endpoint) {
      drift.endpoint = {
        baseline: baselineInput.target.endpoint,
        candidate: candidateInput.target.endpoint,
      };
    }
    if (baselineInput.responseMode !== candidateInput.responseMode) {
      drift.responseMode = {
        baseline: baselineInput.responseMode,
        candidate: candidateInput.responseMode,
      };
    }
    if (!sameJson(baselineInput.options, candidateInput.options)) drift.optionsChanged = true;
  }
  if (baseline.input.plan.repetitions !== candidate.input.plan.repetitions) {
    drift.repetitions = { baseline: baseline.input.plan.repetitions, candidate: candidate.input.plan.repetitions };
  }
  drift.any = Object.keys(drift).length > 1;
  return drift;
}

function delta(
  alignment: SuiteAlignmentStatus,
  baseline: EvaluationCaseSideSummary | undefined,
  candidate: EvaluationCaseSideSummary | undefined,
): CaseOutcomeDelta {
  if (!baseline) return "candidate-only";
  if (!candidate) return "baseline-only";
  if (alignment === "incompatible") return "incomparable";
  if (baseline.passed && candidate.passed) return "unchanged-pass";
  if (!baseline.passed && !candidate.passed) return "unchanged-fail";
  return candidate.passed ? "fixed" : "regressed";
}

function repetitionComparisons(
  alignment: SuiteAlignmentStatus,
  baseline: EvaluationCaseAssessment | undefined,
  candidate: EvaluationCaseAssessment | undefined,
): EvaluationRepetitionComparison[] {
  const baselineByNumber = new Map(baseline?.repetitions.map((item) => [item.repetition, item]) ?? []);
  const candidateByNumber = new Map(candidate?.repetitions.map((item) => [item.repetition, item]) ?? []);
  const numbers = new Set([...baselineByNumber.keys(), ...candidateByNumber.keys()]);
  return [...numbers].sort((left, right) => left - right).map((repetition) => {
    const baselineItem = baselineByNumber.get(repetition);
    const candidateItem = candidateByNumber.get(repetition);
    const baselineSide = baselineItem && {
      cellId: baselineItem.cellId,
      runId: baselineItem.runId,
      classification: baselineItem.classification,
    };
    const candidateSide = candidateItem && {
      cellId: candidateItem.cellId,
      runId: candidateItem.runId,
      classification: candidateItem.classification,
    };
    const repetitionDelta = !baselineSide
      ? "candidate-only"
      : !candidateSide
        ? "baseline-only"
        : alignment === "incompatible"
          ? "incomparable"
          : baselineSide.classification === "passed" && candidateSide.classification === "passed"
            ? "unchanged-pass"
            : baselineSide.classification !== "passed" && candidateSide.classification !== "passed"
              ? "unchanged-fail"
              : candidateSide.classification === "passed" ? "fixed" : "regressed";
    return {
      repetition,
      delta: repetitionDelta,
      ...(baselineSide ? { baseline: baselineSide } : {}),
      ...(candidateSide ? { candidate: candidateSide } : {}),
    };
  });
}

export function compareEvaluationExecutions(
  baselineInput: EvaluationComparisonInput,
  candidateInput: EvaluationComparisonInput,
): EvaluationComparison {
  const baseline = derive(baselineInput);
  const candidate = derive(candidateInput);
  const alignment = alignSuiteSnapshots(baseline.input.plan.suite, candidate.input.plan.suite);
  const sameSuite = baseline.input.plan.suite.suiteId === candidate.input.plan.suite.suiteId;

  const cases = alignment.cases.map((aligned): EvaluationCaseComparison => {
    const baselineAssessment = baseline.assessments.get(aligned.caseId);
    const candidateAssessment = candidate.assessments.get(aligned.caseId);
    const baselineSide = caseSide(baseline, baselineAssessment);
    const candidateSide = caseSide(candidate, candidateAssessment);
    return {
      caseId: aligned.caseId,
      name: aligned.name,
      alignment: aligned.status,
      reasons: aligned.reasons,
      delta: delta(aligned.status, baselineSide, candidateSide),
      ...(baselineSide ? { baseline: baselineSide } : {}),
      ...(candidateSide ? { candidate: candidateSide } : {}),
      repetitions: repetitionComparisons(aligned.status, baselineAssessment, candidateAssessment),
      checks: aligned.checks.map((check): EvaluationCheckComparison => {
        const baselineTally = checkTally(baselineAssessment, check.checkId);
        const candidateTally = checkTally(candidateAssessment, check.checkId);
        return {
          ...check,
          ...(baselineTally ? { baseline: baselineTally } : {}),
          ...(candidateTally ? { candidate: candidateTally } : {}),
        };
      }),
    };
  });

  const counts: EvaluationComparisonCounts = {
    ...alignment.counts,
    regressed: cases.filter(({ delta }) => delta === "regressed").length,
    fixed: cases.filter(({ delta }) => delta === "fixed").length,
    unchangedPass: cases.filter(({ delta }) => delta === "unchanged-pass").length,
    unchangedFail: cases.filter(({ delta }) => delta === "unchanged-fail").length,
  };

  return {
    ...(sameSuite ? { suiteId: baseline.input.plan.suite.suiteId } : {}),
    sameSuite,
    baseline: sideSummary(baseline),
    candidate: sideSummary(candidate),
    drift: executionDrift(baseline, candidate),
    cases,
    counts,
  };
}
