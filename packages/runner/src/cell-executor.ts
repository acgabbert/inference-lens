import type { CredentialSelection } from "../../contracts/src";
import type { ExperimentCell, ExperimentStop, ExperimentTarget } from "../../core/src/experiment.ts";
import type { TerminalRunStatus } from "../../core/src/run-kernel/index.ts";
import type { RunId } from "../../core/src/run-kernel/types.ts";

/**
 * What the shared scheduler gives one cell while it runs (D49). The scheduler
 * keeps planning order, connection limits, the 429 pause, the retry policy,
 * stop, and result writing; a cell asks it rather than deciding any of them.
 */
export interface CellContext<State> {
  /** Aborted when the experiment ends, by cancellation or interruption, never for one cell. */
  signal: AbortSignal;
  /** The credential prepared for this cell's connection before anything was sent. */
  credential(): Promise<CredentialSelection>;
  /** Publishes the cell's latest state as progress. */
  report(state: State): void;
  /**
   * After an attempt the provider answered 429: pauses new cells on this
   * connection, then says whether the cell may retry. `retry` comes only after
   * the same wait the pause uses, while `retriesSoFar` is within the policy and
   * the attempt is `retryable`; `aborted` means the experiment ended during it.
   */
  afterRateLimit(
    headers: Readonly<Record<string, string>> | undefined,
    retriesSoFar: number,
    retryable: boolean,
  ): Promise<"retry" | "fail" | "aborted">;
  /** Why an aborted cell is cancelled: the user's stop, or another cell's failure. */
  abortReason(): string;
  /** Whether nothing more should start, because the batch was cancelled. */
  cancellationRequested(): boolean;
  /** Ends the batch as cancelled, unless it is already ending for another cell's failure. */
  requestCancellation(): void;
  /** Stops the batch: a tool can serve no later repetition. The first stop wins. */
  stop(stop: ExperimentStop): void;
}

/**
 * Runs one plan kind's cells (D49). Each kind brings its own transport and
 * run model; everything it shares with the other kind stays in the controller.
 */
export interface CellExecutor<Input extends { runId: RunId; target: ExperimentTarget }, State, Trace> {
  /**
   * Every cell's input, in plan order, after the checks that must pass before
   * any plan is saved or provider called. Rejects naming what cannot run.
   */
  prepare(): Promise<Input[]>;
  /** Resolves and verifies the credential for one connection. */
  prepareCredential(target: Input["target"]): Promise<CredentialSelection>;
  /**
   * Runs one cell until it is terminal or cannot go on, reporting its first
   * state synchronously, before anything is awaited.
   */
  execute(cell: ExperimentCell, input: Input, context: CellContext<State>): Promise<State>;
  /** The terminal status of a state `execute` returned, if it is terminal. */
  terminalStatus(state: State): TerminalRunStatus | undefined;
  /** The saved form of a terminal state. */
  trace(state: State): Trace;
}
