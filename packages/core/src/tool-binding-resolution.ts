import type { ToolMock } from "./project.ts";
import type { ToolBinding } from "./tool-execution.ts";
import type {
  RunState,
  ToolCall,
  ToolDefinition,
  ToolId,
  ToolResult,
} from "./run-kernel/index.ts";

/**
 * The device-local binding an enabled project mock stands for.
 *
 * Mocks live in the project because their *content* is authored material a
 * teammate should receive, and their binding stays derived rather than stored:
 * there is nothing device-local about a mock to remember. The command grants
 * in `app/tools/command-tool-bindings.client.ts` are the opposite case, which
 * is why that registry is persisted and this one is not.
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
 * The one binding that serves a tool, from everything that offers to.
 *
 * A granted command outranks an enabled mock. The mock is authored material
 * that travels with the project and is often left switched on; the grant is a
 * deliberate act on this device, naming this tool. Reading it the other way
 * would let a teammate's saved mock quietly outrank a command the user just
 * allowed — and the UI says which one will answer either way.
 */
export function toolBindingFor(
  toolId: ToolId,
  mock: ToolMock | undefined,
  commandBinding: ToolBinding | undefined,
  mcpBinding?: ToolBinding,
): ToolBinding | undefined {
  return mcpBinding ?? commandBinding ?? toolBindingForMock(toolId, mock);
}

/**
 * What a result served by this binding says about where its value came from.
 *
 * Shared by the interactive session and the batch controller so that one run
 * cannot describe a mocked result differently from another. Provenance is
 * project vocabulary and stays separate from the execution evidence beside it:
 * this answers "where did this value come from", not "what ran".
 */
export function toolResolutionForBinding(
  binding: ToolBinding,
): ToolResult["resolution"] {
  switch (binding.kind) {
    case "mock":
      return { kind: "mock", ruleId: binding.executorId };
    case "command":
      return { kind: "live", executorId: binding.executorId };
    case "mcp":
      return { kind: "live", executorId: binding.executorId };
  }
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

/** One exposed tool and what will answer it, for a confirmation listing. */
export interface ExperimentToolBinding {
  tool: ToolDefinition;
  binding?: ToolBinding;
}

/**
 * Resolves a plan's exposed tools against this device once, when a
 * confirmation opens. A grant cannot be made while a modal is up, so the
 * listing the user confirms is the listing the controller joins at start.
 */
export function listExperimentToolBindings(
  tools: readonly ToolDefinition[],
  bindingForTool: (tool: ToolDefinition) => ToolBinding | undefined,
): ExperimentToolBinding[] {
  return tools.map((tool) => {
    const binding = bindingForTool(tool);
    return { tool, ...(binding ? { binding } : {}) };
  });
}
