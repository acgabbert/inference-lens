import type { CredentialSelection, ProviderTurnTransport } from "../../contracts/src";
import {
  experimentExposedTools,
  experimentTurnCeiling,
  materializeParsedExperimentCellInput,
} from "../../core/src/experiment.ts";
import type { ChatExperimentPlan, ExperimentCell } from "../../core/src/experiment.ts";
import { RunCoordinator } from "../../core/src/run-kernel/index.ts";
import { createRunTrace } from "../../core/src/run-kernel/reducer.ts";
import { createEntityId } from "../../core/src/run-kernel/types.ts";
import type { RunState, RunTrace, TerminalRunStatus } from "../../core/src/run-kernel/index.ts";
import type { ResolvedRunInput } from "../../core/src/run-kernel/types.ts";
import { pendingToolCalls, toolResolutionForBinding } from "../../core/src/tool-binding-resolution.ts";
import { executeToolCall, resolveToolBinding } from "../../core/src/tool-execution.ts";
import type { ToolBinding, ToolExecutor } from "../../core/src/tool-execution.ts";
import type { CellContext, CellExecutor } from "./cell-executor.ts";
import { driveProviderTurn } from "./provider-turn-driver.ts";
import { rateLimitedAttempt } from "./rate-limit-pause.ts";
import { toolResourceKey, ToolResourceLocks } from "./tool-resource-locks.ts";

export interface ChatCellExecutorOptions {
  plan: ChatExperimentPlan;
  transport: ProviderTurnTransport;
  prepareCredential(target: ResolvedRunInput["target"]): Promise<CredentialSelection>;
  toolBindings: readonly ToolBinding[];
  verifyToolBindings?(bindings: readonly ToolBinding[]): Promise<void>;
  createExecutor(binding: ToolBinding): ToolExecutor;
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
 * Runs chat cells: provider turns through the run kernel, with tool calls
 * served from a binding that was resolvable before the first provider call — a
 * repetition never stops to ask a person, because nobody is watching a batch
 * call by call. Calls that reach one MCP server or one declared command never
 * overlap, whichever cells make them.
 */
export class ChatCellExecutor implements CellExecutor<ResolvedRunInput, RunState, RunTrace> {
  private readonly options: ChatCellExecutorOptions;
  private readonly toolLocks = new ToolResourceLocks();

  constructor(options: ChatCellExecutorOptions) {
    this.options = options;
  }

  async prepare(): Promise<ResolvedRunInput[]> {
    const { plan, toolBindings } = this.options;
    // The gate is "every exposed tool can be resolved automatically", not "no
    // tools". The caller's confirmation should have said the same thing already;
    // this refuses out loud rather than starting a batch whose every repetition
    // would stop at a call nobody is present to answer.
    const unbound = experimentExposedTools(plan).filter(
      (tool) => !resolveToolBinding(toolBindings, tool.id),
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
    if (this.options.verifyToolBindings && toolBindings.length > 0) {
      const exposed = new Set(experimentExposedTools(plan).map(({ id }) => id));
      await this.options.verifyToolBindings(
        toolBindings.filter(({ toolId }) => exposed.has(toolId)),
      );
    }
    // A bakeoff is all-or-nothing at its paid boundary. Resolve every distinct
    // local target now, before persisting a plan or starting its first cell.
    const inputs = plan.cells.map((cell) => materializeParsedExperimentCellInput(plan, cell));
    for (const input of inputs) {
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
    return inputs;
  }

  prepareCredential(target: ResolvedRunInput["target"]): Promise<CredentialSelection> {
    return this.options.prepareCredential(target);
  }

  terminalStatus(state: RunState): TerminalRunStatus | undefined {
    return terminalStatus(state);
  }

  trace(state: RunState): RunTrace {
    return createRunTrace(state);
  }

  async execute(
    cell: ExperimentCell,
    input: ResolvedRunInput,
    context: CellContext<RunState>,
  ): Promise<RunState> {
    const coordinator = new RunCoordinator(input);
    let command = coordinator.start();
    const notify = () => context.report(coordinator.state);
    notify();

    const ceiling = experimentTurnCeiling(this.options.plan);
    // One iteration per provider turn. A turn that ends awaiting tool results
    // is served here and continued; anything else leaves the loop and is
    // finalized below, so every exit path still produces a terminal trace.
    for (;;) {
      const outcome = await driveProviderTurn({
        coordinator,
        execution: command.execution,
        transport: this.options.transport,
        prepareCredential: () => context.credential(),
        signal: context.signal,
        onStateChange: (state) => context.report(state),
      });
      if (outcome === "aborted") {
        // The supported transports emit a cancelled event before throwing when
        // this controller's signal is aborted. The signal is aborted only when
        // the whole experiment ends, by cancel() or an interruption, never
        // for one cell. Revisit this if providers gain independent cancellation.
        coordinator.cancel(context.abortReason());
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
        const { status } = coordinator.state;
        const next = await context.afterRateLimit(
          limited.headers,
          (coordinator.state.turns.at(-1)?.attempts.length ?? 1) - 1,
          status.kind === "paused" && status.reason === "attempt_failed",
        );
        if (next === "aborted") {
          coordinator.cancel(context.abortReason());
          break;
        }
        if (next === "retry") {
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
      if (!(await this.serveToolCalls(coordinator, cell, input.tools, context, notify))) break;
      command = coordinator.continue();
      notify();
    }

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
    if (!terminalStatus(coordinator.state)) {
      coordinator.fail({
        code: "internal_error",
        message: "The experiment cell ended without a terminal status.",
      });
    }
    return coordinator.state;
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
    context: CellContext<RunState>,
    notify: () => void,
  ): Promise<boolean> {
    const { signal } = context;
    for (const { call, tool } of pendingToolCalls(coordinator.state, tools)) {
      const binding = tool ? resolveToolBinding(this.options.toolBindings, tool.id) : undefined;
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
            this.options.createExecutor(binding),
            binding,
            { toolCallId: call.id, tool, call },
            { signal },
          );
        }
      } finally {
        release?.();
      }
      notify();
      if (!attempt || context.cancellationRequested() || signal.aborted) {
        // A cancelled execution is the batch ending, not a tool that
        // misbehaved, and the cell has to say so.
        coordinator.cancel(context.abortReason());
        context.requestCancellation();
        return false;
      }
      const execution = coordinator.state.toolExecutions.find(
        ({ id }) => id === attempt.executionId,
      );
      if (attempt.outcome.status === "failed" && attempt.outcome.failure.kind === "unavailable") {
        // The binding cannot serve this call or any later one, so continuing
        // would spend a provider call per repetition to fail the same way.
        // Cells already in flight may find the same thing; the first is the cause.
        context.stop({ reason: "tool_unavailable", cellId: cell.cellId, toolId: tool.id });
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
}
