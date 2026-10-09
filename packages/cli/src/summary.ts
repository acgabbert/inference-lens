import { isRateLimitedRun } from "../../core/src/experiment.ts";
import type {
  EvaluationBakeoffAssessment,
  EvaluationExperimentPlanV4,
  EvaluationRepetitionClassification,
  ExperimentConcurrency,
  ExperimentLifecycle,
  ExperimentMetricRange,
  ExperimentResult,
  ExperimentRetryPolicy,
  ExperimentStop,
  ExperimentUsageAggregate,
  RepeatedExperimentAggregate,
  RepeatedExperimentPlanV4,
} from "../../core/src/experiment.ts";
import type { RunId, RunState } from "../../core/src/run-kernel/index.ts";

/**
 * The `--json` summary. A public contract from its first release: a field is
 * never repurposed, and a breaking change bumps this version.
 *
 * It names outcomes and points at evidence. It never copies model output —
 * whoever wants that opens the trace the summary names.
 */
export const HEADLESS_SUMMARY_SCHEMA_VERSION = 1;

export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_SETUP = 2;
export const EXIT_INCOMPLETE = 3;

export type HeadlessVerdict = "passed" | "failed" | "incomplete";

export interface HeadlessRepetitionSummary {
  repetition: number;
  runId: string;
  classification: EvaluationRepetitionClassification;
  /** Relative to the project folder; absent when no trace was written. */
  trace?: string;
}

export interface HeadlessCaseSummary {
  caseId: string;
  name: string;
  passed: boolean;
  checks: { total: number; passed: number; failed: number; notEvaluated: number };
  repetitions: HeadlessRepetitionSummary[];
}

export interface HeadlessConfigurationSummary {
  variantId: string;
  name: string;
  protocol: string;
  model: string;
  passed: boolean;
  caseCounts: { total: number; passed: number; failed: number; incomplete: number };
  /**
   * Repetitions that retried at least one request the provider refused with
   * 429, whatever their outcome, so retrying cannot hide a configuration that
   * keeps reaching its limit.
   */
  retriedAfterRateLimit: number;
  cases: HeadlessCaseSummary[];
}

/** How much of the suite ran. A verdict describes what ran, not the whole suite. */
export interface HeadlessScope {
  cases: { selected: number; total: number };
  configurations: { selected: number; total: number };
}

export interface HeadlessSummaryV1 {
  /** Added after the first release, to tell this summary from `repeat`'s. */
  kind: "evaluation";
  schemaVersion: typeof HEADLESS_SUMMARY_SCHEMA_VERSION;
  experimentId: string;
  suite: { suiteId: string; name: string };
  verdict: HeadlessVerdict;
  /** Added after the first release; a run with no `--case` or `--configuration` selects everything. */
  scope: HeadlessScope;
  lifecycle: ExperimentLifecycle;
  stop?: ExperimentStop;
  /** Folder the artifact paths below are relative to. */
  projectDirectory: string;
  artifacts: { plan: string; result?: string };
  /**
   * The limits the result recorded: how many repetitions could run at once,
   * overall and per connection. Absent when no result was written. Timings
   * from runs at different limits are not comparable.
   */
  concurrency?: ExperimentConcurrency;
  /** Whether a 429 was retried, and how often per provider turn. Absent when no result was written. */
  retryPolicy?: ExperimentRetryPolicy;
  configurations: HeadlessConfigurationSummary[];
}

/**
 * Strict scoring all the way up: the suite passes only when every
 * configuration passed, and only a run that finished can pass or fail at all.
 * A suite whose only shortfall is rate limiting is incomplete too, so a quota
 * problem never reads as a model regression.
 */
export function headlessVerdict(assessment: EvaluationBakeoffAssessment): HeadlessVerdict {
  if (assessment.lifecycle !== "completed") return "incomplete";
  if (assessment.variants.length > 0 && assessment.variants.every(({ passed }) => passed)) return "passed";
  const repetitions = assessment.variants.flatMap(({ cases }) => cases.flatMap(({ repetitions }) => repetitions));
  const onlyRateLimited = repetitions.some(({ classification }) => classification === "rate-limited") &&
    repetitions.every(({ classification }) => classification === "passed" || classification === "rate-limited");
  return onlyRateLimited ? "incomplete" : "failed";
}

