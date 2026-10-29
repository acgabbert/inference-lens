import type { CredentialSelection, DecisionTransport } from "../../contracts/src";
import type { DecisionExecution, DecisionRun, ResolvedDecisionRunInput, ResolvedDecisionTarget } from "../../core/src/decision.ts";
import {
  applyDecisionEvent,
  beginDecisionAttempt,
  createDecisionRun,
  driveDecisionAttempt,
  retryDecisionRun,
  stopDecisionRun,
} from "../../core/src/decision-run.ts";
import { decisionRunTrace } from "../../core/src/decision-trace.ts";
import type { DecisionRunTrace } from "../../core/src/decision-trace.ts";
import { materializeParsedDecisionCellInput } from "../../core/src/experiment.ts";
import type { DecisionEvaluationExperimentPlan, ExperimentCell } from "../../core/src/experiment.ts";
import { isTerminalRunStatus, type TerminalRunStatus } from "../../core/src/run-kernel/index.ts";
import type { CellContext, CellExecutor } from "./cell-executor.ts";

export interface DecisionCellExecutorOptions {
  plan: DecisionEvaluationExperimentPlan;
  transport: DecisionTransport;
  prepareCredential(target: ResolvedDecisionTarget): Promise<CredentialSelection>;
}

function now(): string {
  return new Date().toISOString();
}

/** The last attempt's response headers, when the provider answered it with 429. */
function rateLimitedAttempt(run: DecisionRun): { headers?: Readonly<Record<string, string>> } | undefined {
  const attempt = run.attempts.at(-1);
  if (
    attempt?.status !== "failed" ||
    attempt.error?.code !== "provider_error" ||
    attempt.error.providerStatus !== 429
  ) {
    return undefined;
  }
  return { headers: run.exchanges[attempt.exchangeId]?.response?.headers };
}

/**
 * Runs decision cells (D49): each is one exchange through the core
 * transitions (D27), with a 429 retried through the batch's policy and wait
 * (D23). A run never ends paused: whatever the policy does not retry ends as
 * failed with its attempt's error, as Stop ends a paused run (D22).
 */
export class DecisionCellExecutor implements CellExecutor<ResolvedDecisionRunInput, DecisionRun, DecisionRunTrace> {
  private readonly options: DecisionCellExecutorOptions;

  constructor(options: DecisionCellExecutorOptions) {
    this.options = options;
  }

  async prepare(): Promise<ResolvedDecisionRunInput[]> {
    const { plan } = this.options;
    const inputs = plan.cells.map((cell) => materializeParsedDecisionCellInput(plan, cell));
    for (const { target } of inputs) {
      if (!target.endpoint.trim() || !target.model.trim()) {
        throw new Error(`Configuration target ${target.profileId} is incomplete.`);
      }
    }
    return inputs;
  }

  prepareCredential(target: ResolvedDecisionTarget): Promise<CredentialSelection> {
    return this.options.prepareCredential(target);
  }

  terminalStatus(run: DecisionRun): TerminalRunStatus | undefined {
    return isTerminalRunStatus(run.status) ? run.status : undefined;
  }

  trace(run: DecisionRun): DecisionRunTrace {
    return decisionRunTrace(run);
  }

  async execute(
    _cell: ExperimentCell,
    input: ResolvedDecisionRunInput,
    context: CellContext<DecisionRun>,
  ): Promise<DecisionRun> {
    let { run, execution }: { run: DecisionRun; execution: DecisionExecution } =
      beginDecisionAttempt(createDecisionRun(input), now());
    context.report(run);

    for (;;) {
      const attempt = await driveDecisionAttempt({
        run,
        execution,
        signal: context.signal,
        onRunChange: (next) => context.report(next),
        open: async (current, signal) => {
          const credential = await context.credential();
          const stream = await this.options.transport.executeDecision({ execution: current, credential }, signal);
          return stream.events;
        },
      });
      run = attempt.run;
      if (attempt.outcome !== "settled") {
        // Only the whole experiment ending aborts a cell, as for chat.
        run = run.status.kind === "running"
          ? applyDecisionEvent(run, { type: "cancelled", reason: context.abortReason() }, now())
          : stopDecisionRun(run, now());
        break;
      }
      const limited = rateLimitedAttempt(run);
      if (!limited) break;
      const next = await context.afterRateLimit(
        limited.headers,
        run.attempts.length - 1,
        run.status.kind === "paused",
      );
      if (next !== "retry") break;
      ({ run, execution } = retryDecisionRun(run, now()));
      context.report(run);
    }

    // D4: a batch never leaves a retryable failure waiting for a person.
    if (run.status.kind === "paused") run = stopDecisionRun(run, now());
    return run;
  }
}
