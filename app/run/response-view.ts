import type {
  RunState,
  ToolCall,
} from "../../packages/core/src/run-kernel/index.ts";

export type DisplayStatus = "idle" | "running" | "waiting" | "complete" | "failed";

/**
 * What the response pane shows for a run: the latest attempt of each turn,
 * joined. Superseded attempts are trace evidence, not live output.
 */
export interface ResponseContent {
  output: string;
  reasoning: string;
  status: DisplayStatus;
  completedToolCalls: ToolCall[];
}

export function displayStatus(state: RunState | null): DisplayStatus {
  if (!state) return "idle";
  switch (state.status.kind) {
    case "completed":
      return "complete";
    case "awaiting_tool_results":
      return "waiting";
    case "paused":
      return state.status.reason === "attempt_failed" ? "failed" : "waiting";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "running";
  }
}

export function responseContentOf(state: RunState | null): ResponseContent {
  const attempts =
    state?.turns.flatMap((turn) => {
      const latest = turn.attempts.at(-1);
      return latest ? [latest] : [];
    }) ?? [];
  return {
    output: attempts.map((attempt) => attempt.text).join(""),
    reasoning: attempts.map((attempt) => attempt.reasoning).join(""),
    status: displayStatus(state),
    completedToolCalls: attempts.flatMap((attempt) => attempt.completedToolCalls ?? []),
  };
}
