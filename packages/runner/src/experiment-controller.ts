import type { CredentialSelection, DecisionTransport, ProviderTurnTransport } from "../../contracts/src";
import type { DecisionRun, ResolvedDecisionTarget } from "../../core/src/decision.ts";
import type { DecisionRunTrace } from "../../core/src/decision-trace.ts";
import {
  experimentConnectionKey,
  noExperimentRetries,
  parseExperimentPlanFile,
  resolveExperimentConcurrency,
  serializeParsedExperimentPlan,
  serializeExperimentResult,
  EXPERIMENT_RESULT_SCHEMA_VERSION,
} from "../../core/src/experiment.ts";
import type {
  ChatExperimentPlan,
  DecisionEvaluationExperimentPlan,
  ExperimentCell,
  ExperimentConcurrencySetting,
  ExperimentPlan,
  ExperimentResult,
  ExperimentRetryPolicy,
  ExperimentStopV6,
  ExperimentTarget,
} from "../../core/src/experiment.ts";
import type { RunState, RunTrace } from "../../core/src/run-kernel/index.ts";
import type { ResolvedRunInput, RunId } from "../../core/src/run-kernel/types.ts";
import type { ToolBinding, ToolExecutor } from "../../core/src/tool-execution.ts";
import type { CellContext, CellExecutor } from "./cell-executor.ts";
import { ChatCellExecutor } from "./chat-cell-executor.ts";
import { DecisionCellExecutor } from "./decision-cell-executor.ts";
import { rateLimitPauseMs } from "./rate-limit-pause.ts";
import { systemSchedulerClock } from "./scheduler-clock.ts";
import type { SchedulerClock } from "./scheduler-clock.ts";

/** A connection that may not start cells until `until`, after a provider 429. */
export interface ExperimentConnectionPause {
  profileId: ResolvedRunInput["target"]["profileId"];
  endpoint: string;
  /** Epoch milliseconds from the scheduler's clock. */
  until: number;
}

/** A batch's progress; `State` is its plan kind's run state, chat's by default. */
export interface ExperimentProgress<State = RunState> {
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
  states: ReadonlyMap<RunId, State>;
}

