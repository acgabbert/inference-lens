import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import type { McpDiscoveryResponse } from "../../../packages/contracts/src/mcp-discovery.ts";
import type { ToolExecutionContentPart, ToolExecutionFailureKind, ToolExecutionOutcome } from "../../../packages/core/src/run-kernel/types.ts";
import { discoverMcpServer, invokeMcpTool } from "./mcp-discovery.ts";
import type { McpServerDeclaration } from "./mcp-server-catalog.ts";

function failed(kind: ToolExecutionFailureKind, message: string): ToolExecutionOutcome {
  return { status: "failed", failure: { kind, message } };
}

function projectMcpResult(value: Awaited<ReturnType<typeof invokeMcpTool>>): ToolExecutionOutcome {
  if (!Array.isArray(value.content)) return failed("invalid_result", "The MCP server returned no valid content array.");
  const content: ToolExecutionContentPart[] = [];
  for (const part of value.content) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text });
        break;
      case "image":
        content.push({ type: "image", mimeType: part.mimeType, data: part.data });
        break;
      case "audio":
        content.push({ type: "audio", mimeType: part.mimeType, data: part.data });
        break;
      case "resource_link":
        content.push({ type: "resource", uri: part.uri, ...(part.mimeType ? { mimeType: part.mimeType } : {}) });
        break;
      case "resource":
        content.push({ type: "resource", uri: part.resource.uri, ...(part.resource.mimeType ? { mimeType: part.resource.mimeType } : {}) });
        break;
      default:
        return failed("invalid_result", "The MCP server returned an unsupported content type.");
    }
  }
  // The text-compatible content is authoritative when both forms are present;
  // projecting structuredContent as well would send the model the same result twice.
  if (content.length === 0 && value.structuredContent !== undefined) {
    try { content.push({ type: "text", text: JSON.stringify(value.structuredContent) }); }
    catch { return failed("invalid_result", "The MCP structured result cannot be serialized."); }
  }
  return { status: "completed", content, isError: value.isError === true };
}

/** What an execution names; the host resolves everything else from its catalog. */
export interface McpExecutionTarget {
  remoteToolName: string;
  discoveryFingerprint: string;
}

/** Injected by tests; production uses the pooled SDK client. */
export interface McpExecutionDependencies {
  discover(declaration: McpServerDeclaration): Promise<McpDiscoveryResponse>;
  invoke(
    declaration: McpServerDeclaration,
    remoteToolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof invokeMcpTool>>>;
}

const defaultDependencies: McpExecutionDependencies = {
  discover: (declaration) => discoverMcpServer(declaration),
  invoke: invokeMcpTool,
};

/**
 * Validates the live tool, then calls it.
 *
 * Classified by phase: anything that fails before `tools/call` is sent means
 * this binding cannot serve any call, so it is `unavailable`; anything after
 * fails only this call. Message text never decides the class.
 */
export async function executeMcpTool(
  declaration: McpServerDeclaration,
  target: McpExecutionTarget,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  dependencies: McpExecutionDependencies = defaultDependencies,
): Promise<ToolExecutionOutcome> {
  if (signal?.aborted) return failed("cancelled", "The MCP call was cancelled.");
  let discovery: McpDiscoveryResponse;
  try {
    discovery = await dependencies.discover(declaration);
  } catch {
    if (signal?.aborted) return failed("cancelled", "The MCP call was cancelled.");
    return failed("unavailable", "The MCP server could not be reached.");
  }
  const current = discovery.tools.find(({ remoteName }) => remoteName === target.remoteToolName);
  if (!current || current.invalidReason) {
    return failed("unavailable", "The MCP server no longer offers this tool. Refresh discovery and attach it again.");
  }
  if (current.fingerprint !== target.discoveryFingerprint) {
    return failed("unavailable", "The MCP tool changed since it was attached. Review the change and attach it again.");
  }
  try {
    return projectMcpResult(await dependencies.invoke(declaration, target.remoteToolName, args, signal));
  } catch (error) {
    if (signal?.aborted) return failed("cancelled", "The MCP call was cancelled.");
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
      return failed("timeout", "The MCP server did not answer before its call timeout.");
    }
    // SDK errors can contain URLs, headers, or protocol data. The normalized
    // failure must not copy them into a portable trace.
    return failed("execution_failed", "The MCP server could not complete the call.");
  }
}
