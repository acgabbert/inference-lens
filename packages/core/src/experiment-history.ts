import {
  evaluationParsedExperimentAggregate,
  experimentArtifactIdentity,
  isExperimentEntryName,
  parseExperimentPlanJson,
  parseExperimentResultJson,
  repeatedExperimentAggregate,
  type ExperimentLifecycle,
} from "./experiment.ts";
import type {
  ConversationRevisionId,
  EvaluationSuiteId,
  ExperimentId,
  RunId,
  RunState,
} from "./run-kernel/types.ts";
import {
  loadRunHistoryFilesWithStates,
  type RunHistoryFailure,
  type RunHistoryItem,
  type RunHistorySource,
} from "./run-history.ts";

export const LARGE_HISTORY_ARTIFACT_WARNING_THRESHOLD = 500;

export interface ExperimentHistorySource {
  fileName: string;
  contents: string;
}

export interface ExperimentHistoryCellReference {
  ordinal: number;
  runId: RunId;
  traceFileName?: string;
}

/**
 * The evaluation-specific facet of a history item.
 *
 * The surrounding item's `completed`/`failed`/`cancelled` counts describe run
 * status, which is the right fact for a repeated experiment and the wrong one
 * for an evaluation: a run that completed and then failed its checks is not a
 * passing case. Evaluation meaning therefore lives here, derived from the same
 * strict "As run" aggregate the results workspace renders, so one artifact
 * cannot read as passing in one surface and failing in another.
 *
 * Absent when the plan is not an evaluation, or when the aggregate could not be
 * derived — a damaged case must not remove the experiment from history.
 */
export interface EvaluationHistoryFacet {
  suiteId: EvaluationSuiteId;
  suiteName: string;
  conversationRevisionId: ConversationRevisionId;
  passed: boolean;
  caseCounts: { total: number; passed: number; failed: number };
}

export interface ExperimentHistoryItem {
  experimentId: ExperimentId;
  kind: "repeated-request" | "evaluation";
  evaluation?: EvaluationHistoryFacet;
  planFileName: string;
  resultFileName?: string;
  createdAt: string;
  endedAt?: string;
  model: string;
  lifecycle: ExperimentLifecycle;
  requested: number;
  completed: number;
  failed: number;
  cancelled: number;
  notRun: number;
  missingTrace: number;
  cells: ExperimentHistoryCellReference[];
}

export type ProjectHistoryEntry =
  | { kind: "experiment"; item: ExperimentHistoryItem }
  | { kind: "run"; item: RunHistoryItem };

