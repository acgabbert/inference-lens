import type { CredentialSelection, ProviderTurnTransport } from "../../contracts/src";
import {
  experimentConnectionKey,
  experimentExposedTools,
  experimentTurnCeiling,
  materializeParsedExperimentCellInput,
  noExperimentRetries,
  parseExperimentPlanFile,
  resolveExperimentConcurrency,
  serializeParsedExperimentPlan,
  serializeExperimentResult,
  EXPERIMENT_RESULT_SCHEMA_VERSION,
} from "../../core/src/experiment.ts";
import type {
  ExperimentCell,
  ExperimentConcurrencySetting,
  ExperimentPlanV4,
  ExperimentResult,
  ExperimentRetryPolicy,
  ExperimentStopV6,
} from "../../core/src/experiment.ts";
import { RunCoordinator } from "../../core/src/run-kernel/index.ts";
import { createRunTrace } from "../../core/src/run-kernel/reducer.ts";
import { createEntityId } from "../../core/src/run-kernel/types.ts";
import type { RunState, RunTrace, TerminalRunStatus } from "../../core/src/run-kernel/index.ts";
import type { ResolvedRunInput, RunId } from "../../core/src/run-kernel/types.ts";
import { executeToolCall, resolveToolBinding } from "../../core/src/tool-execution.ts";
import type { ToolBinding, ToolExecutor } from "../../core/src/tool-execution.ts";
import { driveProviderTurn } from "./provider-turn-driver.ts";
import { rateLimitedAttempt, rateLimitPauseMs } from "./rate-limit-pause.ts";
import { systemSchedulerClock } from "./scheduler-clock.ts";
import type { SchedulerClock } from "./scheduler-clock.ts";
import { toolResourceKey, ToolResourceLocks } from "./tool-resource-locks.ts";
import { pendingToolCalls, toolResolutionForBinding } from "../../core/src/tool-binding-resolution.ts";

/** A connection that may not start cells until `until`, after a provider 429. */
export interface ExperimentConnectionPause {
  profileId: ResolvedRunInput["target"]["profileId"];
  endpoint: string;
  /** Epoch milliseconds from the scheduler's clock. */
  until: number;
}

export interface ExperimentProgress {
  status: "running" | ExperimentResult["status"];
  requested: number;
  /** Cells that reached a terminal run status; queued `not-run` cells are excluded. */
  finished: number;
  /**
   * Ordinals of the cells started and not yet terminal, ascending. A cell
   * leaves the set when its run ends, before its trace is saved. With the
   * default limits it holds at most one ordinal.
   */
  runningOrdinals: readonly number[];
  /** Connections in a rate-limit pause, in plan first-use order. Empty once the experiment ends. */
  pausedConnections: readonly ExperimentConnectionPause[];
  /** Started cells only, keyed by their preallocated ordinary run ID. */
  states: ReadonlyMap<RunId, RunState>;
}

export interface ExperimentControllerOptions {
  plan: ExperimentPlanV4;
  transport: ProviderTurnTransport;
  /** Resolves and verifies a local credential before any provider traffic. */
  prepareCredential(target: ResolvedRunInput["target"]): Promise<CredentialSelection>;
  /** Must durably save the plan before resolving. Omit for an ad hoc session experiment. */
  savePlan?(plan: ExperimentPlanV4, serialized: string): Promise<void>;
  /** Must durably save the final result before resolving. Omit for an ad hoc session experiment. */
  saveResult?(result: ExperimentResult, serialized: string): Promise<void>;
  onProgress?(progress: ExperimentProgress): void;
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
  /**
   * Confirms with the host that every binding can still serve, before any plan
   * is saved or provider called. Rejects with a message naming what cannot.
   * A local grant proves only that the user allowed a tool; whether its server
   * or command still exists is the host's to answer.
   */
  verifyToolBindings?(bindings: readonly ToolBinding[]): Promise<void>;
  /**
   * Resolves a binding kind to its executor. Each host supplies its own: the
   * app reaches command and MCP tools through its service, and a host with no
   * such route passes `createMockOnlyToolExecutor`.
   */
  createExecutor(binding: ToolBinding): ToolExecutor;
  /**
   * How many cells may run at once. Omitted, every limit is 1 and cells run
   * one at a time. The result records the limits this resolves to.
   */
  concurrency?: ExperimentConcurrencySetting;
  /**
   * Which failed attempts are retried, and how often per provider turn.
   * Omitted, nothing is retried. The result records the policy.
   */
  retryPolicy?: ExperimentRetryPolicy;
  /** Times rate-limit pauses and retry waits. Defaults to the system clock. */
  clock?: SchedulerClock;
}

