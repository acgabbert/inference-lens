import type { ToolDefinition, ToolId } from "../../packages/core/src/run-kernel/index.ts";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";

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
  bindingForTool: (toolId: ToolId) => ToolBinding | undefined,
): ExperimentToolBinding[] {
  return tools.map((tool) => {
    const binding = bindingForTool(tool.id);
    return { tool, ...(binding ? { binding } : {}) };
  });
}

/**
 * Names what will answer one exposed tool, or that nothing can.
 *
 * Shared by the repeated-experiment and evaluation confirmations: both are
 * about to spend money serving tool calls automatically, and the two surfaces
 * must not describe the same binding in two different vocabularies.
 */
export function experimentToolBindingLabel(entry: ExperimentToolBinding): string {
  const { binding } = entry;
  if (!binding) return "nothing on this device";
  const name = binding.label ?? binding.executorId;
  return binding.kind === "mock" ? `mock "${name}"` : `command "${name}"`;
}
