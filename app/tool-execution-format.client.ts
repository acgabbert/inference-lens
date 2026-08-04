"use client";

import type {
  ToolExecutionRecord,
  ToolResult,
} from "../packages/core/src/run-kernel/index.ts";
import { formatDuration } from "./run-metrics-format.client.ts";

/**
 * How one tool execution reads beside its call.
 *
 * Provenance is the whole point of the record: a mocked answer and a real one
 * look identical in the transcript, and the difference decides whether a
 * passing run means anything. So the executor is named, never implied.
 */
export interface ToolExecutionSummary {
  /** Short provenance label for the pill above the result. */
  pill: string;
  /** One line naming what ran and how long it took. */
  detail: string;
  /** Present only when non-text content was replaced by placeholder text. */
  projectionNote?: string;
}

const executorNouns: Record<ToolExecutionRecord["executor"]["kind"], string> = {
  mock: "mock",
  command: "command tool",
  mcp: "MCP server",
};

const failureReasons: Record<
  NonNullable<ToolExecutionRecord["failure"]>["kind"],
  string
> = {
  execution_failed: "Execution failed",
  invalid_result: "Returned an unreadable result",
  timeout: "Timed out",
  cancelled: "Cancelled",
  rejected: "Refused by policy",
};

function executorName(record: ToolExecutionRecord): string {
  const noun = executorNouns[record.executor.kind];
  const label = record.executor.label?.trim();
  return label ? `${noun} “${label}”` : noun;
}

export function describeToolExecution(
  record: ToolExecutionRecord,
): ToolExecutionSummary {
  const name = executorName(record);
  if (record.status === "executing") {
    return { pill: "Executing", detail: `Running ${name}…` };
  }
  // A settled record always carries a duration, so this never renders a dash;
  // formatDuration is shared anyway so the units match the metrics tab.
  const took = `in ${formatDuration(record.durationMs)}`;
  if (record.status === "failed") {
    const failure = record.failure;
    return {
      pill: "Execution failed",
      detail: failure
        ? `${failureReasons[failure.kind]} after running ${name} ${took}. ${failure.message}`
        : `Running ${name} failed ${took}.`,
    };
  }
  const projected = record.projection?.projectedParts ?? [];
  return {
    pill: record.isError ? "Tool reported an error" : `Resolved by ${executorNouns[record.executor.kind]}`,
    detail: `${record.isError ? "Error returned by" : "Returned by"} ${name} ${took}.`,
    ...(projected.length === 0
      ? {}
      : {
          projectionNote: `${projected.length} ${
            projected.length === 1 ? "part was" : "parts were"
          } replaced with placeholder text before the model saw this result: ${projected
            .map(({ placeholder }) => placeholder)
            .join(" ")}`,
        }),
  };
}

/**
 * How a supplied result reads in a finished transcript.
 *
 * This is the surface where the question actually gets asked — someone opens a
 * saved run and wants to know whether a tool result was real. It is derived
 * from the event stream like everything else here, so an imported trace says
 * exactly what the live run said.
 */
export function describeSuppliedToolResult(
  result: ToolResult | undefined,
  execution: ToolExecutionRecord | undefined,
): string {
  if (execution && execution.status !== "executing") {
    return describeToolExecution(execution).detail;
  }
  if (!result) return "";
  switch (result.resolution.kind) {
    case "manual":
      return "Supplied by hand.";
    case "mock":
      return "Supplied from a project mock.";
    case "replay":
      return "Replayed from a recording.";
    case "live":
      return "Returned by a live executor.";
  }
}

/** The latest execution recorded for a call, or nothing if none ran. */
export function latestToolExecution(
  executions: readonly ToolExecutionRecord[],
  toolCallId: string,
): ToolExecutionRecord | undefined {
  return executions.filter((record) => record.toolCallId === toolCallId).at(-1);
}