type ResultCells = Array<ExperimentResult["cells"][number] | undefined>;

const USER_STOP_REASON = "Stopped by user.";
const INTERRUPTED_REASON = "Stopped because another repetition's trace could not be saved.";

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
 * Non-React execution owner for one already-frozen experiment plan.
 *
 * Cells run up to the configured limits: at most `maxInFlight` at once, and at
 * most each connection's limit on that connection, starting in plan order on
 * each connection as slots free up. With the default limits of 1 it runs one
 * cell at a time. A provider 429 pauses new cells on its connection.
 *
 * A 429 is retried only when the retry policy allows it, after the same wait
 * the pause uses, at most the policy's bound per provider turn. Every other
 * retryable attempt, and a 429 past that bound, is finalized as a failed
 * ordinary run and later cells proceed. Tool calls it
 * does serve, but only from a binding that was resolvable before the first
 * provider call — a repetition never stops to ask a person, because nobody is
 * watching a batch call by call. Calls that reach one MCP server or one
 * declared command never overlap, whichever cells make them.
 */
export class ExperimentController {
  private readonly options: ExperimentControllerOptions;
  private readonly states = new Map<RunId, RunState>();
  /** One per cell in flight; cancellation aborts them all. */
  private readonly cellAbortControllers = new Set<AbortController>();
  /** Aborted on cancellation or interruption, ending any rate-limit pause. */
  private readonly runAbortController = new AbortController();
  private frozenPlan: ExperimentPlanV4 | undefined;
  private readonly credentials = new Map<string, CredentialSelection>();
  private cancellationRequested = false;
  /** Set when a binding turned out unable to serve any later repetition. */
  private stop: ExperimentStopV6 | undefined;
  /** Cells started so far; each cell's start order is this count once it starts. */
  private startedCells = 0;
  /** The first failure that must reject `run()` once every cell has settled. */
  private interruption: Error | undefined;
  /** When each paused connection may start cells again, by connection key. */
  private readonly pausedUntil = new Map<string, number>();
  /** Started cells whose runs are not yet terminal. */
  private readonly runningOrdinals = new Set<number>();
  /** Each connection's identity by key, in plan first-use order. */
  private connections: ReadonlyMap<string, Omit<ExperimentConnectionPause, "until">> = new Map();
  private readonly toolLocks = new ToolResourceLocks();
  private readonly clock: SchedulerClock;
  private readonly retryPolicy: ExperimentRetryPolicy;
  private changed = false;
  /** Terminal cells as last reported, so a pause can be reported between cell updates. */
  private finished = 0;
  private wake: (() => void) | undefined;
  private running = false;
  private hasRun = false;

  private readonly bindings: readonly ToolBinding[];
  private readonly createExecutor: (binding: ToolBinding) => ToolExecutor;

