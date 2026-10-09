import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";
import type {
  RunState,
  ToolDefinition,
  ToolResult,
} from "../../packages/core/src/run-kernel/index.ts";
import {
  pendingToolCalls,
  toolResolutionForBinding,
} from "../../packages/core/src/tool-binding-resolution.ts";

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
  mcpApproval?: { mode: "ask" | "automatic"; approved: boolean; serverLabel: string; remoteToolName: string };
  /** Presentation cue for an MCP snapshot that has no local execution binding. */
  mcpPermissionMissing?: boolean;
  rejectedMcp?: boolean;
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
 * The binding that may execute this draft, or nothing when the submitted value
 * is the user's rather than the executor's.
 */
export function executableBinding(
  draft: ToolResultDraft,
): ToolBinding | undefined {
  if (!draft.binding) return undefined;
  if (draft.binding.kind === "mcp" && !draft.mcpApproval?.approved) return undefined;
  return draft.text === draft.prefilledText ? draft.binding : undefined;
}

/**
 * Produces the editable result values for exactly the calls that are waiting.
 *
 * The session asks a single question — "what binding serves this tool?" — and
 * the answer is composed by the route from the project's mocks and this
 * device's local grants. Which kinds exist is not this module's business,
 * which is what keeps a third kind from arriving here as another parameter.
 */
export function toolResultDraftsForState(
  state: RunState,
  tools: readonly ToolDefinition[],
  bindingForTool: (tool: ToolDefinition) => ToolBinding | undefined,
  /**
   * How a person approves an MCP-served call. Owned by the permission, not the
   * binding; an unknown mode asks, because asking is the safe default.
   */
  mcpApprovalModeFor: (toolId: ToolDefinition["id"]) => "ask" | "automatic" | undefined = () => undefined,
): Record<string, ToolResultDraft> {
  return Object.fromEntries(
    pendingToolCalls(state, tools).map(({ call, tool }) => {
      const binding = tool ? bindingForTool(tool) : undefined;
      if (!binding) {
        return [call.id, {
          text: "", resolution: { kind: "manual" as const },
          ...(tool?.source?.kind === "mcp" ? { mcpPermissionMissing: true } : {}),
        }];
      }
      if (binding.kind === "command" || binding.kind === "mcp") {
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
            ...(binding.kind === "mcp" ? (() => {
              const mode = mcpApprovalModeFor(binding.toolId) ?? "ask";
              return { mcpApproval: {
                mode, approved: mode === "automatic",
                serverLabel: binding.label ?? "Local MCP server", remoteToolName: binding.remoteToolName,
              } };
            })() : {}),
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
