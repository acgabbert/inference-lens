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
  /**
   * Named when submitting will *run* something instead of sending the text.
   *
   * A mock prefills its answer, so the box already shows what will be sent. An
   * executor with a transport cannot: its answer does not exist yet. Without
   * this, a command-served call looks exactly like a call nobody has answered.
   */
  pendingExecutorLabel?: string;
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
): ToolBinding | undefined {
  return commandBinding ?? toolBindingForMock(toolId, mock);
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
  }
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
 *
 * The session asks a single question — "what binding serves this tool?" — and
 * the answer is composed by the route from the project's mocks and this
 * device's command grants. Which kinds exist is not this module's business,
 * which is what keeps a third kind from arriving here as another parameter.
 */
export function toolResultDraftsForState(
  state: RunState,
  tools: readonly ToolDefinition[],
  bindingForTool: (toolId: ToolDefinition["id"]) => ToolBinding | undefined,
): Record<string, ToolResultDraft> {
  return Object.fromEntries(
    pendingToolCalls(state, tools).map(({ call, tool }) => {
      const binding = tool ? bindingForTool(tool.id) : undefined;
      if (!binding) {
        return [call.id, { text: "", resolution: { kind: "manual" as const } }];
      }
      if (binding.kind === "command") {
        // Nothing to prefill: the command has not run, and inventing a
        // placeholder would be indistinguishable from a result it produced.
        // The empty draft still submits as an execution, and typing into it
        // still makes the answer the user's.
        return [
          call.id,
          {
            text: "",
            prefilledText: "",
            binding,
            pendingExecutorLabel: binding.label ?? binding.executorId,
            resolution: toolResolutionForBinding(binding),
          },
        ];
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
          resolution: toolResolutionForBinding(binding),
        },
      ];
    }),
  );
}
