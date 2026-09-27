import type { McpDiscoveredTool } from "../../packages/contracts/src/mcp-discovery.ts";
import type { ToolDefinition, ToolId } from "../../packages/core/src/run-kernel/types.ts";
import { isValidToolName } from "../../packages/core/src/tool-name.ts";

/** One detached descriptor; no server address or local profile identity. */
export function snapshotMcpTool(
  source: McpDiscoveredTool,
  name: string,
  id: ToolId,
): ToolDefinition {
  if (source.invalidReason || !source.inputSchema || !source.fingerprint) {
    throw new Error("This MCP tool has no attachable schema.");
  }
  if (!isValidToolName(name)) throw new Error("Use a valid function name before attaching this tool.");
  return {
    id,
    name,
    ...(source.description === undefined ? {} : { description: source.description }),
    inputSchema: structuredClone(source.inputSchema),
    source: {
      kind: "mcp",
      remoteToolName: source.remoteName,
      discoveryFingerprint: source.fingerprint,
    },
  };
}
