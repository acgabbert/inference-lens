import type { ToolMock } from "../packages/core/src/project.ts";
import type {
  RunState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../packages/core/src/run-kernel/index.ts";

/** Kept independent of the renderer so session policy can be tested in Node. */
export type ToolResultDraft = {
  text: string;
  resolution: ToolResult["resolution"];
};

export function isTerminalRunState(state: RunState | null): boolean {
  return Boolean(
    state && ["completed", "cancelled", "failed"].includes(state.status.kind),
  );
}

export function isRetryableRunState(state: RunState | null): boolean {
  return Boolean(
    state?.status.kind === "paused" && state.status.reason === "attempt_failed",
  );
}

/**
 * Produces the editable result values for exactly the calls that are waiting.
 * A mock is selected by the immutable tool definition name, matching the
 * existing request-draft behavior; no mock or React state is mutated here.
 */
export function toolResultDraftsForState(
  state: RunState,
  tools: readonly ToolDefinition[],
  mockForTool: (toolId: ToolDefinition["id"]) => ToolMock | undefined,
): Record<string, ToolResultDraft> {
  if (state.status.kind !== "awaiting_tool_results") return {};
  const waiting = state.status;
  const pending = new Set(waiting.pendingToolCallIds);
  const calls: ToolCall[] =
    state.turns
      .find(({ turnId }) => turnId === waiting.turnId)
      ?.attempts.at(-1)?.completedToolCalls ?? [];

  return Object.fromEntries(
    calls.flatMap((call) => {
      if (!pending.has(call.id)) return [];
      const tool = tools.find(({ name }) => name === call.name);
      const mock = tool ? mockForTool(tool.id) : undefined;
      return [[
        call.id,
        mock?.enabled
          ? {
              text: mock.result.content.map(({ text }) => text).join(""),
              resolution: { kind: "mock" as const, ruleId: mock.id },
            }
          : { text: "", resolution: { kind: "manual" as const } },
      ]];
    }),
  );
}
