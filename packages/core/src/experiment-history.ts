import {
  parseExperimentPlanJson,
  parseExperimentResultJson,
  repeatedExperimentAggregate,
  type ExperimentLifecycle,
} from "./experiment.ts";
import type { ExperimentId, RunId } from "./run-kernel/types.ts";
import { runStateFromTrace } from "./run-trace.ts";
import {
  loadRunHistoryFilesWithTraces,
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

export interface ExperimentHistoryItem {
  experimentId: ExperimentId;
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
  const loadedRuns = loadRunHistoryFilesWithTraces(traceFiles);
  const failures = [...loadedRuns.failures];
  const plans = new Map<ExperimentId, ExperimentHistorySource>();
  const results = new Map<ExperimentId, ExperimentHistorySource>();

  for (const file of experimentFiles) {
    const match = /^(experiment_[A-Za-z0-9][A-Za-z0-9._-]*)\.(plan|result)\.json$/.exec(file.fileName);
    if (!match) {
      failures.push({ fileName: file.fileName, message: "The experiment artifact filename is invalid." });
      continue;
    }
    const destination = match[2] === "plan" ? plans : results;
    destination.set(match[1] as ExperimentId, file);
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

    const states = new Map<RunId, ReturnType<typeof runStateFromTrace>>();
    const cells = plan.cells.map((cell) => {
      groupedRunIds.add(cell.runId);
      const stored = loadedRuns.tracesByRunId.get(cell.runId);
      if (stored) states.set(cell.runId, runStateFromTrace(stored.trace));
      return {
        ordinal: cell.ordinal,
        runId: cell.runId,
        ...(stored ? { traceFileName: stored.fileName } : {}),
      };
    });
    const aggregate = repeatedExperimentAggregate(plan, result, states);
    experiments.push({
      experimentId: plan.experimentId,
      planFileName: planFile.fileName,
      ...(resultFileName ? { resultFileName } : {}),
      createdAt: plan.createdAt,
      ...(result ? { endedAt: result.endedAt } : {}),
      model: plan.commonInput.target.model,
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
