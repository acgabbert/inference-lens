"use client";

import { useCallback, useRef, useState } from "react";

import type { CredentialSelection, ProviderTurnTransport } from "../../packages/contracts/src/index.ts";
import type {
  ExperimentResultV1,
  RepeatedExperimentPlanV1,
} from "../../packages/core/src/experiment.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/index.ts";
import type { ResolvedRunInput, RunId, RunState, RunTrace } from "../../packages/core/src/run-kernel/index.ts";
import { randomUUID } from "../../packages/core/src/random-id.ts";
import { traceFileName } from "../../packages/core/src/run-trace.ts";
import type { ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import { createExperimentWorkspacePersistence } from "./experiment-workspace-persistence.client.ts";
import {
  RepeatedExperimentController,
  type RepeatedExperimentProgress,
} from "./repeated-experiment-controller.client.ts";

export const DEFAULT_REPETITION_COUNT = 5;
export const MIN_REPETITION_COUNT = 2;
export const MAX_REPETITION_COUNT = 100;

export interface RepeatedExperimentDraft {
  plan: RepeatedExperimentPlanV1;
  targetName: string;
  requestSummary: string;
  repetitionCount: number;
  /** Applies the ordinary-run preparation effects only after confirmation. */
  commitPreparation(): void;
}

export interface RepeatedExperimentExecution {
  plan: RepeatedExperimentPlanV1;
  storage: "durable" | "unsaved";
  /** The experiment's original workspace, retained for opening its saved traces. */
  workspace: ProjectWorkspaceHandle | null;
  progress: RepeatedExperimentProgress;
  result?: ExperimentResultV1;
  error?: string;
  traces: ReadonlyMap<RunId, RunTrace>;
  showWorkspace: boolean;
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
function planFor(input: ResolvedRunInput, repetitionCount: number): RepeatedExperimentPlanV1 {
  const frozenInput = structuredClone(input);
  const { runId: _discardedRunId, ...commonInput } = frozenInput;
  const experimentId = createEntityId("experiment", randomUUID());
  return {
    schemaVersion: 1,
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

    const initialProgress: RepeatedExperimentProgress = {
      status: "running",
      requested: pending.plan.cells.length,
      finished: 0,
      states: new Map(),
    };
    setExecution({
      plan: pending.plan,
      storage: workspace ? "durable" : "unsaved",
      workspace,
      progress: initialProgress,
      traces: new Map(),
      showWorkspace: true,
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
        setExecution((current) => current?.plan.experimentId === pending.plan.experimentId
          ? { ...current, progress }
          : current);
      },
      async onTerminalTrace(trace, cell) {
        await persistence?.onTerminalTrace?.(trace, cell);
        setExecution((current) => {
          if (current?.plan.experimentId !== pending.plan.experimentId) return current;
          const traces = new Map(current.traces);
          traces.set(trace.runId, trace);
          return { ...current, traces };
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
      setIsRunning(false);
    }
  }, [draft, options]);

  const cancel = useCallback(() => controllerRef.current?.cancel(), []);

  const openTrace = useCallback((runId: RunId) => {
    const current = execution;
    const trace = current?.traces.get(runId);
    if (!current || !trace) return;
    setExecution((active) => active === current ? { ...active, showWorkspace: false } : active);
    options.onOpenTrace(trace, {
      workspace: current.workspace,
      fileName: traceFileName(trace.runId),
      source: "experiment",
    });
  }, [execution, options]);

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
    clear,
    isRunning,
  };
}
