"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  EvaluationBaselineError,
  emptyEvaluationBaselines,
  pinEvaluationBaseline,
  suiteEvaluationBaselines,
  unpinEvaluationBaseline,
  type EvaluationBaseline,
  type EvaluationBaselinesFileV2,
} from "../../packages/core/src/evaluation-baselines.ts";
import {
  compareEvaluationExecutions,
  type EvaluationComparison,
  type EvaluationComparisonInput,
} from "../../packages/core/src/evaluation-comparison.ts";
import type { DecisionRun } from "../../packages/core/src/decision.ts";
import { decisionRunFromTrace } from "../../packages/core/src/decision-trace.ts";
import type { DecisionRunTrace } from "../../packages/core/src/decision-trace.ts";
import type {
  DecisionEvaluationExperimentPlan,
  EvaluationExperimentPlanV3,
  ExperimentResult,
} from "../../packages/core/src/experiment.ts";
import type { EvaluationHistoryItem } from "../../packages/core/src/experiment-history.ts";
import type {
  EvaluationBaselineId,
  EvaluationSuiteId,
  EvaluationVariantId,
  RunId,
  RunState,
  RunTrace,
} from "../../packages/core/src/run-kernel/index.ts";
import { runStateFromTrace } from "../../packages/core/src/run-trace.ts";
import { randomUUID } from "../../packages/core/src/random-id.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/types.ts";
import {
  readEvaluationBaselinesWorkspace,
  saveEvaluationBaselinesWorkspace,
  type ProjectWorkspaceHandle,
} from "../project-workspace.client.ts";
import type { OpenedProjectExperiment } from "../use-project-run-history.client.ts";

interface LoadedComparisonSideBase {
  item: EvaluationHistoryItem;
  traceFileNames: ReadonlyMap<RunId, string>;
  result?: ExperimentResult;
}

/** One side of a loaded comparison, kept so a reader can open its evidence. */
export type LoadedComparisonSide =
  | (LoadedComparisonSideBase & {
      kind: "chat";
      plan: EvaluationExperimentPlanV3;
      traces: ReadonlyMap<RunId, RunTrace>;
      states: ReadonlyMap<RunId, RunState>;
    })
  | (LoadedComparisonSideBase & {
      kind: "decision";
      plan: DecisionEvaluationExperimentPlan;
      traces: ReadonlyMap<RunId, DecisionRunTrace>;
      states: ReadonlyMap<RunId, DecisionRun>;
    });

export interface LoadedEvaluationComparison {
  baselineName: string;
  baseline: LoadedComparisonSide;
  candidate: LoadedComparisonSide;
  comparison: EvaluationComparison;
}

export interface EvaluationBaselinesSession {
  status: "idle" | "loading" | "loaded" | "failed";
  /** Set when the annotation file could not be read or written. */
  error?: string;
  baselines: EvaluationBaseline[];
  forSuite(suiteId: EvaluationSuiteId | undefined): EvaluationBaseline[];
  load(): void;
  pin(item: EvaluationHistoryItem, variantId: EvaluationVariantId, name: string): Promise<void>;
  unpin(baselineId: EvaluationBaselineId): Promise<void>;
  compare(
    baseline: EvaluationBaseline,
    candidate: EvaluationHistoryItem,
    candidateVariantId: EvaluationVariantId,
  ): Promise<void>;
  comparing: boolean;
  comparison?: LoadedEvaluationComparison;
  clearComparison(): void;
}

interface LoadedBaselines {
  workspace: ProjectWorkspaceHandle;
  status: "loading" | "loaded" | "failed";
  file: EvaluationBaselinesFileV2;
  error?: string;
}

interface HeldComparison {
  workspace: ProjectWorkspaceHandle;
  comparison: LoadedEvaluationComparison;
}

export interface UseEvaluationBaselinesOptions {
  workspace: ProjectWorkspaceHandle | null;
  /** The same reader project history uses, so both surfaces see one folder. */
  readExperiment(item: EvaluationHistoryItem): Promise<OpenedProjectExperiment>;
  /** Resolves a pinned baseline's experiment back to a listed history item. */
  findExperiment(baseline: EvaluationBaseline): EvaluationHistoryItem | undefined;
}

