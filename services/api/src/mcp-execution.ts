import type { ToolExecutionContentPart, ToolExecutionOutcome } from "../../../packages/core/src/run-kernel/types.ts";
import { discoverMcpServer, invokeMcpTool } from "./mcp-discovery.ts";
import type { McpServerDeclaration } from "./mcp-server-catalog.ts";
import type { McpConsent } from "./mcp-consent.ts";

function failed(kind: "rejected" | "execution_failed" | "invalid_result" | "timeout" | "cancelled", message: string): ToolExecutionOutcome {
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

export async function executeMcpTool(
  declaration: McpServerDeclaration,
  consent: McpConsent,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionOutcome> {
  if (signal?.aborted) return failed("cancelled", "The MCP call was cancelled.");
  try {
    const discovery = await discoverMcpServer(declaration);
    const current = discovery.tools.find(({ remoteName }) => remoteName === consent.remoteToolName);
    if (!current || current.invalidReason || current.fingerprint !== consent.discoveryFingerprint) {
      return failed("rejected", "The MCP tool changed or is no longer available. Review and grant it again.");
    }
    return projectMcpResult(await invokeMcpTool(declaration, consent.remoteToolName, args, signal));
  } catch (error) {
    if (signal?.aborted) return failed("cancelled", "The MCP call was cancelled.");
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("timeout") || message.includes("timed out")) {
      return failed("timeout", "The MCP server did not answer before its call timeout.");
    }
    // SDK errors can contain URLs, headers, or protocol data. The normalized
    // failure must not copy them into a portable trace.
    return failed("execution_failed", "The MCP server could not complete the call.");
  }
}
