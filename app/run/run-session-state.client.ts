import type { ToolMock } from "../../packages/core/src/project.ts";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";
import type {
  RunState,
  ToolCall,
  ToolDefinition,
  ToolId,
  ToolResult,
} from "../../packages/core/src/run-kernel/index.ts";

/** Kept independent of the renderer so session policy can be tested in Node. */
export type ToolResultDraft = {
  text: string;
  resolution: ToolResult["resolution"];
  /**
   * The binding that can serve this call, and exactly what it prefilled.
   *
   * Both are needed to answer one question at submit time: is this still the
   * executor's answer, or a human's? A draft the user has typed into is a
   * manual result — recording execution evidence for it would claim an
   * executor returned text it never returned.
   */
  binding?: ToolBinding;
  prefilledText?: string;
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
 * The device-local binding an enabled project mock stands for.
 *
 * Mocks live in the project because their *content* is authored material a
 * teammate should receive. The binding is derived rather than stored: there is
 * nothing device-local to remember yet, and a persisted registry holding
 * `{ kind: "mock" }` would have to be revised the moment a command tool needs
 * to keep an executable path out of the project.
 */
export function toolBindingForMock(
  toolId: ToolId,
  mock: ToolMock | undefined,
): ToolBinding | undefined {
  if (!mock?.enabled) return undefined;
  return {
    toolId,
    kind: "mock",
    executorId: mock.id,
    label: mock.name,
    result: {
      content: mock.result.content.map(({ text }) => ({
        type: "text" as const,
        text,
      })),
      ...(mock.result.isError === undefined
        ? {}
        : { isError: mock.result.isError }),
    },
  };
}

/**
 * The binding that may execute this draft, or nothing when the submitted value
 * is the user's rather than the executor's.
 */
export function executableBinding(
  draft: ToolResultDraft,
): ToolBinding | undefined {
  if (!draft.binding) return undefined;
  return draft.text === draft.prefilledText ? draft.binding : undefined;
}

/** The calls one waiting turn still needs results for, with their definitions. */
export function pendingToolCalls(
  state: RunState,
  tools: readonly ToolDefinition[],
): { call: ToolCall; tool?: ToolDefinition }[] {
  if (state.status.kind !== "awaiting_tool_results") return [];
  const waiting = state.status;
  const pending = new Set(waiting.pendingToolCallIds);
  const calls: ToolCall[] =
    state.turns
      .find(({ turnId }) => turnId === waiting.turnId)
      ?.attempts.at(-1)?.completedToolCalls ?? [];
  return calls
    .filter((call) => pending.has(call.id))
    .map((call) => ({
      call,
      tool: tools.find(({ name }) => name === call.name),
    }));
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
  return Object.fromEntries(
    pendingToolCalls(state, tools).map(({ call, tool }) => {
      const binding = tool
        ? toolBindingForMock(tool.id, mockForTool(tool.id))
        : undefined;
      if (!binding) {
        return [call.id, { text: "", resolution: { kind: "manual" as const } }];
      }
      const text = binding.result.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      return [
        call.id,
        {
          text,
          prefilledText: text,
          binding,
          resolution: { kind: "mock" as const, ruleId: binding.executorId },
        },
      ];
    }),
  );
}