/** What every plan kind's controller takes. */
interface ExperimentControllerBaseOptions<Plan extends ExperimentPlan, Target extends ExperimentTarget, State, Trace> {
  plan: Plan;
  /** Resolves and verifies a local credential before any provider traffic. */
  prepareCredential(target: Target): Promise<CredentialSelection>;
  /** Must durably save the plan before resolving. Omit for an ad hoc session experiment. */
  savePlan?(plan: ExperimentPlan, serialized: string): Promise<void>;
  /** Must durably save the final result before resolving. Omit for an ad hoc session experiment. */
  saveResult?(result: ExperimentResult, serialized: string): Promise<void>;
  onProgress?(progress: ExperimentProgress<State>): void;
  /**
   * Invoked exactly once for every started cell after it reaches a terminal state.
   * A rejection deliberately interrupts the experiment: no later cells start and
   * no result is saved, leaving the durable plan as an interrupted experiment.
   */
  onTerminalTrace?(trace: Trace, cell: ExperimentCell): Promise<void> | void;
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

/** A repeated request or a chat evaluation, run through provider turns. */
export interface ChatExperimentControllerOptions
  extends ExperimentControllerBaseOptions<ChatExperimentPlan, ResolvedRunInput["target"], RunState, RunTrace> {
  transport: ProviderTurnTransport;
  decisionTransport?: never;
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
}

/** A decision evaluation (D49), run through the decision transport. Tools never apply. */
export interface DecisionExperimentControllerOptions
  extends ExperimentControllerBaseOptions<DecisionEvaluationExperimentPlan, ResolvedDecisionTarget, DecisionRun, DecisionRunTrace> {
  decisionTransport: DecisionTransport;
  transport?: never;
}

/** The options for a controller whose cells produce `State`. */
export type ExperimentControllerOptions<State extends RunState | DecisionRun = RunState> =
  [State] extends [DecisionRun] ? DecisionExperimentControllerOptions : ChatExperimentControllerOptions;

type TraceOf<State> = [State] extends [DecisionRun] ? DecisionRunTrace : RunTrace;

type ResultCells = Array<ExperimentResult["cells"][number] | undefined>;

/** One cell's materialized input, of either kind. */
type CellInput = { runId: RunId; target: ExperimentTarget };

const USER_STOP_REASON = "Stopped by user.";
const INTERRUPTED_REASON = "Stopped because another repetition's trace could not be saved.";

/**
 * Non-React execution owner for one already-frozen experiment plan, of either
 * run kind. `State` is the kind's run state; chat's is the default, and a
 * decision batch is `new ExperimentController<DecisionRun>(…)`.
 *
 * Cells run up to the configured limits: at most `maxInFlight` at once, and at
 * most each connection's limit on that connection, starting in plan order on
 * each connection as slots free up. With the default limits of 1 it runs one
 * cell at a time. A provider 429 pauses new cells on its connection.
 *
 * A 429 is retried only when the retry policy allows it, after the same wait
 * the pause uses, at most the policy's bound per provider turn. Every other
 * retryable attempt, and a 429 past that bound, is finalized as a failed
 * ordinary run and later cells proceed. What one cell does between those
 * decisions belongs to its kind's executor (D49): chat serves tool calls,
 * decision sends one exchange.
 */
export class ExperimentController<State extends RunState | DecisionRun = RunState> {
  private readonly options: ExperimentControllerOptions<State>;
  private readonly hooks: ExperimentControllerBaseOptions<ExperimentPlan, ExperimentTarget, State, TraceOf<State>>;
  private readonly states = new Map<RunId, State>();
  /** One per cell in flight; cancellation aborts them all. */
  private readonly cellAbortControllers = new Set<AbortController>();
  /** Aborted on cancellation or interruption, ending any rate-limit pause. */
  private readonly runAbortController = new AbortController();
  private frozenPlan: ExperimentPlan | undefined;
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
  private readonly clock: SchedulerClock;
  private readonly retryPolicy: ExperimentRetryPolicy;
  private changed = false;
  /** Terminal cells as last reported, so a pause can be reported between cell updates. */
  private finished = 0;
  private wake: (() => void) | undefined;
  private running = false;
  private hasRun = false;