export function exitCodeForVerdict(verdict: HeadlessVerdict): number {
  switch (verdict) {
    case "passed":
      return EXIT_PASSED;
    case "failed":
      return EXIT_FAILED;
    case "incomplete":
      return EXIT_INCOMPLETE;
  }
}

export function createHeadlessSummary(input: {
  plan: EvaluationExperimentPlanV4;
  scope: HeadlessScope;
  result?: ExperimentResult;
  assessment: EvaluationBakeoffAssessment;
  projectDirectory: string;
  planPath: string;
  resultPath?: string;
  /** Traces that were actually written, by run ID. */
  tracePaths: ReadonlyMap<string, string>;
}): HeadlessSummaryV1 {
  const { plan, result, assessment } = input;
  return {
    kind: "evaluation",
    schemaVersion: HEADLESS_SUMMARY_SCHEMA_VERSION,
    experimentId: plan.experimentId,
    suite: { suiteId: plan.suite.suiteId, name: plan.suite.name },
    verdict: headlessVerdict(assessment),
    scope: input.scope,
    lifecycle: assessment.lifecycle,
    // Summary v1 reports why the run stopped, not the result's bookkeeping
    // for checking the stop, so it keeps the fields it shipped with.
    ...(result?.stop
      ? { stop: { reason: result.stop.reason, cellId: result.stop.cellId, toolId: result.stop.toolId } }
      : {}),
    projectDirectory: input.projectDirectory,
    artifacts: {
      plan: input.planPath,
      ...(input.resultPath ? { result: input.resultPath } : {}),
    },
    ...(result ? { concurrency: result.concurrency, retryPolicy: result.retryPolicy } : {}),
    configurations: assessment.variants.map((variant) => ({
      variantId: variant.variant.variantId,
      name: variant.variant.name,
      protocol: variant.variant.target.protocol,
      model: variant.variant.target.model,
      passed: variant.passed,
      caseCounts: { ...variant.caseCounts },
      retriedAfterRateLimit: variant.retriedAfterRateLimit,
      cases: variant.cases.map((evaluationCase) => {
        const checks = { total: 0, passed: 0, failed: 0, notEvaluated: 0 };
        for (const repetition of evaluationCase.repetitions) {
          for (const { outcome } of repetition.checks) {
            checks.total += 1;
            if (outcome.status === "passed") checks.passed += 1;
            else if (outcome.status === "failed") checks.failed += 1;
            else checks.notEvaluated += 1;
          }
        }
        return {
          caseId: evaluationCase.caseId,
          name: evaluationCase.name,
          passed: evaluationCase.passed,
          checks,
          repetitions: evaluationCase.repetitions.map((repetition) => {
            const trace = input.tracePaths.get(repetition.runId);
            return {
              repetition: repetition.repetition,
              runId: repetition.runId,
              classification: repetition.classification,
              ...(trace ? { trace } : {}),
            };
          }),
        };
      }),
    })),
  };
}

const CLASSIFICATION_WORDS: Record<EvaluationRepetitionClassification, string> = {
  passed: "passed",
  "check-failed": "check failed",
  "not-evaluated": "not evaluated",
  "run-failed": "run failed",
  "rate-limited": "rate limited",
  cancelled: "cancelled",
  "not-run": "not run",
  "trace-unavailable": "trace unavailable",
};

