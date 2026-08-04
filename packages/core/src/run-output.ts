import type { RunState, ToolArguments } from "./run-kernel/types.ts";

/**
 * The one canonical projection of what a run "answered".
 *
 * It is the accumulated assistant text of the last completed attempt of the
 * last turn that produced one. Every consumer that compares, counts, or
 * asserts on a run's answer must use this projection, so an experiment
 * aggregate and a deterministic check can never disagree about what the run
 * said.
 *
 * Deliberate exclusions:
 *
 * - Reasoning is a separate provider channel, not the answer.
 * - Tool-call arguments are structured requests, not assistant text.
 * - Attempts that failed and were retried are excluded; the completed attempt
 *   that replaced them is the one the model finished.
 *
 * `undefined` means the run produced no completed assistant attempt at all.
 * That is distinct from `""`, which is a real, empty answer — a turn that
 * completed with only tool calls, or a provider that returned no text. Callers
 * must preserve that distinction rather than collapsing both to "nothing".
 *
 * This projection makes no claim about whether the run itself succeeded. A
 * cancelled run may still have completed an earlier turn. Callers that require
 * a successful run must check the run's terminal status themselves.
 */
export function finalAssistantOutput(state: RunState): string | undefined {
  for (const turn of [...state.turns].reverse()) {
    const attempt = [...turn.attempts]
      .reverse()
      .find((candidate) => candidate.status === "completed");
    if (attempt) return attempt.text;
  }
  return undefined;
}

/** Counts Unicode code points, so astral characters count once, not twice. */
export function outputCharacterCount(output: string): number {
  return Array.from(output).length;
}

/** One tool call as the check vocabulary is allowed to see it: name and arguments only. */
export interface ToolCallEvidence {
  name: string;
  arguments: ToolArguments;
}

/**
 * The canonical projection of what a run called, in the order the provider
 * emitted the calls: every turn, in order, every completed attempt's
 * completed tool calls, in order. Retried attempts are excluded, mirroring
 * `finalAssistantOutput` — the attempt that replaced them is the one the model
 * finished, and its calls are the ones that actually reached an executor.
 *
 * An empty array is real evidence ("this run made no tool calls"), not a
 * missing-evidence sentinel, so callers never need to distinguish it from
 * "unknown" the way they must for `finalAssistantOutput`'s `undefined`.
 */
export function toolCallsInRun(state: RunState): ToolCallEvidence[] {
  return state.turns.flatMap((turn) =>
    turn.attempts.flatMap((attempt) =>
      (attempt.completedToolCalls ?? []).map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
    ),
  );
}
