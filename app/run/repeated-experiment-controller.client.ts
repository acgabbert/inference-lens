import type { CredentialSelection, ProviderTurnTransport } from "../../packages/contracts/src";
import {
  materializeExperimentCellInput,
  serializeExperimentPlan,
  serializeExperimentResult,
} from "../../packages/core/src/experiment.ts";
import type {
  ExperimentResultV1,
  RepeatedExperimentCell,
  RepeatedExperimentPlanV1,
} from "../../packages/core/src/experiment.ts";
import { RunCoordinator } from "../../packages/core/src/run-kernel/index.ts";
import { createRunTrace } from "../../packages/core/src/run-kernel/reducer.ts";
import type { RunState, RunTrace, TerminalRunStatus } from "../../packages/core/src/run-kernel/index.ts";
import type { RunId } from "../../packages/core/src/run-kernel/types.ts";
import { driveProviderTurn } from "./provider-turn-driver.client.ts";

export interface RepeatedExperimentProgress {
  status: "running" | "completed" | "cancelled";
  requested: number;
  /** Cells that reached a terminal run status; queued `not-run` cells are excluded. */
  completed: number;
  currentOrdinal?: number;
  /** Started cells only, keyed by their preallocated ordinary run ID. */
  states: ReadonlyMap<RunId, RunState>;
}

export interface RepeatedExperimentControllerOptions {
  plan: RepeatedExperimentPlanV1;
  transport: ProviderTurnTransport;
  prepareCredential(): Promise<CredentialSelection>;
  /** Must durably save the plan before resolving. Omit for an ad hoc session experiment. */
  savePlan?(plan: RepeatedExperimentPlanV1, serialized: string): Promise<void>;
  /** Must durably save the final result before resolving. Omit for an ad hoc session experiment. */
  saveResult?(result: ExperimentResultV1, serialized: string): Promise<void>;
  onProgress?(progress: RepeatedExperimentProgress): void;
  /** Invoked exactly once for every started cell after it reaches a terminal state. */
  onTerminalTrace?(trace: RunTrace, cell: RepeatedExperimentCell): Promise<void> | void;
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
 * Sequential, non-React execution owner for one already-frozen repeated plan.
 * It deliberately has no automatic retry or tool-result policy: a retryable
 * attempt is finalized as a failed ordinary run and the next cell proceeds.
 */
export class RepeatedExperimentController {
  private readonly options: RepeatedExperimentControllerOptions;
  private readonly states = new Map<RunId, RunState>();
  private activeAbortController: AbortController | undefined;
  private cancellationRequested = false;
  private running = false;
  private hasRun = false;

  constructor(options: RepeatedExperimentControllerOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Stops the active request, if any, and prevents all later cells from starting. */
  cancel(): void {
    if (!this.running) return;
    this.cancellationRequested = true;
    this.activeAbortController?.abort();
  }

  async run(): Promise<ExperimentResultV1> {
    if (this.running) throw new Error("The experiment is already running.");
    if (this.hasRun) throw new Error("The experiment has already run.");
    if (this.options.plan.commonInput.tools.length > 0) {
      throw new Error("Repeated experiments do not support tools yet.");
    }

    this.running = true;
    const { plan } = this.options;
    try {
      // This is intentionally awaited before even credential acquisition can begin.
      await this.options.savePlan?.(plan, serializeExperimentPlan(plan));
      this.hasRun = true;

      const cells: ExperimentResultV1["cells"] = [];
      this.emitRunning(cells.length);
      for (const cell of plan.cells) {
        if (this.cancellationRequested) break;
        await this.runCell(cell, cells);
        if (this.cancellationRequested) break;
      }

      const cancelled = this.cancellationRequested;
      if (cancelled) {
        for (const cell of plan.cells.slice(cells.length)) {
          cells.push({ cellId: cell.cellId, runId: cell.runId, status: "not-run" });
        }
      }

      const result: ExperimentResultV1 = {
        schemaVersion: 1,
        experimentId: plan.experimentId,
        status: cancelled ? "cancelled" : "completed",
        endedAt: new Date().toISOString(),
        cells,
      };
      await this.options.saveResult?.(result, serializeExperimentResult(result, plan));
      this.emit({
        status: result.status,
        requested: plan.cells.length,
        completed: this.terminalCellCount(cells),
        states: this.states,
      });
      return result;
    } finally {
      this.activeAbortController = undefined;
      this.running = false;
    }
  }

  private async runCell(
    cell: RepeatedExperimentCell,
    cells: ExperimentResultV1["cells"],
  ): Promise<void> {
    const input = materializeExperimentCellInput(this.options.plan, cell.cellId);
    const coordinator = new RunCoordinator(input);
    const command = coordinator.start();
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.states.set(input.runId, coordinator.state);
    this.emitRunning(this.terminalCellCount(cells), cell.ordinal);

    if (this.cancellationRequested) {
      coordinator.cancel("Stopped by user.");
    } else {
      const outcome = await driveProviderTurn({
        coordinator,
        execution: command.execution,
        transport: this.options.transport,
        prepareCredential: this.options.prepareCredential,
        signal: controller.signal,
        onStateChange: (state) => {
          this.states.set(state.runId, state);
          this.emitRunning(this.terminalCellCount(cells), cell.ordinal);
        },
      });
      if (outcome === "aborted") {
        coordinator.cancel("Stopped by user.");
        this.cancellationRequested = true;
      } else if (outcome === "superseded") {
        coordinator.fail({
          code: "internal_error",
          message: "The repeated experiment request was superseded unexpectedly.",
        });
      }
    }
    if (this.activeAbortController === controller) this.activeAbortController = undefined;

    // D4: do not leave a retryable attempt awaiting interactive retry.
    if (coordinator.state.status.kind === "paused" && coordinator.state.status.reason === "attempt_failed") {
      coordinator.fail(coordinator.state.status.error);
    }
    // D3: the UI blocks tool-bearing plans; retain a terminal trace if a provider
    // nevertheless asks for a tool during this controller's execution.
    if (
      coordinator.state.status.kind === "awaiting_tool_results" ||
      coordinator.state.status.kind === "paused"
    ) {
      coordinator.fail({
        code: "tool_error",
        message: "Repeated experiments do not support manual tool handling.",
      });
    }

    const status = terminalStatus(coordinator.state);
    if (!status) {
      coordinator.fail({
        code: "internal_error",
        message: "The repeated experiment cell ended without a terminal status.",
      });
    }
    const terminal = terminalStatus(coordinator.state);
    if (!terminal) throw new Error("The repeated experiment cell could not be finalized.");

    this.states.set(input.runId, coordinator.state);
    cells.push({ cellId: cell.cellId, runId: cell.runId, status: terminal.kind });
    if (terminal.kind === "cancelled") this.cancellationRequested = true;
    this.emitRunning(this.terminalCellCount(cells), cell.ordinal);
    await this.options.onTerminalTrace?.(createRunTrace(coordinator.state), cell);
  }

  private terminalCellCount(cells: ExperimentResultV1["cells"]): number {
    return cells.filter((cell) => cell.status !== "not-run").length;
  }

  private emitRunning(completed: number, currentOrdinal?: number): void {
    this.emit({
      status: "running",
      requested: this.options.plan.cells.length,
      completed,
      currentOrdinal,
      states: this.states,
    });
  }

  private emit(progress: RepeatedExperimentProgress): void {
    this.options.onProgress?.({ ...progress, states: new Map(this.states) });
  }
}