  constructor(options: ExperimentControllerOptions) {
    this.options = options;
    this.bindings = options.toolBindings ?? [];
    this.createExecutor = options.createExecutor;
    this.clock = options.clock ?? systemSchedulerClock;
    this.retryPolicy = options.retryPolicy ?? noExperimentRetries();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Prevents execution before start, or stops every active request and later cells. */
  cancel(): void {
    if (this.hasRun && !this.running) return;
    this.cancellationRequested = true;
    this.abortInFlight();
  }

  async run(): Promise<ExperimentResult> {
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
    if (this.options.verifyToolBindings && this.bindings.length > 0) {
      const exposed = new Set(experimentExposedTools(plan).map(({ id }) => id));
      await this.options.verifyToolBindings(
        this.bindings.filter(({ toolId }) => exposed.has(toolId)),
      );
    }
    // A bakeoff is all-or-nothing at its paid boundary. Resolve every distinct
    // local target now, before persisting a plan or starting its first cell.
    const preflightInputs = plan.cells.map((cell) =>
      materializeParsedExperimentCellInput(plan, cell)
    );
    for (const input of preflightInputs) {
      const { target } = input;
      if (!target.endpoint.trim() || !target.model.trim()) {
        throw new Error(`Configuration target ${target.profileId} is incomplete.`);
      }
      if (input.responseMode === "streaming" && !target.capabilities.streaming) {
        throw new Error(`Configuration target ${target.profileId} does not support streaming.`);
      }
      if (input.tools.length > 0 && !target.capabilities.tools) {
        throw new Error(`Configuration target ${target.profileId} does not support exposed tools.`);
      }
    }
    for (const { target } of preflightInputs) {
      const key = experimentConnectionKey(target);
      if (!this.credentials.has(key)) {
        this.credentials.set(key, await this.options.prepareCredential(target));
      }
    }
    const concurrency = resolveExperimentConcurrency(plan, this.options.concurrency);
    this.connections = new Map(concurrency.connections.map(({ profileId, endpoint }) =>
      [experimentConnectionKey({ profileId, endpoint }), { profileId, endpoint }] as const));

    this.running = true;
    try {
      // This is intentionally awaited before even credential acquisition can begin.
      const serializedPlan = serializeParsedExperimentPlan(plan);
      if (this.options.savePlan) await this.options.savePlan(plan, serializedPlan);
      this.hasRun = true;

      const cells: ResultCells = Array.from({ length: plan.cells.length }, () => undefined);
      this.emitRunning();
      await this.schedule(plan, preflightInputs, concurrency, cells);
      if (this.interruption) throw this.interruption;

      // A user's stop wins over a tool's: both leave later cells unstarted,
      // but the result must not blame a tool for what the user did.
      const cancelled = this.cancellationRequested;
      const stop = cancelled ? undefined : this.stop;
      const result: ExperimentResult = {
        schemaVersion: EXPERIMENT_RESULT_SCHEMA_VERSION,
        experimentId: plan.experimentId,
        status: cancelled ? "cancelled" : stop ? "stopped" : "completed",
        ...(stop ? { stop } : {}),
        endedAt: new Date().toISOString(),
        concurrency,
        retryPolicy: this.retryPolicy,
        // Placed by plan index, so finishing order never reorders them.
        cells: plan.cells.map((cell, index) =>
          cells[index] ?? { cellId: cell.cellId, runId: cell.runId, status: "not-run" }
        ),
      };
      // Serialize unconditionally so ad hoc results cross the same strict
      // result-validation boundary as durable results.
      const serializedResult = serializeExperimentResult(result, plan);
      if (this.options.saveResult) await this.options.saveResult(result, serializedResult);
      this.emit({
        status: result.status,
        requested: plan.cells.length,
        finished: this.terminalCellCount(result.cells),
        runningOrdinals: [],
        pausedConnections: [],
        states: this.states,
      });
      return result;
    } finally {
      this.runAbortController.abort();
      this.cellAbortControllers.clear();
      this.running = false;
    }
  }

  /**
   * Starts cells as slots free up until none is left to start, then waits for
   * every cell in flight to settle. A cell is eligible when the experiment and
   * its connection both have a free slot and its connection is not paused;
   * cells are considered in plan order, so each connection starts its own in
   * plan order. After a cancellation, a stop, or an interruption, nothing new
   * starts, but cells already running are always awaited.
   */
  private async schedule(
    plan: ExperimentPlanV4,
    inputs: readonly ResolvedRunInput[],
    concurrency: ReturnType<typeof resolveExperimentConcurrency>,
    cells: ResultCells,
  ): Promise<void> {
    const limits = new Map(
      concurrency.connections.map((connection) => [experimentConnectionKey(connection), connection.limit]),
    );
    const connectionOf = inputs.map(({ target }) => experimentConnectionKey(target));
    const active = new Map<string, number>();
    const unstarted = plan.cells.map((_cell, index) => index);
    let inFlight = 0;

    for (;;) {
      this.changed = false;
      for (let position = 0; position < unstarted.length && inFlight < concurrency.maxInFlight;) {
        if (this.halted()) break;
        const index = unstarted[position]!;
        const connection = connectionOf[index]!;
        if ((active.get(connection) ?? 0) >= limits.get(connection)! || this.isPaused(connection)) {
          position += 1;
          continue;
        }
        unstarted.splice(position, 1);
        inFlight += 1;
        active.set(connection, (active.get(connection) ?? 0) + 1);
        void this.runCell(plan.cells[index]!, index, inputs[index]!, connection, cells, plan)
          .catch((error: unknown) => this.interrupt(error))
          .finally(() => {
            inFlight -= 1;
            active.set(connection, active.get(connection)! - 1);
            this.notifyChange();
          });
      }
      if (inFlight === 0 && (this.halted() || unstarted.length === 0)) return;
      await this.nextChange();
    }
  }

  private halted(): boolean {
    return this.cancellationRequested || this.stop !== undefined || this.interruption !== undefined;
  }

  private isPaused(connection: string): boolean {
    return (this.pausedUntil.get(connection) ?? 0) > this.clock.now();
  }

  /**
   * Keeps new cells on `connection` from starting for `ms`. A pause only ever
   * lengthens; cancellation ends it, because nothing new starts after that.
   */
  private pauseConnection(connection: string, ms: number): void {
    const until = this.clock.now() + ms;
    if (until <= (this.pausedUntil.get(connection) ?? 0)) return;
    this.pausedUntil.set(connection, until);
    this.emitRunning();
    void this.clock.sleep(ms, this.runAbortController.signal).then(() => {
      // Ended by the timer, not by comparing clocks: a timer may fire a
      // millisecond early, and nothing else would wake the scheduler.
      if (this.pausedUntil.get(connection) !== until) return;
      this.pausedUntil.delete(connection);
      // After the run settles there is nothing left to report a resumption to.
      if (this.running) this.emitRunning();
      this.notifyChange();
    });
  }

  /** Records the first failure, then aborts every cell so `run()` can drain and reject. */
  private interrupt(error: unknown): void {
    if (this.interruption) return;
    this.interruption = error instanceof Error ? error : new Error(String(error));
    this.abortInFlight();
  }

  private abortInFlight(): void {
    for (const controller of this.cellAbortControllers) controller.abort();
    this.runAbortController.abort();
    this.notifyChange();
  }

  /** Why an aborted cell was cancelled. */
  private abortReason(): string {
    return this.interruption && !this.cancellationRequested ? INTERRUPTED_REASON : USER_STOP_REASON;
  }

  private notifyChange(): void {
    this.changed = true;
    this.wake?.();
  }

  /** Resolves on the next cell settling, pause ending, or abort. */
  private nextChange(): Promise<void> {
    if (this.changed) return Promise.resolve();
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = undefined;
        resolve();
      };
    });
  }

  /**
   * Runs one cell to a terminal state and saves its trace. The scheduler only
   * calls this while nothing has halted the experiment, so a cell is never
   * started after a cancellation, stop, or interruption is recorded.
   */
  private async runCell(
    cell: ExperimentCell,
    index: number,
    input: ResolvedRunInput,
    connection: string,
    cells: ResultCells,
    plan: ExperimentPlanV4,
  ): Promise<void> {
    const coordinator = new RunCoordinator(input);
    let command = coordinator.start();
    const startOrder = ++this.startedCells;
    const controller = new AbortController();
    this.cellAbortControllers.add(controller);
    this.states.set(input.runId, coordinator.state);
    this.runningOrdinals.add(cell.ordinal);
    const notify = () => {
      this.states.set(coordinator.state.runId, coordinator.state);
      this.emitRunning(cells);
    };
    notify();

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
          this.emitRunning(cells);
        },
      });
      if (outcome === "aborted") {
        // The supported transports emit a cancelled event before throwing when
        // this controller's signal is aborted. The signal is aborted only when
        // the whole experiment ends, by cancel() or an interruption, never
        // for one cell. Revisit this if providers gain independent cancellation.
        coordinator.cancel(this.abortReason());
        break;
      }
      if (outcome === "superseded") {
        coordinator.fail({
          code: "internal_error",
          message: "The experiment request was superseded unexpectedly.",
        });
        break;
      }
      const limited = rateLimitedAttempt(coordinator.state);
      if (limited) {
        // Keep later cells on this connection from making the limit worse.
        const waitMs = rateLimitPauseMs(limited.headers, this.clock.now());
        this.pauseConnection(connection, waitMs);
        if (this.mayRetryRateLimited(coordinator.state)) {
          // The cell keeps its slot while it waits, and the wait ends early
          // only when the experiment does.
          await this.clock.sleep(waitMs, controller.signal);
          if (controller.signal.aborted) {
            coordinator.cancel(this.abortReason());
            break;
          }
          command = coordinator.retry();
          notify();
          continue;
        }
        // Not retried: this cell fails below, as it always has.
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
      if (!(await this.serveToolCalls(coordinator, cell, input.tools, controller.signal, notify))) break;
      command = coordinator.continue();
      notify();
    }
    this.cellAbortControllers.delete(controller);

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
    cells[index] = { cellId: cell.cellId, runId: cell.runId, status: terminal.kind, startOrder };
    if (terminal.kind === "cancelled" && !this.interruption) this.cancellationRequested = true;
    this.runningOrdinals.delete(cell.ordinal);
    this.emitRunning(cells);
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

  /**
   * Whether the run is paused on a rate-limited attempt its turn still has a
   * retry for. Each provider turn has its own budget.
   */
  private mayRetryRateLimited(state: RunState): boolean {
    if (state.status.kind !== "paused" || state.status.reason !== "attempt_failed") return false;
    const retries = (state.turns.at(-1)?.attempts.length ?? 1) - 1;
    return retries < this.retryPolicy.rateLimited.maxRetries;
  }

  private credentialFor(target: ResolvedRunInput["target"]): Promise<CredentialSelection> {
    const credential = this.credentials.get(experimentConnectionKey(target));
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
    cell: ExperimentCell,
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
      // A stateful resource serves one call at a time across every cell.
      // Only the call holds it, so other cells' provider turns still overlap.
      const resource = toolResourceKey(binding);
      const release = resource ? await this.toolLocks.acquire(resource) : undefined;
      let attempt: Awaited<ReturnType<typeof executeToolCall>> | undefined;
      try {
        if (!signal.aborted) {
          attempt = await executeToolCall(
            coordinator,
            this.createExecutor(binding),
            binding,
            { toolCallId: call.id, tool, call },
            { signal },
          );
        }
      } finally {
        release?.();
      }
      notify();
      if (!attempt || this.cancellationRequested || signal.aborted) {
        // A cancelled execution is the batch ending, not a tool that
        // misbehaved, and the cell has to say so.
        coordinator.cancel(this.abortReason());
        if (!this.interruption) this.cancellationRequested = true;
        return false;
      }
      const execution = coordinator.state.toolExecutions.find(
        ({ id }) => id === attempt.executionId,
      );
      if (attempt.outcome.status === "failed" && attempt.outcome.failure.kind === "unavailable") {
        // The binding cannot serve this call or any later one, so continuing
        // would spend a provider call per repetition to fail the same way.
        // Cells already in flight may find the same thing; the first is the cause.
        this.stop ??= {
          reason: "tool_unavailable",
          cellId: cell.cellId,
          toolId: tool.id,
          startedCells: this.startedCells,
        };
      }
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

  private terminalCellCount(cells: ResultCells | ExperimentResult["cells"]): number {
    return cells.filter((cell) => cell !== undefined && cell.status !== "not-run").length;
  }

  /** Reports running progress; `cells` is the partial result, once any cell has started. */
  private emitRunning(cells?: ResultCells): void {
    const plan = this.frozenPlan;
    if (!plan) throw new Error("The experiment plan has not been frozen.");
    if (cells) this.finished = this.terminalCellCount(cells);
    this.emit({
      status: "running",
      requested: plan.cells.length,
      finished: this.finished,
      runningOrdinals: [...this.runningOrdinals].sort((left, right) => left - right),
      pausedConnections: [...this.connections].flatMap(([key, connection]) => {
        const until = this.pausedUntil.get(key);
        return until === undefined ? [] : [{ ...connection, until }];
      }),
      states: this.states,
    });
  }

  private emit(progress: ExperimentProgress): void {
    this.options.onProgress?.({ ...progress, states: new Map(this.states) });
  }
}