  constructor(options: ExperimentControllerOptions<State>) {
    this.options = options;
    // Both option arms share these, typed by the kind this controller runs.
    this.hooks = options as unknown as ExperimentControllerBaseOptions<ExperimentPlan, ExperimentTarget, State, TraceOf<State>>;
    this.clock = this.hooks.clock ?? systemSchedulerClock;
    this.retryPolicy = this.hooks.retryPolicy ?? noExperimentRetries();
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
    const plan = parseExperimentPlanFile(this.hooks.plan);
    this.frozenPlan = plan;
    const executor = this.executorFor(plan);
    const inputs = await executor.prepare();
    for (const { target } of inputs) {
      const key = experimentConnectionKey(target);
      if (!this.credentials.has(key)) {
        this.credentials.set(key, await executor.prepareCredential(target));
      }
    }
    const concurrency = resolveExperimentConcurrency(plan, this.hooks.concurrency);
    this.connections = new Map(concurrency.connections.map(({ profileId, endpoint }) =>
      [experimentConnectionKey({ profileId, endpoint }), { profileId, endpoint }] as const));

    this.running = true;
    try {
      // This is intentionally awaited before even credential acquisition can begin.
      const serializedPlan = serializeParsedExperimentPlan(plan);
      if (this.hooks.savePlan) await this.hooks.savePlan(plan, serializedPlan);
      this.hasRun = true;

      const cells: ResultCells = Array.from({ length: plan.cells.length }, () => undefined);
      this.emitRunning();
      await this.schedule(plan, executor, inputs, concurrency, cells);
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
      if (this.hooks.saveResult) await this.hooks.saveResult(result, serializedResult);
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

  /** The plan kind's executor, refusing a plan the options cannot run. */
  private executorFor(plan: ExperimentPlan): CellExecutor<CellInput, State, TraceOf<State>> {
    const options = this.options as ChatExperimentControllerOptions | DecisionExperimentControllerOptions;
    if (plan.kind === "decision-evaluation") {
      if (!options.decisionTransport) {
        throw new Error("A decision evaluation runs through a decision transport, which this controller was not given.");
      }
      return new DecisionCellExecutor({
        plan,
        transport: options.decisionTransport,
        prepareCredential: (target) => (options as DecisionExperimentControllerOptions).prepareCredential(target),
      }) as unknown as CellExecutor<CellInput, State, TraceOf<State>>;
    }
    if (!options.transport) {
      throw new Error("A chat experiment runs through a provider turn transport, which this controller was not given.");
    }
    const chat = options as ChatExperimentControllerOptions;
    return new ChatCellExecutor({
      plan,
      transport: chat.transport,
      prepareCredential: (target) => chat.prepareCredential(target),
      toolBindings: chat.toolBindings ?? [],
      ...(chat.verifyToolBindings ? { verifyToolBindings: (bindings) => chat.verifyToolBindings!(bindings) } : {}),
      createExecutor: (binding) => chat.createExecutor(binding),
    }) as unknown as CellExecutor<CellInput, State, TraceOf<State>>;
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
    plan: ExperimentPlan,
    executor: CellExecutor<CellInput, State, TraceOf<State>>,
    inputs: readonly CellInput[],
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
        void this.runCell(executor, plan.cells[index]!, index, inputs[index]!, connection, cells)
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
    executor: CellExecutor<CellInput, State, TraceOf<State>>,
    cell: ExperimentCell,
    index: number,
    input: CellInput,
    connection: string,
    cells: ResultCells,
  ): Promise<void> {
    const startOrder = ++this.startedCells;
    const controller = new AbortController();
    this.cellAbortControllers.add(controller);
    this.runningOrdinals.add(cell.ordinal);
    const context: CellContext<State> = {
      signal: controller.signal,
      credential: () => this.credentialFor(input.target),
      report: (state) => {
        this.states.set(input.runId, state);
        this.emitRunning(cells);
      },
      afterRateLimit: async (headers, retriesSoFar, retryable) => {
        // Keep later cells on this connection from making the limit worse.
        const waitMs = rateLimitPauseMs(headers, this.clock.now());
        this.pauseConnection(connection, waitMs);
        if (!retryable || retriesSoFar >= this.retryPolicy.rateLimited.maxRetries) return "fail";
        // The cell keeps its slot while it waits, and the wait ends early
        // only when the experiment does.
        await this.clock.sleep(waitMs, controller.signal);
        return controller.signal.aborted ? "aborted" : "retry";
      },
      abortReason: () => this.abortReason(),
      cancellationRequested: () => this.cancellationRequested,
      requestCancellation: () => {
        if (!this.interruption) this.cancellationRequested = true;
      },
      stop: (stop) => {
        this.stop ??= { ...stop, startedCells: this.startedCells };
      },
    };

    const state = await executor.execute(cell, input, context);
    this.cellAbortControllers.delete(controller);
    const terminal = executor.terminalStatus(state);
    if (!terminal) throw new Error("The experiment cell could not be finalized.");

    this.states.set(input.runId, state);
    cells[index] = { cellId: cell.cellId, runId: cell.runId, status: terminal.kind, startOrder };
    if (terminal.kind === "cancelled" && !this.interruption) this.cancellationRequested = true;
    this.runningOrdinals.delete(cell.ordinal);
    this.emitRunning(cells);
    try {
      await this.hooks.onTerminalTrace?.(executor.trace(state), cell);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      throw new Error(
        `The experiment was interrupted because terminal trace ${cell.runId} could not be saved: ${detail}`,
        { cause: error },
      );
    }
  }

  private credentialFor(target: ExperimentTarget): Promise<CredentialSelection> {
    const credential = this.credentials.get(experimentConnectionKey(target));
    if (!credential) return Promise.reject(new Error(`No prepared credential exists for ${target.profileId}.`));
    return Promise.resolve(credential);
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

  private emit(progress: ExperimentProgress<State>): void {
    this.hooks.onProgress?.({ ...progress, states: new Map(this.states) });
  }
}
