import type { ExperimentToolBinding } from "../../packages/core/src/tool-binding-resolution.ts";

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
  if (binding.kind === "mcp") {
    return `MCP "${binding.remoteToolName}" on ${binding.label ?? binding.serverId}`;
  }
  const name = binding.label ?? binding.executorId;
  return binding.kind === "mock" ? `mock "${name}"` : `command "${name}"`;
}
