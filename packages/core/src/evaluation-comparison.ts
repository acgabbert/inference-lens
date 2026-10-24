import type { DecisionRun, DecisionWireProtocol } from "./decision.ts";
import {
  evaluationParsedExperimentAggregate,
  evaluationVariantAssessment,
  repetitionEvidence,
  type DecisionEvaluationExperimentPlan,
  type DecisionEvaluationVariantSnapshot,
  type EvaluationBakeoffAssessment,
  type EvaluationCaseAssessment,
  type EvaluationExperimentPlanV3,
  type EvaluationVariantAssessment,
  type EvaluationVariantSnapshot,
  type EvaluationVariantSnapshotV4,
  type EvaluationRepetitionClassification,
  type ExperimentMetricRange,
  type ExperimentResultInput,
  type ExperimentUsageAggregate,
  experimentConnectionKey,
  isFailingRepetition,
  sequentialExperimentConcurrency,
} from "./experiment.ts";
import {
  alignSuiteSnapshots,
  type AlignedCheck,
  type SuiteAlignmentCounts,
  type SuiteAlignmentReason,
  type SuiteAlignmentStatus,
} from "./evaluation-suite-alignment.ts";
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

interface ComparisonInputBase {
  experimentId: ExperimentId;
  variantId: EvaluationVariantId;
  result?: ExperimentResultInput;
}

/**
 * One side of a comparison: the same triple an aggregate is derived from, with
 * the run states of the plan's kind.
 */
export type EvaluationComparisonInput =
  | (ComparisonInputBase & { plan: EvaluationExperimentPlanV3; states?: ReadonlyMap<RunId, RunState> })
  | (ComparisonInputBase & { plan: DecisionEvaluationExperimentPlan; states?: ReadonlyMap<RunId, DecisionRun> });

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
  /**
   * A side has a rate-limited repetition and neither side a failing one, so
   * there is not enough evidence to call the case regressed, fixed, or
   * unchanged.
   */
  | "inconclusive"
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
  /** Repetitions the provider refused with a 429: missing evidence, like the two above. */
  rateLimited: number;
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
/** How many cells could run at once when one configuration's timings were taken. */
export interface EvaluationVariantConcurrency {
  /** Across the whole experiment. */
  maxInFlight: number;
  /** On the configuration's own connection. */
  connectionLimit: number;
}

interface ExecutionDriftBase {
  /** The conversation revision for chat, the decision request revision for decisions. */
  inputRevision?: EvaluationDriftField<string>;
  model?: EvaluationDriftField<string>;
  endpoint?: EvaluationDriftField<string>;
  repetitions?: EvaluationDriftField<number>;
  /**
   * The limits each side's configuration ran under. Absent when either side
   * has no result, because then nothing records how it ran.
   */
  concurrency?: EvaluationDriftField<EvaluationVariantConcurrency>;
  // No `checkSchemaVersion` field. Plans record vocabulary 3, 4, or 5, and each
  // version only adds constructs, so an identical check means the same on either side; a
  // check that differs already appears in the case's check comparison.
  /** Convenience for callers that only need "is there anything to show". */
  any: boolean;
}

export interface ChatExecutionDrift extends ExecutionDriftBase {
  kind: "chat";
  responseMode?: EvaluationDriftField<string>;
  /** `true` when the serialized inference options differ in any way. */
  optionsChanged?: boolean;
}

/**
 * A decision configuration varies only its target (D33), so it has no response
 * mode or options to drift. The capability snapshot is deliberately not
 * compared: its flags are connection-wide and a decision request reads none of
 * them (D52).
 */
export interface DecisionExecutionDrift extends ExecutionDriftBase {
  kind: "decision";
  protocol?: EvaluationDriftField<DecisionWireProtocol>;
}

/** Split by run kind (D52); both sides of a comparison are always one kind. */
export type EvaluationExecutionDrift = ChatExecutionDrift | DecisionExecutionDrift;

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
  inconclusive: number;
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
  states: ReadonlyMap<RunId, RunState | DecisionRun>;
  aggregate: EvaluationBakeoffAssessment<EvaluationVariantSnapshot>;
  variant: EvaluationVariantAssessment<EvaluationVariantSnapshot>;
  assessments: Map<EvaluationCaseId, EvaluationCaseAssessment>;
}