function message(error: unknown, fallback: string): string {
  if (error instanceof EvaluationBaselineError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

function side(
  item: EvaluationHistoryItem,
  opened: OpenedProjectExperiment,
): LoadedComparisonSide {
  const common = { item, traceFileNames: opened.traceFileNames, ...(opened.result ? { result: opened.result } : {}) };
  if (opened.kind === "decision") {
    return {
      ...common,
      kind: "decision",
      plan: opened.plan,
      traces: opened.traces,
      states: new Map([...opened.traces].map(([runId, trace]) => [runId, decisionRunFromTrace(trace)] as const)),
    };
  }
  if (opened.plan.kind !== "evaluation") {
    throw new Error(`${item.planFileName} is not an evaluation.`);
  }
  return {
    ...common,
    kind: "chat",
    plan: opened.plan,
    traces: opened.traces,
    states: new Map(
      [...opened.traces].map(([runId, trace]) => [runId, runStateFromTrace(trace)] as const),
    ),
  };
}

/** The comparison input for one loaded side; its plan and states share a kind. */
function comparisonInput(loaded: LoadedComparisonSide, variantId: EvaluationVariantId): EvaluationComparisonInput {
  const common = { experimentId: loaded.plan.experimentId, variantId, ...(loaded.result ? { result: loaded.result } : {}) };
  return loaded.kind === "decision"
    ? { ...common, plan: loaded.plan, states: loaded.states }
    : { ...common, plan: loaded.plan, states: loaded.states };
}

/**
 * Owns named baselines and the comparison derived from a pinned pair.
 *
 * The annotation file is read lazily, for the same reason the history listing
 * is: opening a project should not pay for evidence nobody has asked to see.
 * Every mutation writes the whole file and then keeps the written value, so a
 * failed write leaves both the file and this state unchanged rather than
 * leaving the screen claiming a pin that was never saved.
 */
export function useEvaluationBaselines(
  options: UseEvaluationBaselinesOptions,
): EvaluationBaselinesSession {
  const { workspace, readExperiment, findExperiment } = options;
  // State is stored with the folder it was read from rather than reset by an
  // effect when the folder changes. A stale folder's annotations are then
  // unreachable by construction, with no render in between where they could be
  // shown against the wrong project.
  const [loaded, setLoaded] = useState<LoadedBaselines | null>(null);
  const [held, setHeld] = useState<HeldComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const generationRef = useRef(0);
  const active = loaded && loaded.workspace === workspace ? loaded : null;
  const file = active?.file ?? emptyEvaluationBaselines();
  // A comparison is evidence read out of one folder, so it is scoped to that
  // folder the same way the annotations are.
  const comparison = held && held.workspace === workspace ? held.comparison : undefined;

  useEffect(() => () => void (generationRef.current += 1), []);

  const load = useCallback((): void => {
    // Re-reading an already-loaded folder would cost a file read to learn
    // nothing; a previous failure is worth retrying.
    if (!workspace || (active && active.status !== "failed")) return;
    const generation = ++generationRef.current;
    void (async () => {
      setLoaded({ workspace, status: "loading", file });
      try {
        const next = await readEvaluationBaselinesWorkspace(workspace);
        if (generation !== generationRef.current) return;
        setLoaded({ workspace, status: "loaded", file: next });
      } catch (loadError) {
        if (generation !== generationRef.current) return;
        setLoaded({
          workspace,
          status: "failed",
          file: emptyEvaluationBaselines(),
          error: message(loadError, "Could not read the project's baselines."),
        });
      }
    })();
  }, [active, file, workspace]);

  const write = useCallback(
    async (next: EvaluationBaselinesFileV2): Promise<void> => {
      if (!workspace) throw new Error("Open a project folder to pin a baseline.");
      await saveEvaluationBaselinesWorkspace(workspace, next);
      setLoaded({ workspace, status: "loaded", file: next });
    },
    [workspace],
  );

  const pin = useCallback(
    async (item: EvaluationHistoryItem, variantId: EvaluationVariantId, name: string): Promise<void> => {
      const suiteId = item.evaluation.suiteId;
      await write(
        pinEvaluationBaseline(file, {
          baselineId: createEntityId("evaluation-baseline", randomUUID()),
          suiteId,
          experimentId: item.experimentId,
          variantId,
          name,
          pinnedAt: new Date().toISOString(),
        }),
      );
    },
    [file, write],
  );

  const unpin = useCallback(
    async (baselineId: EvaluationBaselineId): Promise<void> => {
      // An open comparison survives unpinning. It is already-loaded evidence,
      // and removing the annotation is not a reason to take the reading away.
      await write(unpinEvaluationBaseline(file, baselineId));
    },
    [file, write],
  );

  const compare = useCallback(
    async (
      baseline: EvaluationBaseline,
      candidate: EvaluationHistoryItem,
      candidateVariantId: EvaluationVariantId,
    ): Promise<void> => {
      const baselineItem = findExperiment(baseline);
      if (!baselineItem) {
        throw new Error(
          `The execution pinned as "${baseline.name}" is no longer in this project folder.`,
        );
      }
      if (
        baselineItem.experimentId === candidate.experimentId &&
        baseline.variantId === candidateVariantId
      ) {
        throw new Error("Choose a candidate configuration other than the baseline itself.");
      }
      if (!workspace) throw new Error("The project folder is no longer open.");
      setComparing(true);
      try {
        const [baselineOpened, candidateOpened] = await Promise.all([
          readExperiment(baselineItem),
          readExperiment(candidate),
        ]);
        const baselineSide = side(baselineItem, baselineOpened);
        const candidateSide = side(candidate, candidateOpened);
        setHeld({
          workspace,
          comparison: {
            baselineName: baseline.name,
            baseline: baselineSide,
            candidate: candidateSide,
            comparison: compareEvaluationExecutions(
              comparisonInput(baselineSide, baseline.variantId),
              comparisonInput(candidateSide, candidateVariantId),
            ),
          },
        });
      } finally {
        setComparing(false);
      }
    },
    [findExperiment, readExperiment, workspace],
  );

  const forSuite = useCallback(
    (suiteId: EvaluationSuiteId | undefined): EvaluationBaseline[] =>
      suiteId ? suiteEvaluationBaselines(file, suiteId) : [],
    [file],
  );

  return {
    status: active?.status ?? "idle",
    ...(active?.error ? { error: active.error } : {}),
    baselines: file.baselines,
    forSuite,
    load,
    pin,
    unpin,
    compare,
    comparing,
    ...(comparison ? { comparison } : {}),
    clearComparison: useCallback(() => setHeld(null), []),
  };
}
