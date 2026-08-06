import type { CredentialSelection, ProviderTurnTransport } from "../../packages/contracts/src";
import {
  experimentExposedTools,
  experimentTurnCeiling,
  materializeParsedExperimentCellInput,
  parseExperimentPlanFile,
  serializeParsedExperimentPlan,
  serializeExperimentResult,
} from "../../packages/core/src/experiment.ts";
import type {
  ExperimentCell,
  ExperimentPlanV4,
  ExperimentResultV4,
} from "../../packages/core/src/experiment.ts";
import { RunCoordinator } from "../../packages/core/src/run-kernel/index.ts";
import { createRunTrace } from "../../packages/core/src/run-kernel/reducer.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/types.ts";
import type { RunState, RunTrace, TerminalRunStatus } from "../../packages/core/src/run-kernel/index.ts";
import type { ResolvedRunInput, RunId } from "../../packages/core/src/run-kernel/types.ts";
import { executeToolCall, resolveToolBinding } from "../../packages/core/src/tool-execution.ts";
import type { ToolBinding, ToolExecutor } from "../../packages/core/src/tool-execution.ts";
import { driveProviderTurn } from "./provider-turn-driver.client.ts";
import { pendingToolCalls, toolResolutionForBinding } from "./run-session-state.client.ts";
import { createToolExecutor } from "./tool-executors.client.ts";

export interface SequentialExperimentProgress {
  status: "running" | "completed" | "cancelled";
  requested: number;
  /** Cells that reached a terminal run status; queued `not-run` cells are excluded. */
  finished: number;
  currentOrdinal?: number;
  /** Started cells only, keyed by their preallocated ordinary run ID. */
  states: ReadonlyMap<RunId, RunState>;
}

export interface SequentialExperimentControllerOptions {
  plan: ExperimentPlanV4;
  transport: ProviderTurnTransport;
  /** Resolves and verifies a local credential before any provider traffic. */
  prepareCredential(target: ResolvedRunInput["target"]): Promise<CredentialSelection>;
  /** Must durably save the plan before resolving. Omit for an ad hoc session experiment. */
  savePlan?(plan: ExperimentPlanV4, serialized: string): Promise<void>;
  /** Must durably save the final result before resolving. Omit for an ad hoc session experiment. */
  saveResult?(result: ExperimentResultV4, serialized: string): Promise<void>;
  onProgress?(progress: SequentialExperimentProgress): void;
  /**
   * Invoked exactly once for every started cell after it reaches a terminal state.
   * A rejection deliberately interrupts the experiment: no later cells start and
   * no result is saved, leaving the durable plan as an interrupted experiment.
   */
  onTerminalTrace?(trace: RunTrace, cell: ExperimentCell): Promise<void> | void;
  /**
   * The device-local bindings that will serve this plan's exposed tools.
   *
   * Joined here rather than written into the plan, exactly as `runtimeTarget`
   * is: the plan snapshots portable descriptors, and how a tool is served on
   * this machine travels nowhere. Every exposed tool must appear here, which is
   * what makes continuation automatic rather than a pause nobody can answer.
   */
  toolBindings?: readonly ToolBinding[];
  /** Injected by tests; the app resolves a binding kind to its executor. */
  createExecutor?(binding: ToolBinding): ToolExecutor;
}

function terminalStatus(state: RunState): TerminalRunStatus | undefined {
  switch (state.status.kind) {
    case "completed":
    case "cancelled":
    case "failed":
      return state.status;
    default:
      return undefined;
  }
}

/**
 * Sequential, non-React execution owner for one already-frozen experiment plan.
 *
 * It deliberately has no automatic retry policy: a retryable attempt is
 * finalized as a failed ordinary run and the next cell proceeds. Tool calls it
 * does serve, but only from a binding that was resolvable before the first
 * provider call — a repetition never stops to ask a person, because nobody is
 * watching a batch call by call.
 */
export class SequentialExperimentController {
  private readonly options: SequentialExperimentControllerOptions;
  private readonly states = new Map<RunId, RunState>();
  private activeAbortController: AbortController | undefined;
  private frozenPlan: ExperimentPlanV4 | undefined;
  private readonly credentials = new Map<string, CredentialSelection>();
  private cancellationRequested = false;
  private running = false;
  private hasRun = false;

  private readonly bindings: readonly ToolBinding[];
  private readonly createExecutor: (binding: ToolBinding) => ToolExecutor;

