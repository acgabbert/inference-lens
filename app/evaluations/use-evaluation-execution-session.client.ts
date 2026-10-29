"use client";

import { useCallback, useRef, useState } from "react";

import type { CredentialSelection, DecisionTransport, ProviderTurnTransport } from "../../packages/contracts/src/index.ts";
import type { DecisionRun } from "../../packages/core/src/decision.ts";
import { decisionRunFromTrace } from "../../packages/core/src/decision-trace.ts";
import type { DecisionRunTrace } from "../../packages/core/src/decision-trace.ts";
import { experimentExposedTools, rateLimitRetries } from "../../packages/core/src/experiment.ts";
import type {
  DecisionEvaluationExperimentPlan,
  EvaluationExperimentPlanV3,
  ExperimentConcurrencySetting,
  ExperimentResult,
  ExperimentTarget,
  SuiteExperimentPlan,
} from "../../packages/core/src/experiment.ts";
import type { RunId, RunState, RunTrace } from "../../packages/core/src/run-kernel/index.ts";
import type { EvaluationVariantId } from "../../packages/core/src/run-kernel/types.ts";
import { runStateFromTrace, traceFileName } from "../../packages/core/src/run-trace.ts";
import type { ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import {
  createDecisionExperimentWorkspacePersistence,
  createExperimentWorkspacePersistence,
} from "../run/experiment-workspace-persistence.client.ts";
import type { ExperimentToolBinding } from "../../packages/core/src/tool-binding-resolution.ts";
import { ExperimentController } from "../../packages/runner/src/experiment-controller.ts";
import type { ExperimentConnectionPause } from "../../packages/runner/src/experiment-controller.ts";
import { createToolExecutor } from "../run/tool-executors.client.ts";
import { verifyToolBindingsOnHost } from "../tools/tool-binding-check.client.ts";

export interface EvaluationExecutionDraft {
  /** A chat or a decision evaluation; one suite is one kind (D44). */
  plan: SuiteExperimentPlan;
  targetNames: Readonly<Record<EvaluationVariantId, string>>;
  /**
   * What will serve each tool the suite exposes, resolved when the draft was
   * built. Shown at confirmation and joined to the controller at start, so the
   * listing the author approved is the listing that executes.
   */
  toolBindings: ExperimentToolBinding[];
  /**
   * The same projected description the selector and preflight showed. It
   * already ends with the revision's creation time, so the draft carries no
   * separate timestamp for confirmation to reformat differently.
   */
  revisionLabel: string;
  storage: "durable" | "unsaved";
  /**
   * How many repetitions may run at once, set at confirmation. Absent means
   * every limit is 1. Never written into the plan: the result records the
   * limits the run actually used.
   */
  concurrency?: ExperimentConcurrencySetting;
  /** Whether a 429 is retried, up to the bound the core sets. Absent means off; the result records it. */
  retryRateLimits?: boolean;
}

export interface EvaluationLiveProgress {
  startedAtMs: number;
  requested: number;
  finished: number;
  /** Repetitions started and not yet terminal, ascending. */
  runningOrdinals: readonly number[];
  /** Connections a provider 429 is holding back. */
  pausedConnections: readonly ExperimentConnectionPause[];
}

interface EvaluationExecutionBase {
  storage: "durable" | "unsaved";
  workspace: ProjectWorkspaceHandle | null;
  live?: EvaluationLiveProgress;
  result?: ExperimentResult;
  error?: string;
  traceFileNames: ReadonlyMap<RunId, string>;
  unreadableTraces: ReadonlyMap<RunId, string>;
  /** Chat only: a decision repetition opens in Decision Compose instead (D51). */
  selectedRunId: RunId | null;
}

export interface ChatEvaluationExecution extends EvaluationExecutionBase {
  kind: "chat";
  plan: EvaluationExperimentPlanV3;
  states: ReadonlyMap<RunId, RunState>;
  traces: ReadonlyMap<RunId, RunTrace>;
}

export interface DecisionEvaluationExecution extends EvaluationExecutionBase {
  kind: "decision";
  plan: DecisionEvaluationExperimentPlan;
  states: ReadonlyMap<RunId, DecisionRun>;
  traces: ReadonlyMap<RunId, DecisionRunTrace>;
}

/** One execution of either kind; `kind` follows its plan's. */
export type EvaluationExecution = ChatEvaluationExecution | DecisionEvaluationExecution;

/** A saved execution as project history reads it back, of either kind. */
export type SavedEvaluationExecution =
  | {
      plan: EvaluationExperimentPlanV3;
      result?: ExperimentResult;
      traces: ReadonlyMap<RunId, RunTrace>;
      traceFileNames: ReadonlyMap<RunId, string>;
      unreadableTraces: ReadonlyMap<RunId, string>;
    }
  | {
      plan: DecisionEvaluationExperimentPlan;
      result?: ExperimentResult;
      traces: ReadonlyMap<RunId, DecisionRunTrace>;
      traceFileNames: ReadonlyMap<RunId, string>;
      unreadableTraces: ReadonlyMap<RunId, string>;
    };

export interface UseEvaluationExecutionSessionOptions {
  /** Serves chat cells and, through the decision transport, decision cells. */
  transport: ProviderTurnTransport & DecisionTransport;
  /** Either kind's target; both carry the profile and endpoint a credential is keyed by. */
  prepareCredential(target: ExperimentTarget): Promise<CredentialSelection>;
  onTraceSaved(): void;
  onError(message: string): void;
  /**
   * A batch this session started has run to completion.
   *
   * Reported from here rather than derived by the route from the execution
   * going quiet, because only this hook can tell a batch that just finished
   * from a saved one that was reopened — both leave a settled execution with a
   * result in it, and only one of them is news.
   *
   * Interruption is not completion and does not reach here: it goes to
   * `onError`, and its explanation stays on the results surface where the
   * evidence is.
   */
  onFinished?(outcome: { experimentId: string }): void;
}

/** Owns evaluation confirmation, controller progress, immutable evidence, and result review. */
export function useEvaluationExecutionSession(options: UseEvaluationExecutionSessionOptions) {
  const [draft, setDraft] = useState<EvaluationExecutionDraft>();
  const [execution, setExecution] = useState<EvaluationExecution>();
  const [isRunning, setIsRunning] = useState(false);
  const controllerRef = useRef<ExperimentController<RunState> | ExperimentController<DecisionRun> | undefined>(undefined);

  const begin = useCallback((next: EvaluationExecutionDraft) => setDraft(next), []);
  const dismissDialog = useCallback(() => setDraft(undefined), []);
  const setConcurrency = useCallback((concurrency: ExperimentConcurrencySetting) => {
    setDraft((current) => current ? { ...current, concurrency } : current);
  }, []);

  const setRetryRateLimits = useCallback((retryRateLimits: boolean) => {
    setDraft((current) => current ? { ...current, retryRateLimits } : current);
  }, []);

  const confirm = useCallback(async (workspace: ProjectWorkspaceHandle | null) => {
    const pending = draft;
    if (!pending || controllerRef.current?.isRunning) return;
    setDraft(undefined);
    setIsRunning(true);
    const plan = pending.plan;
    const live: EvaluationLiveProgress = {
      startedAtMs: Date.now(),
      requested: plan.cells.length,
      finished: 0,
      runningOrdinals: [],
      pausedConnections: [],
    };
    const common = {
      storage: workspace ? "durable" as const : "unsaved" as const,
      workspace,
      live,
      traceFileNames: new Map<RunId, string>(),
      unreadableTraces: new Map<RunId, string>(),
      selectedRunId: null,
    };
    setExecution(plan.kind === "decision-evaluation"
      ? { ...common, kind: "decision", plan, states: new Map(), traces: new Map() }
      : { ...common, kind: "chat", plan, states: new Map(), traces: new Map() });

    // Progress and saved traces are written the same way for either kind.
    const onProgress = (progress: { status: string; states: ReadonlyMap<RunId, RunState | DecisionRun>; requested: number; finished: number; runningOrdinals: readonly number[]; pausedConnections: readonly ExperimentConnectionPause[] }) => {
      setExecution((current) => current?.plan.experimentId === plan.experimentId
        ? {
            ...current,
            states: progress.states,
            live: progress.status === "running"
              ? {
                  startedAtMs: current.live?.startedAtMs ?? Date.now(),
                  requested: progress.requested,
                  finished: progress.finished,
                  runningOrdinals: progress.runningOrdinals,
                  pausedConnections: progress.pausedConnections,
                }
              : undefined,
          } as EvaluationExecution
        : current);
    };
    const recordTrace = (trace: RunTrace | DecisionRunTrace) => {
      setExecution((current) => {
        if (current?.plan.experimentId !== plan.experimentId) return current;
        const traces = new Map<RunId, RunTrace | DecisionRunTrace>(current.traces);
        const traceFileNames = new Map(current.traceFileNames);
        traces.set(trace.runId, trace);
        traceFileNames.set(trace.runId, traceFileName(trace.runId));
        return { ...current, traces, traceFileNames } as EvaluationExecution;
      });
      if (workspace) options.onTraceSaved();
    };
    const shared = {
      ...(pending.concurrency ? { concurrency: pending.concurrency } : {}),
      ...(pending.retryRateLimits ? { retryPolicy: rateLimitRetries() } : {}),
      onProgress,
    };

    let controller: ExperimentController<RunState> | ExperimentController<DecisionRun>;
    if (plan.kind === "decision-evaluation") {
      const persistence = workspace ? createDecisionExperimentWorkspacePersistence(workspace, plan) : undefined;
      controller = new ExperimentController<DecisionRun>({
        plan,
        decisionTransport: options.transport,
        prepareCredential: options.prepareCredential,
        ...(persistence ? { savePlan: persistence.savePlan, saveResult: persistence.saveResult } : {}),
        ...shared,
        async onTerminalTrace(trace) {
          await persistence?.onTerminalTrace(trace);
          recordTrace(trace);
        },
      });
    } else {
      const persistence = workspace
        ? createExperimentWorkspacePersistence(workspace, plan)
        : undefined;
      controller = new ExperimentController<RunState>({
        plan,
        transport: options.transport,
        prepareCredential: options.prepareCredential,
        // Device-local, never written into the durable plan — the same join the
        // repeated experiment makes, so one suite is served identically here and
        // nowhere else by accident.
        toolBindings: pending.toolBindings.flatMap(({ binding }) => binding ? [binding] : []),
        createExecutor: createToolExecutor,
        verifyToolBindings: (bindings) => verifyToolBindingsOnHost(bindings, (toolId) =>
          experimentExposedTools(plan).find(({ id }) => id === toolId)?.name ?? toolId),
        ...persistence,
        ...shared,
        async onTerminalTrace(trace, cell) {
          await persistence?.onTerminalTrace?.(trace, cell);
          recordTrace(trace);
        },
      });
    }
    controllerRef.current = controller;
    try {
      const result = await controller.run();
      setExecution((current) => current?.plan.experimentId === plan.experimentId
        ? { ...current, result }
        : current);
      options.onFinished?.({ experimentId: plan.experimentId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The evaluation was interrupted.";
      setExecution((current) => current?.plan.experimentId === plan.experimentId
        ? { ...current, error: message }
        : current);
      options.onError(message);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = undefined;
      setExecution((current) => {
        if (current?.plan.experimentId !== plan.experimentId) return current;
        const settled = { ...current };
        delete settled.live;
        return settled;
      });
      setIsRunning(false);
    }
  }, [draft, options]);

  const cancel = useCallback(() => controllerRef.current?.cancel(), []);

  /**
   * Selects one run to read beside the batch. The trace stays a read model of
   * this execution: adopting it into the live run session would replace the
   * session's ordinary run, which may exist nowhere else.
   */
  const openTrace = useCallback((runId: RunId) => {
    const current = execution;
    if (current?.kind !== "chat" || !current.traces.has(runId)) return;
    setExecution((active) => active === current ? { ...active, selectedRunId: runId } : active);
  }, [execution]);

  const openSaved = useCallback((opened: SavedEvaluationExecution, workspace: ProjectWorkspaceHandle) => {
    if (controllerRef.current?.isRunning) throw new Error("Stop the running evaluation before opening a saved one.");
    const common = {
      storage: "durable" as const,
      workspace,
      ...(opened.result ? { result: opened.result } : {}),
      traceFileNames: opened.traceFileNames,
      unreadableTraces: opened.unreadableTraces,
      selectedRunId: null,
    };
    if (opened.plan.kind === "decision-evaluation") {
      const traces = opened.traces as ReadonlyMap<RunId, DecisionRunTrace>;
      setExecution({
        ...common,
        kind: "decision",
        plan: opened.plan,
        states: new Map([...traces].map(([runId, trace]) => [runId, decisionRunFromTrace(trace)] as const)),
        traces,
      });
      return;
    }
    const traces = opened.traces as ReadonlyMap<RunId, RunTrace>;
    setExecution({
      ...common,
      kind: "chat",
      plan: opened.plan,
      states: new Map([...traces].map(([runId, trace]) => [runId, runStateFromTrace(trace)] as const)),
      traces,
    });
  }, []);

  const returnToEvaluation = useCallback(() => {
    setExecution((current) => current ? { ...current, selectedRunId: null } : current);
  }, []);
  const clear = useCallback(() => {
    if (!controllerRef.current?.isRunning) setExecution(undefined);
  }, []);

  return { draft, execution, begin, dismissDialog, setConcurrency, setRetryRateLimits, confirm, cancel, openTrace, openSaved, returnToEvaluation, clear, isRunning };
}