function derive(input: EvaluationComparisonInput): SideDerivation {
  // Plans are validated before they reach here; this guards the input's own
  // union against a plan of a kind that scores no cases.
  if (input.plan.kind !== "evaluation" && input.plan.kind !== "decision-evaluation") {
    throw new EvaluationComparisonError("Evaluation comparison requires evaluation plans.");
  }
  const aggregate: EvaluationBakeoffAssessment<EvaluationVariantSnapshot> = input.plan.kind === "evaluation"
    ? evaluationParsedExperimentAggregate(input.plan, input.result, (input.states ?? new Map()) as ReadonlyMap<RunId, RunState>)
    : evaluationParsedExperimentAggregate(input.plan, input.result, (input.states ?? new Map()) as ReadonlyMap<RunId, DecisionRun>);
  const variant = evaluationVariantAssessment(aggregate, input.variantId);
  return {
    input,
    states: input.states ?? new Map(),
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
    const { totalDurationMs } = repetitionEvidence(state).metrics;
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
  let rateLimited = 0;
  for (const repetition of assessment.repetitions) {
    if (repetition.classification === "trace-unavailable") missingTrace += 1;
    if (repetition.classification === "not-run") notRun += 1;
    if (repetition.classification === "rate-limited") rateLimited += 1;
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
    rateLimited,
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

/** Versions 4 and 5 predate recorded concurrency and ran one cell at a time. */
function variantConcurrency(side: SideDerivation): EvaluationVariantConcurrency | undefined {
  const { result, plan } = side.input;
  const target = side.variant.variant?.target;
  if (!result || !target) return undefined;
  const concurrency = result.schemaVersion === 6 ? result.concurrency : sequentialExperimentConcurrency(plan);
  const key = experimentConnectionKey(target);
  const connection = concurrency.connections.find((entry) => experimentConnectionKey(entry) === key);
  return { maxInFlight: concurrency.maxInFlight, connectionLimit: connection?.limit ?? 1 };
}

function inputRevisionId(side: SideDerivation): string {
  const { plan } = side.input;
  return plan.kind === "decision-evaluation" ? plan.suite.decisionRequestRevisionId : plan.suite.conversationRevisionId;
}

/** Fills the fields both kinds share, in place. */
function sharedDrift(baseline: SideDerivation, candidate: SideDerivation, drift: ExecutionDriftBase): void {
  if (inputRevisionId(baseline) !== inputRevisionId(candidate)) {
    drift.inputRevision = { baseline: inputRevisionId(baseline), candidate: inputRevisionId(candidate) };
  }
  const baselineTarget = baseline.variant.variant?.target;
  const candidateTarget = candidate.variant.variant?.target;
  if (baselineTarget && candidateTarget) {
    if (baselineTarget.model !== candidateTarget.model) {
      drift.model = { baseline: baselineTarget.model, candidate: candidateTarget.model };
    }
    if (baselineTarget.endpoint !== candidateTarget.endpoint) {
      drift.endpoint = { baseline: baselineTarget.endpoint, candidate: candidateTarget.endpoint };
    }
  }
  if (baseline.input.plan.repetitions !== candidate.input.plan.repetitions) {
    drift.repetitions = { baseline: baseline.input.plan.repetitions, candidate: candidate.input.plan.repetitions };
  }
  const baselineConcurrency = variantConcurrency(baseline);
  const candidateConcurrency = variantConcurrency(candidate);
  if (
    baselineConcurrency && candidateConcurrency &&
    !sameJson(baselineConcurrency, candidateConcurrency)
  ) {
    drift.concurrency = { baseline: baselineConcurrency, candidate: candidateConcurrency };
  }
}

function executionDrift(
  baseline: SideDerivation,
  candidate: SideDerivation,
): EvaluationExecutionDrift {
  let drift: EvaluationExecutionDrift;
  // Both sides are one kind (checked by the caller), so each side's variant
  // snapshots are that kind's.
  if (baseline.input.plan.kind === "decision-evaluation") {
    const decision: DecisionExecutionDrift = { kind: "decision", any: false };
    sharedDrift(baseline, candidate, decision);
    const baselineVariant = baseline.variant.variant as DecisionEvaluationVariantSnapshot | undefined;
    const candidateVariant = candidate.variant.variant as DecisionEvaluationVariantSnapshot | undefined;
    if (baselineVariant && candidateVariant && baselineVariant.target.protocol !== candidateVariant.target.protocol) {
      decision.protocol = { baseline: baselineVariant.target.protocol, candidate: candidateVariant.target.protocol };
    }
    drift = decision;
  } else {
    const chat: ChatExecutionDrift = { kind: "chat", any: false };
    sharedDrift(baseline, candidate, chat);
    const baselineVariant = baseline.variant.variant as EvaluationVariantSnapshotV4 | undefined;
    const candidateVariant = candidate.variant.variant as EvaluationVariantSnapshotV4 | undefined;
    if (baselineVariant && candidateVariant) {
      if (baselineVariant.responseMode !== candidateVariant.responseMode) {
        chat.responseMode = { baseline: baselineVariant.responseMode, candidate: candidateVariant.responseMode };
      }
      if (!sameJson(baselineVariant.options, candidateVariant.options)) chat.optionsChanged = true;
    }
    drift = chat;
  }
  // `kind` and `any` are always present; anything beyond them is a difference.
  drift.any = Object.keys(drift).length > 2;
  return drift;
}

/**
 * Rate limiting withholds evidence rather than giving a wrong answer, so it
 * cannot flip an outcome on its own. A failing repetition on either side is
 * still a real outcome and is compared as one.
 */
function inconclusive(
  baseline: readonly EvaluationRepetitionClassification[],
  candidate: readonly EvaluationRepetitionClassification[],
): boolean {
  const both = [...baseline, ...candidate];
  return both.includes("rate-limited") && !both.some(isFailingRepetition);
}

function delta(
  alignment: SuiteAlignmentStatus,
  baseline: EvaluationCaseSideSummary | undefined,
  candidate: EvaluationCaseSideSummary | undefined,
  classifications: { baseline: EvaluationRepetitionClassification[]; candidate: EvaluationRepetitionClassification[] },
): CaseOutcomeDelta {
  if (!baseline) return "candidate-only";
  if (!candidate) return "baseline-only";
  if (alignment === "incompatible") return "incomparable";
  if (inconclusive(classifications.baseline, classifications.candidate)) return "inconclusive";
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
          : inconclusive([baselineSide.classification], [candidateSide.classification])
            ? "inconclusive"
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
  if (baselineInput.plan.kind !== candidateInput.plan.kind) {
    // D50: the two kinds score different evidence, so a delta between them
    // would read as a regression or a fix that compares nothing.
    throw new EvaluationComparisonError("A chat evaluation with a decision evaluation cannot be compared.");
  }
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
      delta: delta(aligned.status, baselineSide, candidateSide, {
        baseline: baselineAssessment?.repetitions.map(({ classification }) => classification) ?? [],
        candidate: candidateAssessment?.repetitions.map(({ classification }) => classification) ?? [],
      }),
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
    inconclusive: cases.filter(({ delta }) => delta === "inconclusive").length,
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
