import type {
  ToolBindingCheckItem,
  ToolBindingCheckResult,
  ToolBindingUnavailableReason,
} from "../../../packages/contracts/src/tool-binding-check.ts";
import type { McpDiscoveryResponse } from "../../../packages/contracts/src/mcp-discovery.ts";
import { isExecutableMcpDeclaration } from "./mcp-server-catalog.ts";
import type { McpServerDeclaration } from "./mcp-server-catalog.ts";

export interface ToolBindingCheckSources {
  mcpServers: readonly McpServerDeclaration[];
  commandIds: readonly string[];
  discover(declaration: McpServerDeclaration): Promise<McpDiscoveryResponse>;
}

const messages: Record<ToolBindingUnavailableReason, string> = {
  declaration_missing: "This service no longer declares what the tool was granted to use.",
  not_executable: "This MCP server is declared for discovery only; this service does not execute its tools.",
  tool_missing: "The MCP server no longer offers this tool.",
  fingerprint_changed: "The MCP tool changed since it was attached.",
  server_unreachable: "The MCP server could not be reached.",
};

function unavailable(toolId: string, reason: ToolBindingUnavailableReason): ToolBindingCheckResult {
  return { toolId, status: "unavailable", reason, message: messages[reason] };
}

/**
 * Answers, for each local grant, whether this host can serve it right now.
 *
 * The same checks an execution makes before sending a call, run ahead of time
 * so a batch can refuse before it spends anything. Each MCP server is
 * discovered once however many of its tools are checked.
 */
export async function checkToolBindings(
  bindings: readonly ToolBindingCheckItem[],
  sources: ToolBindingCheckSources,
): Promise<ToolBindingCheckResult[]> {
  const discoveries = new Map<string, Promise<McpDiscoveryResponse | undefined>>();
  const discoveryFor = (declaration: McpServerDeclaration) => {
    let pending = discoveries.get(declaration.id);
    if (!pending) {
      pending = sources.discover(declaration).catch(() => undefined);
      discoveries.set(declaration.id, pending);
    }
    return pending;
  };

  const results: ToolBindingCheckResult[] = [];
  for (const binding of bindings) {
    if (binding.kind === "command") {
      results.push(sources.commandIds.includes(binding.commandId)
        ? { toolId: binding.toolId, status: "ready" }
        : unavailable(binding.toolId, "declaration_missing"));
      continue;
    }
    const declaration = sources.mcpServers.find(({ id }) => id === binding.serverId);
    if (!declaration) { results.push(unavailable(binding.toolId, "declaration_missing")); continue; }
    if (!isExecutableMcpDeclaration(declaration)) { results.push(unavailable(binding.toolId, "not_executable")); continue; }
    const discovery = await discoveryFor(declaration);
    if (!discovery) { results.push(unavailable(binding.toolId, "server_unreachable")); continue; }
    const tool = discovery.tools.find(({ remoteName }) => remoteName === binding.remoteToolName);
    if (!tool || tool.invalidReason) { results.push(unavailable(binding.toolId, "tool_missing")); continue; }
    results.push(tool.fingerprint === binding.discoveryFingerprint
      ? { toolId: binding.toolId, status: "ready" }
      : unavailable(binding.toolId, "fingerprint_changed"));
  }
  return results;
}
