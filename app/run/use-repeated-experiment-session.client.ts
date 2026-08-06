"use client";

import { useCallback, useRef, useState } from "react";

import type { CredentialSelection, ProviderTurnTransport } from "../../packages/contracts/src/index.ts";
import {
  DEFAULT_EXPERIMENT_TURN_CEILING,
  MAX_EXPERIMENT_TURN_CEILING,
  MIN_EXPERIMENT_TURN_CEILING,
} from "../../packages/core/src/experiment.ts";
import type {
  ExperimentPlanV3,
  ExperimentResultV3,
  RepeatedExperimentPlanV3,
} from "../../packages/core/src/experiment.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/index.ts";
import type {
  ResolvedRunInput,
  RunId,
  RunState,
  RunTrace,
  ToolId,
} from "../../packages/core/src/run-kernel/index.ts";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";
import { randomUUID } from "../../packages/core/src/random-id.ts";
import { runStateFromTrace, traceFileName } from "../../packages/core/src/run-trace.ts";
import type { ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import { createExperimentWorkspacePersistence } from "./experiment-workspace-persistence.client.ts";
import { listExperimentToolBindings } from "./experiment-tool-bindings.client.ts";
import type { ExperimentToolBinding } from "./experiment-tool-bindings.client.ts";
import { SequentialExperimentController } from "./sequential-experiment-controller.client.ts";

export const DEFAULT_REPETITION_COUNT = 5;
export const MIN_REPETITION_COUNT = 2;
export const MAX_REPETITION_COUNT = 100;

/** One exposed tool and what will answer it, for the confirmation listing. */
export type RepeatedExperimentToolBinding = ExperimentToolBinding;

export interface RepeatedExperimentDraft {
  plan: RepeatedExperimentPlanV3;
  /** Original request settings, retained only for per-field comparison/revert. */
  inheritedSettings: RepeatedExperimentSettings;
  targetName: string;
  requestSummary: string;
  repetitionCount: number;
  /**
   * What will serve each exposed tool, resolved when the dialog opened.
   *
   * Shown because grants are keyed by tool ID globally and survive a project
   * re-import: while a person answers each call, a stale grant is inert, but a
   * batch executes it. The moment cost is confirmed is the cheapest place to
   * notice that `get_weather` is about to run a command.
   */
  toolBindings: RepeatedExperimentToolBinding[];
  /** Applies the ordinary-run preparation effects only after confirmation. */
  commitPreparation(): void;
}

/**
 * The inference options a repeated experiment will freeze. An edit here is
 * scoped to the experiment: the plan holds its own copy of the resolved input,
 * so adjusting the model or temperature before starting never rewrites the
 * composer's own settings or the project's defaults.
 */
export interface RepeatedExperimentSettings {
  model: string;
  temperature: number | undefined;
  responseMode: "streaming" | "buffered";
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
  plan: RepeatedExperimentPlanV3;
  storage: "durable" | "unsaved";
  /** The experiment's original workspace, retained for opening its saved traces. */
  workspace: ProjectWorkspaceHandle | null;
  /** Reduced state for every started cell, keyed by its preallocated run ID. */
  states: ReadonlyMap<RunId, RunState>;
  /** Absent once the experiment is terminal, and for every saved experiment. */
  live?: RepeatedExperimentLiveProgress;
  result?: ExperimentResultV3;
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
  /**
   * The device-local binding that serves one tool, composed by the route from
   * this project's mocks and this device's command grants. This is where a
   * portable plan is joined to how its tools are served here.
   */
  bindingForTool(toolId: ToolId): ToolBinding | undefined;
  onTraceSaved(): void;
  onError(message: string): void;
  onOpenTrace(trace: RunTrace, origin: { workspace: ProjectWorkspaceHandle | null; fileName: string; source: "experiment" }): void;
  /**
   * A batch this session started has run to completion. Same contract as the
   * evaluation session's: only this hook can distinguish a batch that just
   * finished from a saved one that was reopened, and an interruption goes to
   * `onError` rather than here.
   */
  onFinished?(outcome: { experimentId: string; repetitions: number }): void;
}

function normalizedCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REPETITION_COUNT;
  return Math.max(MIN_REPETITION_COUNT, Math.min(MAX_REPETITION_COUNT, Math.trunc(value)));
}

function normalizedCeiling(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EXPERIMENT_TURN_CEILING;
  return Math.max(
    MIN_EXPERIMENT_TURN_CEILING,
    Math.min(MAX_EXPERIMENT_TURN_CEILING, Math.trunc(value)),
  );
}

/** Freezes the resolved semantic input and allocates every ordinary run before execution. */
function planFor(
  input: ResolvedRunInput,
  repetitionCount: number,
  turnCeiling: number,
): RepeatedExperimentPlanV3 {
  const frozenInput = structuredClone(input);
  const { runId: discardedRunId, ...commonInput } = frozenInput;
  void discardedRunId;
  const experimentId = createEntityId("experiment", randomUUID());
  return {
    schemaVersion: 4,
    experimentId,
    kind: "repeated-request",
    createdAt: new Date().toISOString(),
    commonInput,
    turnCeiling: normalizedCeiling(turnCeiling),
    cells: Array.from({ length: normalizedCount(repetitionCount) }, (_, index) => ({
      cellId: createEntityId("experiment-cell", randomUUID()),
      ordinal: index + 1,
      runId: createEntityId("run", randomUUID()),
    })),
  };
}

