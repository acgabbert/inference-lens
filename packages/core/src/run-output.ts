import type { RunState } from "./run-kernel/types.ts";

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
