import type {
  EvaluationBakeoffAssessment,
  EvaluationExperimentPlanV4,
  EvaluationRepetitionClassification,
  ExperimentConcurrency,
  ExperimentLifecycle,
  ExperimentResult,
  ExperimentStop,
} from "../../core/src/experiment.ts";

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
  cases: HeadlessCaseSummary[];
}

export interface HeadlessSummaryV1 {
  schemaVersion: typeof HEADLESS_SUMMARY_SCHEMA_VERSION;
  experimentId: string;
  suite: { suiteId: string; name: string };
  verdict: HeadlessVerdict;
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
    schemaVersion: HEADLESS_SUMMARY_SCHEMA_VERSION,
    experimentId: plan.experimentId,
    suite: { suiteId: plan.suite.suiteId, name: plan.suite.name },
    verdict: headlessVerdict(assessment),
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
    ...(result ? { concurrency: result.concurrency } : {}),
    configurations: assessment.variants.map((variant) => ({
      variantId: variant.variant.variantId,
      name: variant.variant.name,
      protocol: variant.variant.target.protocol,
      model: variant.variant.target.model,
      passed: variant.passed,
      caseCounts: { ...variant.caseCounts },
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
  if (summary.lifecycle !== "completed") {
    lines.push(`The run ${summary.lifecycle === "interrupted" ? "was interrupted" : `was ${summary.lifecycle}`} before every case finished.`);
  }
  if (summary.concurrency && summary.concurrency.maxInFlight > 1) {
    lines.push(`Ran up to ${summary.concurrency.maxInFlight} repetitions at once.`);
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
        (caseCounts.incomplete ? `, ${caseCounts.incomplete} incomplete` : ""),
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