export interface ProjectHistoryProjection {
  entries: ProjectHistoryEntry[];
  runs: RunHistoryItem[];
  experiments: ExperimentHistoryItem[];
  failures: RunHistoryFailure[];
  artifactCount: number;
  largeHistory: boolean;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Builds grouped project history from immutable artifacts. Every artifact is
 * isolated: a damaged experiment cannot hide another experiment or run.
 */
export function loadProjectHistoryFiles(
  traceFiles: RunHistorySource[],
  experimentFiles: ExperimentHistorySource[],
): ProjectHistoryProjection {
  const loadedRuns = loadRunHistoryFilesWithStates(traceFiles);
  const failures = [...loadedRuns.failures];
  const plans = new Map<ExperimentId, ExperimentHistorySource>();
  const results = new Map<ExperimentId, ExperimentHistorySource>();

  for (const file of experimentFiles) {
    // The one filename convention lives in `experiment.ts`; this projection
    // must never grow a second, subtly different copy of it.
    if (!isExperimentEntryName(file.fileName)) {
      failures.push({ fileName: file.fileName, message: "The experiment artifact filename is invalid." });
      continue;
    }
    const { experimentId, kind } = experimentArtifactIdentity(file.fileName);
    (kind === "plan" ? plans : results).set(experimentId, file);
  }

  const experiments: ExperimentHistoryItem[] = [];
  const groupedRunIds = new Set<RunId>();
  for (const [fileExperimentId, planFile] of plans) {
    let plan;
    try {
      plan = parseExperimentPlanJson(planFile.contents);
      if (plan.experimentId !== fileExperimentId) {
        throw new Error("Experiment plan identity does not match its filename.");
      }
    } catch (error) {
      failures.push({ fileName: planFile.fileName, message: message(error, "The experiment plan is invalid.") });
      continue;
    }

    let result;
    let resultFileName: string | undefined;
    const resultFile = results.get(fileExperimentId);
    if (resultFile) {
      try {
        result = parseExperimentResultJson(resultFile.contents, plan);
        resultFileName = resultFile.fileName;
      } catch (error) {
        failures.push({ fileName: resultFile.fileName, message: message(error, "The experiment result is invalid.") });
      }
    }

    const states = new Map<RunId, RunState>();
    const cells = plan.cells.map((cell) => {
      groupedRunIds.add(cell.runId);
      const stored = loadedRuns.statesByRunId.get(cell.runId);
      if (stored) states.set(cell.runId, stored.state);
      return {
        ordinal: cell.ordinal,
        runId: cell.runId,
        ...(stored ? { traceFileName: stored.fileName } : {}),
      };
    });
    const aggregate = plan.kind === "repeated-request"
      ? repeatedExperimentAggregate(plan, result, states)
      : (() => {
          const dispositions = new Map(result?.cells.map((cell) => [cell.cellId, cell]));
          let completed = 0;
          let failed = 0;
          let cancelled = 0;
          let notRun = 0;
          let missingTrace = 0;
          plan.cells.forEach((cell) => {
            const disposition = dispositions.get(cell.cellId);
            const state = states.get(cell.runId);
            if (disposition?.status === "not-run" || (!disposition && !state)) notRun += 1;
            else if (!state) missingTrace += 1;
            else if (state.status.kind === "completed") completed += 1;
            else if (state.status.kind === "failed") failed += 1;
            else if (state.status.kind === "cancelled") cancelled += 1;
            else notRun += 1;
          });
          const lifecycle: ExperimentLifecycle = result?.status ?? "interrupted";
          return {
            lifecycle,
            requested: plan.cells.length,
            completed,
            failed,
            cancelled,
            notRun,
            missingTrace,
          };
        })();
    let evaluation: EvaluationHistoryFacet | undefined;
    if (plan.kind === "evaluation") {
      try {
        const assessment = evaluationParsedExperimentAggregate(plan, result, states);
        evaluation = {
          suiteId: plan.suite.suiteId,
          suiteName: plan.suite.name,
          conversationRevisionId: plan.suite.conversationRevisionId,
          passed: assessment.passed,
          caseCounts: assessment.caseCounts,
        };
      } catch (error) {
        // Scoring a saved evaluation must not be able to hide it. The item
        // still lists and still opens; only the pass rate is unavailable.
        failures.push({
          fileName: planFile.fileName,
          message: message(error, "The evaluation could not be scored."),
        });
      }
    }

    experiments.push({
      experimentId: plan.experimentId,
      kind: plan.kind,
      ...(evaluation ? { evaluation } : {}),
      planFileName: planFile.fileName,
      ...(resultFileName ? { resultFileName } : {}),
      createdAt: plan.createdAt,
      ...(result ? { endedAt: result.endedAt } : {}),
      model: plan.kind === "repeated-request"
        ? plan.commonInput.target.model
        : plan.suite.cases[0]!.input.target.model,
      lifecycle: aggregate.lifecycle,
      requested: aggregate.requested,
      completed: aggregate.completed,
      failed: aggregate.failed,
      cancelled: aggregate.cancelled,
      notRun: aggregate.notRun,
      missingTrace: aggregate.missingTrace,
      cells,
    });
  }

  for (const [experimentId, resultFile] of results) {
    if (!plans.has(experimentId)) {
      failures.push({
        fileName: resultFile.fileName,
        message: "The experiment result has no matching plan.",
      });
    }
  }

  const runs = loadedRuns.items.filter((item) => !groupedRunIds.has(item.summary.runId));
  const entries: ProjectHistoryEntry[] = [
    ...runs.map((item): ProjectHistoryEntry => ({ kind: "run", item })),
    ...experiments.map((item): ProjectHistoryEntry => ({ kind: "experiment", item })),
  ].sort((left, right) => {
    const leftAt = left.kind === "run" ? left.item.summary.startedAt : left.item.createdAt;
    const rightAt = right.kind === "run" ? right.item.summary.startedAt : right.item.createdAt;
    if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
    const leftId = left.kind === "run" ? left.item.fileName : left.item.planFileName;
    const rightId = right.kind === "run" ? right.item.fileName : right.item.planFileName;
    return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
  });

  const artifactCount = traceFiles.length + experimentFiles.length;
  return {
    entries,
    runs,
    experiments,
    failures,
    artifactCount,
    largeHistory: artifactCount >= LARGE_HISTORY_ARTIFACT_WARNING_THRESHOLD,
  };
}
