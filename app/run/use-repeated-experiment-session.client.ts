"use client";

import { useCallback, useRef, useState } from "react";

import type { CredentialSelection, ProviderTurnTransport } from "../../packages/contracts/src/index.ts";
import type {
  ExperimentResultV2,
  RepeatedExperimentPlanV2,
} from "../../packages/core/src/experiment.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/index.ts";
import type {
  ResolvedRunInput,
  RunId,
  RunState,
  RunTrace,
} from "../../packages/core/src/run-kernel/index.ts";
import { randomUUID } from "../../packages/core/src/random-id.ts";
import { runStateFromTrace, traceFileName } from "../../packages/core/src/run-trace.ts";
import type { ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import { createExperimentWorkspacePersistence } from "./experiment-workspace-persistence.client.ts";
import { RepeatedExperimentController } from "./repeated-experiment-controller.client.ts";

export const DEFAULT_REPETITION_COUNT = 5;
export const MIN_REPETITION_COUNT = 2;
export const MAX_REPETITION_COUNT = 100;

export interface RepeatedExperimentDraft {
  plan: RepeatedExperimentPlanV2;
  targetName: string;
  requestSummary: string;
  repetitionCount: number;
  /** Applies the ordinary-run preparation effects only after confirmation. */
  commitPreparation(): void;
}

/**
 * Progress that exists only while this session drives the experiment. A saved
 * experiment reopened from history has no live progress: its disposition comes
 * from its plan, its optional result, and the states its traces reduce to.
 */
export interface RepeatedExperimentLiveProgress {
  /** Session-clock start used only for live elapsed-time presentation. */
  startedAtMs: number;
  requested: number;
  /** Cells that reached a terminal run status; queued cells are excluded. */
  finished: number;
  currentOrdinal?: number;
}

export interface RepeatedExperimentExecution {
  plan: RepeatedExperimentPlanV2;
  storage: "durable" | "unsaved";
  /** The experiment's original workspace, retained for opening its saved traces. */
  workspace: ProjectWorkspaceHandle | null;
  /** Reduced state for every started cell, keyed by its preallocated run ID. */
  states: ReadonlyMap<RunId, RunState>;
  /** Absent once the experiment is terminal, and for every saved experiment. */
  live?: RepeatedExperimentLiveProgress;
  result?: ExperimentResultV2;
  error?: string;
  traces: ReadonlyMap<RunId, RunTrace>;
  traceFileNames: ReadonlyMap<RunId, string>;
  /** Referenced traces that exist in the plan but could not be read, by run ID. */
  unreadableTraces: ReadonlyMap<RunId, string>;
  /** Keeps the experiment beside the ordinary run while reviewing one cell. */
  selectedRunId: RunId | null;
}

export interface UseRepeatedExperimentSessionOptions {
  transport: ProviderTurnTransport;
  prepareCredential(): Promise<CredentialSelection>;
  onTraceSaved(): void;
  onError(message: string): void;
  onOpenTrace(trace: RunTrace, origin: { workspace: ProjectWorkspaceHandle | null; fileName: string; source: "experiment" }): void;
}

function normalizedCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REPETITION_COUNT;
  return Math.max(MIN_REPETITION_COUNT, Math.min(MAX_REPETITION_COUNT, Math.trunc(value)));
}

/** Freezes the resolved semantic input and allocates every ordinary run before execution. */
function planFor(input: ResolvedRunInput, repetitionCount: number): RepeatedExperimentPlanV2 {
  const frozenInput = structuredClone(input);
  const { runId: discardedRunId, ...commonInput } = frozenInput;
  void discardedRunId;
  const experimentId = createEntityId("experiment", randomUUID());
  return {
    schemaVersion: 2,
    experimentId,
    kind: "repeated-request",
    createdAt: new Date().toISOString(),
    commonInput,
    cells: Array.from({ length: normalizedCount(repetitionCount) }, (_, index) => ({
      cellId: createEntityId("experiment-cell", randomUUID()),
      ordinal: index + 1,
      runId: createEntityId("run", randomUUID()),
    })),
  };
}

function requestSummary(input: ResolvedRunInput): string {
  const messageCount = input.messages.length;
  return `${messageCount} ${messageCount === 1 ? "message" : "messages"} · ${input.responseMode} response`;
}