  constructor(options: SequentialExperimentControllerOptions) {
    this.options = options;
    this.bindings = options.toolBindings ?? [];
    this.createExecutor = options.createExecutor ?? createToolExecutor;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Prevents execution before start, or stops the active request and later cells. */
  cancel(): void {
    if (this.hasRun && !this.running) return;
    this.cancellationRequested = true;
    this.activeAbortController?.abort();
  }

  async run(): Promise<ExperimentResultV4> {
    if (this.running) throw new Error("The experiment is already running.");
    if (this.hasRun) throw new Error("The experiment has already run.");
    // Parse before any observable work, including optional persistence. This
    // keeps durable and ad hoc experiments on the same validation boundary.
    const plan = parseExperimentPlanFile(this.options.plan);
    this.frozenPlan = plan;
    // The gate is "every exposed tool can be resolved automatically", not "no
    // tools". The caller's confirmation should have said the same thing already;
    // this refuses out loud rather than starting a batch whose every repetition
    // would stop at a call nobody is present to answer.
    const unbound = experimentExposedTools(plan).filter(
      (tool) => !resolveToolBinding(this.bindings, tool.id),
    );
    if (unbound.length > 0) {
      throw new Error(
        `No binding on this device can serve ${unbound
          .map(({ name }) => name)
          .join(", ")}. Bind or disable ${
          unbound.length === 1 ? "that tool" : "those tools"
        } before starting.`,
      );
    }
    // A bakeoff is all-or-nothing at its paid boundary. Resolve every distinct
    // local target now, before persisting a plan or starting its first cell.
    for (const cell of plan.cells) {
      const target = materializeParsedExperimentCellInput(plan, cell).target;
      const key = `${target.profileId}\u0000${target.endpoint}`;
      if (!this.credentials.has(key)) {
        this.credentials.set(key, await this.options.prepareCredential(target));
      }
    }

    this.running = true;
    try {
      // This is intentionally awaited before even credential acquisition can begin.
      const serializedPlan = serializeParsedExperimentPlan(plan);
      if (this.options.savePlan) await this.options.savePlan(plan, serializedPlan);
      this.hasRun = true;

      const cells: ExperimentResultV4["cells"] = [];
      this.emitRunning(cells.length);
      for (const cell of plan.cells) {
        if (this.cancellationRequested) break;
        await this.runCell(cell, cells, plan);
        if (this.cancellationRequested) break;
      }

      const cancelled = this.cancellationRequested;
      if (cancelled) {
        for (const cell of plan.cells.slice(cells.length)) {
          cells.push({ cellId: cell.cellId, runId: cell.runId, status: "not-run" });
        }
      }

      const result: ExperimentResultV4 = {
        schemaVersion: 4,
        experimentId: plan.experimentId,
        status: cancelled ? "cancelled" : "completed",
        endedAt: new Date().toISOString(),
        cells,
      };
      // Serialize unconditionally so ad hoc results cross the same strict
      // result-validation boundary as durable results.
      const serializedResult = serializeExperimentResult(result, plan);
      if (this.options.saveResult) await this.options.saveResult(result, serializedResult);
      this.emit({
        status: result.status,
        requested: plan.cells.length,
        finished: this.terminalCellCount(cells),
        states: this.states,
      });
      return result;
    } finally {
      this.activeAbortController = undefined;
      this.running = false;
    }
  }

  private async runCell(
    cell: ExperimentCell,
    cells: ExperimentResultV4["cells"],
    plan: ExperimentPlanV4,
  ): Promise<void> {
    const input = materializeParsedExperimentCellInput(plan, cell);
    const coordinator = new RunCoordinator(input);
    let command = coordinator.start();
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.states.set(input.runId, coordinator.state);
    const notify = () => {
      this.states.set(coordinator.state.runId, coordinator.state);
      this.emitRunning(this.terminalCellCount(cells), cell.ordinal);
    };
    notify();

    if (this.cancellationRequested) {
      coordinator.cancel("Stopped by user.");
    } else {
      const ceiling = experimentTurnCeiling(plan);
      // One iteration per provider turn. A turn that ends awaiting tool results
      // is served here and continued; anything else leaves the loop and is
      // finalized below, so every exit path still produces a terminal trace.
      for (;;) {
        const outcome = await driveProviderTurn({
          coordinator,
          execution: command.execution,
          transport: this.options.transport,
          prepareCredential: () => this.credentialFor(input.target),
          signal: controller.signal,
          onStateChange: (state) => {
            this.states.set(state.runId, state);
            this.emitRunning(this.terminalCellCount(cells), cell.ordinal);
          },
        });
        if (outcome === "aborted") {
          // The supported transports emit a cancelled event before throwing when
          // this controller's signal is aborted. Today this signal is aborted
          // only by cancel(), so an aborted outcome intentionally ends the whole
          // experiment. Revisit this if providers gain independent cancellation.
          coordinator.cancel("Stopped by user.");
          this.cancellationRequested = true;
          break;
        }
        if (outcome === "superseded") {
          coordinator.fail({
            code: "internal_error",
            message: "The experiment request was superseded unexpectedly.",
          });
          break;
        }
        if (coordinator.state.status.kind !== "awaiting_tool_results") break;
        if (coordinator.state.turns.length >= ceiling) {
          // The ceiling is the cost bound the confirmation quoted, so reaching
          // it fails this repetition rather than buying another turn. D4: only
          // this repetition.
          coordinator.fail({
            code: "tool_error",
            message: `This repetition reached its ${ceiling}-turn ceiling with tool calls outstanding.`,
          });
          break;
        }
        if (!(await this.serveToolCalls(coordinator, input.tools, controller.signal, notify))) break;
        command = coordinator.continue();
        notify();
      }
    }
    if (this.activeAbortController === controller) this.activeAbortController = undefined;

    // D4: do not leave a retryable attempt awaiting interactive retry.
    if (coordinator.state.status.kind === "paused" && coordinator.state.status.reason === "attempt_failed") {
      coordinator.fail(coordinator.state.status.error);
    }
    // Every non-terminal exit above records its own failure first; this is the
    // last-resort guard that a repetition can never be left waiting for a person.
    if (
      coordinator.state.status.kind === "awaiting_tool_results" ||
      coordinator.state.status.kind === "paused"
    ) {
      coordinator.fail({
        code: "tool_error",
        message: "The repetition ended waiting for a tool result nobody can supply.",
      });
    }

    const status = terminalStatus(coordinator.state);
    if (!status) {
      coordinator.fail({
        code: "internal_error",
        message: "The experiment cell ended without a terminal status.",
      });
    }
    const terminal = terminalStatus(coordinator.state);
    if (!terminal) throw new Error("The experiment cell could not be finalized.");

    this.states.set(input.runId, coordinator.state);
    cells.push({ cellId: cell.cellId, runId: cell.runId, status: terminal.kind });
    if (terminal.kind === "cancelled") this.cancellationRequested = true;
    this.emitRunning(this.terminalCellCount(cells), cell.ordinal);
    try {
      await this.options.onTerminalTrace?.(createRunTrace(coordinator.state), cell);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      throw new Error(
        `The experiment was interrupted because terminal trace ${cell.runId} could not be saved: ${detail}`,
        { cause: error },
      );
    }
  }

  private credentialFor(target: ResolvedRunInput["target"]): Promise<CredentialSelection> {
    const credential = this.credentials.get(`${target.profileId}\u0000${target.endpoint}`);
    if (!credential) return Promise.reject(new Error(`No prepared credential exists for ${target.profileId}.`));
    return Promise.resolve(credential);
  }

  /**
   * Serves every call one waiting turn is holding, or fails this repetition.
   *
   * Results are supplied one call at a time, matching the interactive session:
   * a failure partway through leaves the calls that already succeeded resolved,
   * where batching would force them to execute a second time. Returning `false`
   * means the run is already terminal — the caller must not continue it.
   */
  private async serveToolCalls(
    coordinator: RunCoordinator,
    tools: ResolvedRunInput["tools"],
    signal: AbortSignal,
    notify: () => void,
  ): Promise<boolean> {
    for (const { call, tool } of pendingToolCalls(coordinator.state, tools)) {
      const binding = tool ? resolveToolBinding(this.bindings, tool.id) : undefined;
      if (!tool || !binding) {
        coordinator.fail({
          code: "tool_error",
          message: tool
            ? `No binding on this device can serve ${call.name}.`
            : `The model called ${call.name}, which this experiment does not expose.`,
        });
        return false;
      }
      const attempt = await executeToolCall(
        coordinator,
        this.createExecutor(binding),
        binding,
        { toolCallId: call.id, tool, call },
        { signal },
      );
      notify();
      if (this.cancellationRequested || signal.aborted) {
        // A cancelled execution is the user stopping the batch, not a tool that
        // misbehaved, and the cell has to say so.
        coordinator.cancel("Stopped by user.");
        this.cancellationRequested = true;
        return false;
      }
      const execution = coordinator.state.toolExecutions.find(
        ({ id }) => id === attempt.executionId,
      );
      if (attempt.outcome.status === "failed" || !execution?.content) {
        coordinator.fail({
          code: "tool_error",
          message: `${call.name} could not be executed: ${
            attempt.outcome.status === "failed"
              ? attempt.outcome.failure.message
              : "The executor returned no content."
          }`,
        });
        return false;
      }
      coordinator.supplyToolResults([
        {
          // Derived rather than random, like the execution ID it answers, so
          // that two runs of one plan produce comparable traces.
          id: createEntityId("tool-result", call.id.slice("tool-call_".length)),
          toolCallId: call.id,
          content: execution.content,
          resolution: toolResolutionForBinding(binding),
          ...(execution.isError ? { isError: true as const } : {}),
        },
      ]);
      notify();
    }
    return true;
  }

  private terminalCellCount(cells: ExperimentResultV4["cells"]): number {
    return cells.filter((cell) => cell.status !== "not-run").length;
  }

  private emitRunning(finished: number, currentOrdinal?: number): void {
    const plan = this.frozenPlan;
    if (!plan) throw new Error("The experiment plan has not been frozen.");
    this.emit({
      status: "running",
      requested: plan.cells.length,
      finished,
      currentOrdinal,
      states: this.states,
    });
  }

  private emit(progress: SequentialExperimentProgress): void {
    this.options.onProgress?.({ ...progress, states: new Map(this.states) });
  }
}