/** The default, human-readable report. Names outcomes; never quotes output. */
export function formatHeadlessSummary(summary: HeadlessSummaryV1): string {
  const lines: string[] = [];
  lines.push(`Suite "${summary.suite.name}" — ${summary.verdict.toUpperCase()}`);
  const { cases, configurations } = summary.scope;
  const partial = [
    ...(cases.selected < cases.total ? [`${cases.selected} of ${cases.total} cases`] : []),
    ...(configurations.selected < configurations.total
      ? [`${configurations.selected} of ${configurations.total} configurations`]
      : []),
  ];
  if (partial.length > 0) lines.push(`Ran ${partial.join(" and ")}.`);
  if (summary.lifecycle !== "completed") {
    lines.push(`The run ${summary.lifecycle === "interrupted" ? "was interrupted" : `was ${summary.lifecycle}`} before every case finished.`);
  }
  if (summary.concurrency && summary.concurrency.maxInFlight > 1) {
    lines.push(`Ran up to ${summary.concurrency.maxInFlight} repetitions at once.`);
  }
  const maxRetries = summary.retryPolicy?.rateLimited.maxRetries ?? 0;
  if (maxRetries > 0) {
    lines.push(`Retried rate-limited requests up to ${maxRetries} ${maxRetries === 1 ? "time" : "times"} per turn.`);
  }
  if (summary.stop) {
    lines.push(`Stopped because tool ${summary.stop.toolId} became unavailable.`);
  }
  for (const configuration of summary.configurations) {
    const { caseCounts } = configuration;
    lines.push("");
    lines.push(
      `${configuration.passed ? "PASS" : "FAIL"}  ${configuration.name} (${configuration.model}) — ` +
        `${caseCounts.passed}/${caseCounts.total} cases passed` +
        (caseCounts.failed ? `, ${caseCounts.failed} failed` : "") +
        (caseCounts.incomplete ? `, ${caseCounts.incomplete} incomplete` : "") +
        (configuration.retriedAfterRateLimit ? `, ${configuration.retriedAfterRateLimit} retried after rate limiting` : ""),
    );
    for (const evaluationCase of configuration.cases) {
      if (evaluationCase.passed) continue;
      const outcomes = evaluationCase.repetitions
        .filter(({ classification }) => classification !== "passed")
        .map(({ repetition, classification, trace }) =>
          `#${repetition} ${CLASSIFICATION_WORDS[classification]}${trace ? ` (${trace})` : ""}`);
      lines.push(`  ✗ ${evaluationCase.name}: ${outcomes.join("; ") || "no repetitions ran"}`);
    }
  }
  lines.push("");
  lines.push(`Experiment ${summary.experimentId} in ${summary.projectDirectory}`);
  lines.push(`  plan:   ${summary.artifacts.plan}`);
  if (summary.artifacts.result) lines.push(`  result: ${summary.artifacts.result}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The `repeat --json` summary: its own public contract, versioned apart from
 * the evaluation summary, under the same rules. A repeated run has no checks,
 * so it reports what happened to each repetition and the metric ranges, and
 * points at the traces for anything more.
 */
export const HEADLESS_REPEATED_SUMMARY_SCHEMA_VERSION = 1;

/**
 * `completed` when every repetition completed; `failed` when the batch ran to
 * the end and at least one failed other than by a 429; `incomplete` otherwise,
 * including a run whose only shortfall is rate limiting.
 */
export type HeadlessRepeatedOutcome = "completed" | "failed" | "incomplete";

export type HeadlessRepetitionStatus =
  | "completed"
  | "failed"
  | "rate-limited"
  | "cancelled"
  | "not-run"
  | "trace-unavailable";

export interface HeadlessRepeatedSummaryV1 {
  kind: "repeated-request";
  schemaVersion: typeof HEADLESS_REPEATED_SUMMARY_SCHEMA_VERSION;
  experimentId: string;
  outcome: HeadlessRepeatedOutcome;
  lifecycle: ExperimentLifecycle;
  stop?: ExperimentStop;
  /** Folder the artifact paths below are relative to. */
  projectDirectory: string;
  artifacts: { plan: string; result?: string };
  /** As in the evaluation summary: absent when no result was written. */
  concurrency?: ExperimentConcurrency;
  retryPolicy?: ExperimentRetryPolicy;
  conversationRevisionId: string;
  target: { connectionRequirementId: string; protocol: string; model: string };
  /**
   * In a buffered run the first output is the whole response, so
   * `metrics.ttfoMs` then says nothing about how soon output starts.
   */
  responseMode: "streaming" | "buffered";
  counts: Pick<
    RepeatedExperimentAggregate,
    "requested" | "completed" | "failed" | "rateLimited" | "cancelled" | "notRun" | "missingTrace" | "retriedAfterRateLimit"
  >;
  metrics: {
    totalDurationMs: ExperimentMetricRange;
    ttfoMs: ExperimentMetricRange;
    outputTokensPerSecond: ExperimentMetricRange;
    turnsPerRun: ExperimentMetricRange;
    toolCallsPerRun: ExperimentMetricRange;
    totalTokens: ExperimentUsageAggregate;
    outputTokens: ExperimentUsageAggregate;
  };
  /** How many different final answers the completed repetitions gave. A count, never the answers. */
  distinctFinalAssistantOutputs: number;
  repetitions: Array<{
    ordinal: number;
    runId: string;
    status: HeadlessRepetitionStatus;
    /** Relative to the project folder; absent when no trace was written. */
    trace?: string;
  }>;
}

export function headlessRepeatedOutcome(aggregate: RepeatedExperimentAggregate): HeadlessRepeatedOutcome {
  if (aggregate.lifecycle !== "completed") return "incomplete";
  if (aggregate.failed > 0) return "failed";
  return aggregate.completed === aggregate.requested ? "completed" : "incomplete";
}

export function exitCodeForRepeatedOutcome(outcome: HeadlessRepeatedOutcome): number {
  switch (outcome) {
    case "completed":
      return EXIT_PASSED;
    case "failed":
      return EXIT_FAILED;
    case "incomplete":
      return EXIT_INCOMPLETE;
  }
}

/** Classifies one repetition the way `repeatedExperimentAggregate` counts it. */
function repetitionStatus(
  disposition: ExperimentResult["cells"][number] | undefined,
  state: RunState | undefined,
): HeadlessRepetitionStatus {
  if (disposition?.status === "not-run" || (!disposition && !state)) return "not-run";
  if (!state) return "trace-unavailable";
  switch (state.status.kind) {
    case "completed":
      return "completed";
    case "failed":
      return isRateLimitedRun(state) ? "rate-limited" : "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "not-run";
  }
}

export function createHeadlessRepeatedSummary(input: {
  plan: RepeatedExperimentPlanV4;
  result?: ExperimentResult;
  aggregate: RepeatedExperimentAggregate;
  states: ReadonlyMap<RunId, RunState>;
  connectionRequirementId: string;
  projectDirectory: string;
  planPath: string;
  resultPath?: string;
  /** Traces that were actually written, by run ID. */
  tracePaths: ReadonlyMap<string, string>;
}): HeadlessRepeatedSummaryV1 {
  const { plan, result, aggregate } = input;
  const dispositions = new Map(result?.cells.map((cell) => [cell.cellId, cell]));
  return {
    kind: "repeated-request",
    schemaVersion: HEADLESS_REPEATED_SUMMARY_SCHEMA_VERSION,
    experimentId: plan.experimentId,
    outcome: headlessRepeatedOutcome(aggregate),
    lifecycle: aggregate.lifecycle,
    ...(result?.stop
      ? { stop: { reason: result.stop.reason, cellId: result.stop.cellId, toolId: result.stop.toolId } }
      : {}),
    projectDirectory: input.projectDirectory,
    artifacts: {
      plan: input.planPath,
      ...(input.resultPath ? { result: input.resultPath } : {}),
    },
    ...(result ? { concurrency: result.concurrency, retryPolicy: result.retryPolicy } : {}),
    conversationRevisionId: plan.commonInput.conversationRevisionId,
    target: {
      connectionRequirementId: input.connectionRequirementId,
      protocol: plan.commonInput.target.protocol,
      model: plan.commonInput.target.model,
    },
    responseMode: plan.commonInput.responseMode,
    counts: {
      requested: aggregate.requested,
      completed: aggregate.completed,
      failed: aggregate.failed,
      rateLimited: aggregate.rateLimited,
      cancelled: aggregate.cancelled,
      notRun: aggregate.notRun,
      missingTrace: aggregate.missingTrace,
      retriedAfterRateLimit: aggregate.retriedAfterRateLimit,
    },
    metrics: {
      totalDurationMs: aggregate.totalDurationMs,
      ttfoMs: aggregate.ttfoMs,
      outputTokensPerSecond: aggregate.outputTokensPerSecond,
      turnsPerRun: aggregate.turnsPerRun,
      toolCallsPerRun: aggregate.toolCallsPerRun,
      totalTokens: aggregate.totalTokens,
      outputTokens: aggregate.outputTokens,
    },
    distinctFinalAssistantOutputs: aggregate.distinctFinalAssistantOutputs,
    repetitions: plan.cells.map((cell) => {
      const trace = input.tracePaths.get(cell.runId);
      return {
        ordinal: cell.ordinal,
        runId: cell.runId,
        status: repetitionStatus(dispositions.get(cell.cellId), input.states.get(cell.runId)),
        ...(trace ? { trace } : {}),
      };
    }),
  };
}

const STATUS_WORDS: Record<HeadlessRepetitionStatus, string> = {
  completed: "completed",
  failed: "failed",
  "rate-limited": "rate limited",
  cancelled: "cancelled",
  "not-run": "not run",
  "trace-unavailable": "trace unavailable",
};

function formatRange(range: ExperimentMetricRange, unit: string): string | undefined {
  if (range.count === 0 || range.median === undefined) return undefined;
  const round = (value: number | undefined) => Math.round(value ?? 0);
  return `median ${round(range.median)} ${unit} (${round(range.min)}–${round(range.max)})`;
}

/** The default, human-readable report for `repeat`. Names outcomes; never quotes output. */
export function formatHeadlessRepeatedSummary(summary: HeadlessRepeatedSummaryV1): string {
  const lines: string[] = [];
  const { counts } = summary;
  lines.push(`Repeated run — ${summary.outcome.toUpperCase()}`);
  if (summary.lifecycle !== "completed") {
    lines.push(`The run ${summary.lifecycle === "interrupted" ? "was interrupted" : `was ${summary.lifecycle}`} before every repetition finished.`);
  }
  lines.push(
    `${counts.completed} of ${counts.requested} repetitions completed` +
      (counts.failed ? `, ${counts.failed} failed` : "") +
      (counts.rateLimited ? `, ${counts.rateLimited} rate limited` : "") +
      (counts.cancelled ? `, ${counts.cancelled} cancelled` : "") +
      (counts.notRun ? `, ${counts.notRun} not run` : "") +
      (counts.retriedAfterRateLimit ? `, ${counts.retriedAfterRateLimit} retried after rate limiting` : "") +
      ".",
  );
  lines.push(`${summary.target.model} on ${summary.target.connectionRequirementId}, ${summary.responseMode}.`);
  if (summary.responseMode === "buffered") lines.push("Buffered, so TTFO is the time to the whole response.");
  if (summary.concurrency && summary.concurrency.maxInFlight > 1) {
    lines.push(`Ran up to ${summary.concurrency.maxInFlight} repetitions at once.`);
  }
  const maxRetries = summary.retryPolicy?.rateLimited.maxRetries ?? 0;
  if (maxRetries > 0) {
    lines.push(`Retried rate-limited requests up to ${maxRetries} ${maxRetries === 1 ? "time" : "times"} per turn.`);
  }
  if (summary.stop) {
    lines.push(`Stopped because tool ${summary.stop.toolId} became unavailable.`);
  }
  const duration = formatRange(summary.metrics.totalDurationMs, "ms");
  const ttfo = formatRange(summary.metrics.ttfoMs, "ms");
  if (duration || ttfo) {
    lines.push("");
    if (duration) lines.push(`  duration: ${duration}`);
    if (ttfo) lines.push(`  TTFO:     ${ttfo}`);
  }
  if (counts.completed > 0) {
    lines.push(`  distinct final outputs: ${summary.distinctFinalAssistantOutputs}`);
  }
  const shortfalls = summary.repetitions.filter(({ status }) => status !== "completed");
  if (shortfalls.length > 0) lines.push("");
  for (const { ordinal, status, trace } of shortfalls) {
    lines.push(`  ✗ #${ordinal} ${STATUS_WORDS[status]}${trace ? ` (${trace})` : ""}`);
  }
  lines.push("");
  lines.push(`Experiment ${summary.experimentId} in ${summary.projectDirectory}`);
  lines.push(`  plan:   ${summary.artifacts.plan}`);
  if (summary.artifacts.result) lines.push(`  result: ${summary.artifacts.result}`);
  return `${lines.join("\n")}\n`;
}