/** Owns one repeated-experiment dialog, controller, live evidence, and result. */
export function useRepeatedExperimentSession(options: UseRepeatedExperimentSessionOptions) {
  const [draft, setDraft] = useState<RepeatedExperimentDraft>();
  const [execution, setExecution] = useState<RepeatedExperimentExecution>();
  const [isRunning, setIsRunning] = useState(false);
  const controllerRef = useRef<RepeatedExperimentController | undefined>(undefined);

  const begin = useCallback((input: ResolvedRunInput, targetName: string, commitPreparation: () => void) => {
    const count = DEFAULT_REPETITION_COUNT;
    setDraft({
      plan: planFor(input, count),
      targetName,
      requestSummary: requestSummary(input),
      repetitionCount: count,
      commitPreparation,
    });
  }, []);

  const setRepetitionCount = useCallback((value: number) => {
    setDraft((current) => {
      if (!current) return current;
      const count = normalizedCount(value);
      const sampleInput = {
        ...current.plan.commonInput,
        runId: current.plan.cells[0]!.runId,
      };
      return {
        ...current,
        plan: planFor(sampleInput, count),
        repetitionCount: count,
      };
    });
  }, []);

  const dismissDialog = useCallback(() => setDraft(undefined), []);

  const confirm = useCallback(async (workspace: ProjectWorkspaceHandle | null) => {
    const pending = draft;
    if (!pending || controllerRef.current?.isRunning) return;
    setDraft(undefined);
    pending.commitPreparation();
    setIsRunning(true);

    setExecution({
      plan: pending.plan,
      storage: workspace ? "durable" : "unsaved",
      workspace,
      states: new Map(),
      live: {
        startedAtMs: Date.now(),
        requested: pending.plan.cells.length,
        finished: 0,
      },
      traces: new Map(),
      traceFileNames: new Map(),
      unreadableTraces: new Map(),
      selectedRunId: null,
    });

    const persistence = workspace
      ? createExperimentWorkspacePersistence(workspace, pending.plan)
      : undefined;
    const controller = new RepeatedExperimentController({
      plan: pending.plan,
      transport: options.transport,
      prepareCredential: options.prepareCredential,
      ...persistence,
      onProgress(progress) {
        setExecution((current) => {
          if (current?.plan.experimentId !== pending.plan.experimentId) return current;
          return {
            ...current,
            states: progress.states,
            // A terminal emission retires the live clock rather than leaving a
            // finished experiment describing itself as still in progress.
            live: progress.status === "running"
              ? {
                  startedAtMs: current.live?.startedAtMs ?? Date.now(),
                  requested: progress.requested,
                  finished: progress.finished,
                  ...(progress.currentOrdinal === undefined
                    ? {}
                    : { currentOrdinal: progress.currentOrdinal }),
                }
              : undefined,
          };
        });
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
      const message = error instanceof Error ? error.message : "The repeated experiment was interrupted.";
      setExecution((current) => current?.plan.experimentId === pending.plan.experimentId
        ? { ...current, error: message }
        : current);
      options.onError(message);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = undefined;
      // An interruption never reaches a terminal progress emission, so the live
      // clock is retired here for every way this experiment can stop.
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
      fileName: current.traceFileNames.get(trace.runId) ?? traceFileName(trace.runId),
      source: "experiment",
    });
  }, [execution, options]);

  const openSaved = useCallback((opened: {
    plan: RepeatedExperimentPlanV2;
    result?: ExperimentResultV2;
    traces: ReadonlyMap<RunId, RunTrace>;
    traceFileNames: ReadonlyMap<RunId, string>;
    unreadableTraces: ReadonlyMap<RunId, string>;
  }, workspace: ProjectWorkspaceHandle) => {
    // Replacing the execution under a running controller would strand it, so
    // this refuses out loud rather than dropping the request silently.
    if (controllerRef.current?.isRunning) {
      throw new Error("Stop the running experiment before opening a saved one.");
    }
    setExecution({
      plan: opened.plan,
      storage: "durable",
      workspace,
      states: new Map(
        [...opened.traces].map(([runId, trace]) => [runId, runStateFromTrace(trace)] as const),
      ),
      ...(opened.result ? { result: opened.result } : {}),
      traces: opened.traces,
      traceFileNames: opened.traceFileNames,
      unreadableTraces: opened.unreadableTraces,
      selectedRunId: null,
    });
  }, []);

  const returnToRequest = useCallback(() => {
    setExecution((current) => current ? { ...current, selectedRunId: null } : current);
  }, []);

  const clear = useCallback(() => {
    if (!controllerRef.current?.isRunning) setExecution(undefined);
  }, []);

  return {
    draft,
    execution,
    begin,
    setRepetitionCount,
    dismissDialog,
    confirm,
    cancel,
    openTrace,
    openSaved,
    returnToRequest,
    clear,
    isRunning,
  };
}
