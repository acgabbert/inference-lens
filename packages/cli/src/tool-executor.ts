import { createMockToolExecutor } from "../../core/src/mock-tool-executor.ts";
import type { ToolExecutionOutcome } from "../../core/src/run-kernel/types.ts";
import type { ToolBinding, ToolExecutor } from "../../core/src/tool-execution.ts";
import { executeCommandTool } from "../../../services/api/src/command-tool-execution.ts";
import { installCommandToolExitHook } from "../../../services/api/src/command-tool-runner.ts";
import { executeMcpTool } from "../../../services/api/src/mcp-execution.ts";
import {
  isExecutableMcpDeclaration,
  readMcpServerCatalog,
} from "../../../services/api/src/mcp-server-catalog.ts";

type Environment = Readonly<Record<string, string | undefined>>;

function failed(kind: "unavailable" | "rejected" | "cancelled", message: string): ToolExecutionOutcome {
  return { status: "failed", failure: { kind, message } };
}

const MAX_MCP_ARGUMENT_BYTES = 1_048_576;

/**
 * The executor factory for the CLI: mocks as everywhere, and granted command
 * and MCP tools run in process through the same service code the app reaches
 * over HTTP. Catalogs are read per call, as the service reads them, so the
 * operator's file stays the ceiling for the whole run.
 */
export function createHeadlessToolExecutor(environment: Environment) {
  return (binding: ToolBinding): ToolExecutor => {
    switch (binding.kind) {
      case "mock":
        return createMockToolExecutor(binding);
      case "command":
        // The CLI handles interrupts itself; the service's own hooks would
        // turn its graceful first interrupt into an immediate exit.
        installCommandToolExitHook();
        return {
          kind: "command",
          async execute(invocation, runtime) {
            if (runtime.signal?.aborted) return failed("cancelled", "The tool execution was cancelled before it began.");
            return executeCommandTool({
              commandId: binding.executorId,
              tool: invocation.tool.name,
              toolCallId: invocation.toolCallId,
              arguments: invocation.call.arguments.text,
            }, { ...(runtime.signal ? { signal: runtime.signal } : {}), environment: { ...environment } });
          },
        };
      case "mcp":
        return {
          kind: "mcp",
          async execute(invocation, runtime) {
            if (runtime.signal?.aborted) return failed("cancelled", "The MCP call was cancelled.");
            const { source } = invocation.tool;
            if (source?.kind !== "mcp" || source.remoteToolName !== binding.remoteToolName ||
                source.discoveryFingerprint !== binding.discoveryFingerprint) {
              return failed("unavailable", "The attached MCP definition no longer matches this permission.");
            }
            let args: unknown;
            try { args = JSON.parse(invocation.call.arguments.text || "{}"); }
            catch { return failed("rejected", "The model supplied invalid JSON tool arguments."); }
            if (!args || typeof args !== "object" || Array.isArray(args)) {
              return failed("rejected", "MCP tool arguments must be an object.");
            }
            if (Buffer.byteLength(JSON.stringify(args)) > MAX_MCP_ARGUMENT_BYTES) {
              return failed("rejected", "MCP arguments exceed the 1 MiB limit.");
            }
            const declaration = readMcpServerCatalog({ ...environment }).servers.find(({ id }) => id === binding.serverId);
            if (!declaration) {
              return failed("unavailable", "This host no longer declares the MCP server this tool was granted to use.");
            }
            if (!isExecutableMcpDeclaration(declaration)) {
              return failed("unavailable", "This MCP server is declared for discovery only; this host does not execute its tools.");
            }
            return executeMcpTool(declaration, binding, args as Record<string, unknown>, runtime.signal);
          },
        };
    }
  };
}
