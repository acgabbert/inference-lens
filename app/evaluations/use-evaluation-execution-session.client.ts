"use client";

import { useCallback, useRef, useState } from "react";

import type { CredentialSelection, ProviderTurnTransport } from "../../packages/contracts/src/index.ts";
import type {
  EvaluationExperimentPlanV3,
  ExperimentResultV3,
} from "../../packages/core/src/experiment.ts";
import type { RunId, RunState, RunTrace } from "../../packages/core/src/run-kernel/index.ts";
import { runStateFromTrace, traceFileName } from "../../packages/core/src/run-trace.ts";
import type { ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import { createExperimentWorkspacePersistence } from "../run/experiment-workspace-persistence.client.ts";
import { SequentialExperimentController } from "../run/sequential-experiment-controller.client.ts";

export interface EvaluationExecutionDraft {
  plan: EvaluationExperimentPlanV3;
  targetName: string;
  revisionCreatedAt: string;
  storage: "durable" | "unsaved";
}

export interface EvaluationLiveProgress {
  startedAtMs: number;
  requested: number;
  finished: number;
  currentOrdinal?: number;
}

export interface EvaluationExecution {
  plan: EvaluationExperimentPlanV3;
  storage: "durable" | "unsaved";
  workspace: ProjectWorkspaceHandle | null;
  states: ReadonlyMap<RunId, RunState>;
  live?: EvaluationLiveProgress;
  result?: ExperimentResultV3;
  error?: string;
  traces: ReadonlyMap<RunId, RunTrace>;
  traceFileNames: ReadonlyMap<RunId, string>;
  unreadableTraces: ReadonlyMap<RunId, string>;
  selectedRunId: RunId | null;
}

export interface UseEvaluationExecutionSessionOptions {
  transport: ProviderTurnTransport;
  prepareCredential(): Promise<CredentialSelection>;
  onTraceSaved(): void;
  onError(message: string): void;
  onOpenTrace(trace: RunTrace, origin: { workspace: ProjectWorkspaceHandle | null; fileName: string; source: "experiment" }): void;
}

/** Owns evaluation confirmation, controller progress, immutable evidence, and result review. */
export function useEvaluationExecutionSession(options: UseEvaluationExecutionSessionOptions) {
  const [draft, setDraft] = useState<EvaluationExecutionDraft>();
  const [execution, setExecution] = useState<EvaluationExecution>();
  const [isRunning, setIsRunning] = useState(false);
  const controllerRef = useRef<SequentialExperimentController | undefined>(undefined);

  const begin = useCallback((next: EvaluationExecutionDraft) => setDraft(next), []);
  const dismissDialog = useCallback(() => setDraft(undefined), []);

  const confirm = useCallback(async (workspace: ProjectWorkspaceHandle | null) => {
    const pending = draft;
    if (!pending || controllerRef.current?.isRunning) return;
    setDraft(undefined);
    setIsRunning(true);
    setExecution({
      plan: pending.plan,
      storage: workspace ? "durable" : "unsaved",
      workspace,
      states: new Map(),
      live: { startedAtMs: Date.now(), requested: pending.plan.cells.length, finished: 0 },
      traces: new Map(),
      traceFileNames: new Map(),
      unreadableTraces: new Map(),
      selectedRunId: null,
    });

    const persistence = workspace
      ? createExperimentWorkspacePersistence(workspace, pending.plan)
      : undefined;
    const controller = new SequentialExperimentController({
      plan: pending.plan,
      transport: options.transport,
      prepareCredential: options.prepareCredential,
      ...persistence,
      onProgress(progress) {
        setExecution((current) => current?.plan.experimentId === pending.plan.experimentId
          ? {
              ...current,
              states: progress.states,
              live: progress.status === "running"
                ? {
                    startedAtMs: current.live?.startedAtMs ?? Date.now(),
                    requested: progress.requested,
                    finished: progress.finished,
                    ...(progress.currentOrdinal === undefined ? {} : { currentOrdinal: progress.currentOrdinal }),
                  }
                : undefined,
            }
          : current);
      },
      async onTerminalTrace(trace, cell) {
        await persistence?.onTerminalTrace?.(trace, cell);
        setExecution((current) => {
          if (current?.plan.experimentId !== pending.plan.experimentId) return current;
          const traces = new Map(current.traces);
          const traceFileNames = new Map(current.traceFileNames);
          traces.set(trace.runId, trace);
          traceFileNames.set(trace.runId, traceFileName(trace.runId));
          return { ...current, traces, traceFileNames };
        });
        if (workspace) options.onTraceSaved();
      },
    });
    controllerRef.current = controller;
    try {
      const result = await controller.run();
      setExecution((current) => current?.plan.experimentId === pending.plan.experimentId
        ? { ...current, result }
        : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The evaluation was interrupted.";
      setExecution((current) => current?.plan.experimentId === pending.plan.experimentId
        ? { ...current, error: message }
        : current);
      options.onError(message);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = undefined;
      setExecution((current) => current?.plan.experimentId === pending.plan.experimentId
        ? { ...current, live: undefined }
        : current);
      setIsRunning(false);
    }
  }, [draft, options]);

  const cancel = useCallback(() => controllerRef.current?.cancel(), []);

  const openTrace = useCallback((runId: RunId) => {
    const current = execution;
    const trace = current?.traces.get(runId);
    if (!current || !trace) return;
    setExecution((active) => active === current ? { ...active, selectedRunId: runId } : active);
    options.onOpenTrace(trace, {
      workspace: current.workspace,
      fileName: current.traceFileNames.get(runId) ?? traceFileName(runId),
      source: "experiment",
    });
  }, [execution, options]);

  const openSaved = useCallback((opened: {
    plan: EvaluationExperimentPlanV3;
    result?: ExperimentResultV3;
    traces: ReadonlyMap<RunId, RunTrace>;
    traceFileNames: ReadonlyMap<RunId, string>;
    unreadableTraces: ReadonlyMap<RunId, string>;
  }, workspace: ProjectWorkspaceHandle) => {
    if (controllerRef.current?.isRunning) throw new Error("Stop the running evaluation before opening a saved one.");
    setExecution({
      plan: opened.plan,
      storage: "durable",
      workspace,
      states: new Map([...opened.traces].map(([runId, trace]) => [runId, runStateFromTrace(trace)] as const)),
      ...(opened.result ? { result: opened.result } : {}),
      traces: opened.traces,
      traceFileNames: opened.traceFileNames,
      unreadableTraces: opened.unreadableTraces,
      selectedRunId: null,
    });
  }, []);

  const returnToEvaluation = useCallback(() => {
    setExecution((current) => current ? { ...current, selectedRunId: null } : current);
  }, []);
  const clear = useCallback(() => {
    if (!controllerRef.current?.isRunning) setExecution(undefined);
  }, []);

  return { draft, execution, begin, dismissDialog, confirm, cancel, openTrace, openSaved, returnToEvaluation, clear, isRunning };
}
