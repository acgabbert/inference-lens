import type { RunState } from "./run-kernel/types.ts";
import { runMetrics } from "./run-metrics.ts";

export type RunInspectionPhase = "active" | "terminal";
export type RunInspectionStatus =
  | "starting"
  | "running"
  | "waiting_for_tools"
  | "ready_to_continue"
  | "retry_available"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * The compact, provider-neutral projection shown before the detailed run
 * evidence. It is derived from RunState and is never serialized.
 */
export interface RunInspectionSummary {
  phase: RunInspectionPhase;
  status: RunInspectionStatus;
  totalDurationMs?: number;
  ttfoMs?: number;
  totalTokens?: number;
  outputTokensPerSecond?: number;
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function inspectionStatus(state: RunState): RunInspectionStatus {
  switch (state.status.kind) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "awaiting_tool_results":
      return "waiting_for_tools";
    case "paused":
      return state.status.reason === "attempt_failed"
        ? "retry_available"
        : "ready_to_continue";
    case "completed":
    case "cancelled":
    case "failed":
      return state.status.kind;
    case "not_started":
      // The public projection returns before reaching this branch.
      return "starting";
  }
}

/**
 * Returns no summary until a run has actually started. Missing or invalid
 * metrics stay absent so the compact presentation never fabricates values.
 */
export function runInspectionSummary(
  state: RunState | null,
): RunInspectionSummary | null {
  if (!state || state.status.kind === "not_started") return null;

  const metrics = runMetrics(state);
  const terminal =
    state.status.kind === "completed" ||
    state.status.kind === "cancelled" ||
    state.status.kind === "failed";

  return {
    phase: terminal ? "terminal" : "active",
    status: inspectionStatus(state),
    totalDurationMs: finite(metrics.totalDurationMs),
    ttfoMs: finite(metrics.ttfoMs),
    totalTokens: finite(metrics.usage.totalTokens),
    outputTokensPerSecond: finite(metrics.outputTokensPerSecond),
  };
}