function requestSummary(input: ResolvedRunInput): string {
  const messageCount = input.messages.length;
  return `${messageCount} ${messageCount === 1 ? "message" : "messages"}`;
}

/** Reconstitutes the resolved input a plan froze, so it can be re-planned. */
function sampleInput(plan: RepeatedExperimentPlanV3): ResolvedRunInput {
  return { ...plan.commonInput, runId: plan.cells[0]!.runId };
}

/** The ceiling a draft plan already holds, carried across every re-plan. */
function ceilingOf(plan: RepeatedExperimentPlanV3): number {
  return plan.turnCeiling ?? DEFAULT_EXPERIMENT_TURN_CEILING;
}

/** Owns one repeated-experiment dialog, controller, live evidence, and result. */
export function useRepeatedExperimentSession(options: UseRepeatedExperimentSessionOptions) {
  const [draft, setDraft] = useState<RepeatedExperimentDraft>();
  const [execution, setExecution] = useState<RepeatedExperimentExecution>();
  const [isRunning, setIsRunning] = useState(false);
  const controllerRef = useRef<SequentialExperimentController | undefined>(undefined);

  const { bindingForTool } = options;

  /**
   * Resolves the exposed tools against this device once, when the dialog opens.
   * A grant cannot be made while this modal is up, so the listing the user
   * confirms is the listing the controller will join at start.
   */
  const listBindings = useCallback(
    (plan: RepeatedExperimentPlanV3): RepeatedExperimentToolBinding[] =>
      listExperimentToolBindings(plan.commonInput.tools, bindingForTool),
    [bindingForTool],
  );

  const begin = useCallback((input: ResolvedRunInput, targetName: string, commitPreparation: () => void) => {
    const count = DEFAULT_REPETITION_COUNT;
    const plan = planFor(input, count, DEFAULT_EXPERIMENT_TURN_CEILING);
    setDraft({
      plan,
      inheritedSettings: {
        model: input.target.model,
        temperature: input.options.temperature,
        responseMode: input.responseMode,
      },
      targetName,
      requestSummary: requestSummary(input),
      repetitionCount: count,
      toolBindings: listBindings(plan),
      commitPreparation,
    });
  }, [listBindings]);

  const setRepetitionCount = useCallback((value: number) => {
    setDraft((current) => {
      if (!current) return current;
      const count = normalizedCount(value);
      return {
        ...current,
        plan: planFor(sampleInput(current.plan), count, ceilingOf(current.plan)),
        repetitionCount: count,
      };
    });
  }, []);

  const setTurnCeiling = useCallback((value: number) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        plan: planFor(sampleInput(current.plan), current.repetitionCount, normalizedCeiling(value)),
      };
    });
  }, []);

  /**
   * Repatches the frozen input and re-plans. The plan is the only record of what
   * the repetitions will send, so an option changed here has to be written into
   * it rather than held beside it.
   */
  const updateSettings = useCallback((settings: RepeatedExperimentSettings) => {
    setDraft((current) => {
      if (!current) return current;
      const input = sampleInput(current.plan);
      return {
        ...current,
        plan: planFor(
          {
            ...input,
            target: { ...input.target, model: settings.model },
            responseMode: settings.responseMode,
            options: {
              ...input.options,
              ...(settings.temperature === undefined
                ? { temperature: undefined }
                : { temperature: settings.temperature }),
            },
          },
          current.repetitionCount,
          ceilingOf(current.plan),
        ),
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
    const controller = new SequentialExperimentController({
      plan: pending.plan,
      transport: options.transport,
      prepareCredential: options.prepareCredential,
      // The plan-time join: portable descriptors in the plan, how they are
      // served on this device beside it, never inside it.
      toolBindings: pending.toolBindings.flatMap(({ binding }) => binding ? [binding] : []),
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
      options.onFinished?.({
        experimentId: pending.plan.experimentId,
        repetitions: pending.plan.cells.length,
      });
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
    plan: ExperimentPlanV3;
    result?: ExperimentResultV3;
    traces: ReadonlyMap<RunId, RunTrace>;
    traceFileNames: ReadonlyMap<RunId, string>;
    unreadableTraces: ReadonlyMap<RunId, string>;
  }, workspace: ProjectWorkspaceHandle) => {
    // Replacing the execution under a running controller would strand it, so
    // this refuses out loud rather than dropping the request silently.
    if (controllerRef.current?.isRunning) {
      throw new Error("Stop the running experiment before opening a saved one.");
    }
    if (opened.plan.kind !== "repeated-request") {
      throw new Error("Open evaluation executions from the evaluation results workspace.");
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
    setTurnCeiling,
    updateSettings,
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
