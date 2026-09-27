"use client";

import type { ToolExecutionOutcome } from "../../packages/core/src/run-kernel/types.ts";
import type { ToolBindingConfig, ToolExecutor } from "../../packages/core/src/tool-execution.ts";

/**
 * A client of the local service's MCP execution route.
 *
 * It names the declared server, remote tool, and granted fingerprint; the
 * service checks all three against its catalog and the live server before
 * calling. A refusal to serve arrives as an ordinary `unavailable` outcome.
 */
export function createMcpToolExecutor(binding: Extract<ToolBindingConfig, { kind: "mcp" }>): ToolExecutor {
  return {
    kind: "mcp",
    async execute(invocation, runtime): Promise<ToolExecutionOutcome> {
      if (runtime.signal?.aborted) return { status: "failed", failure: { kind: "cancelled", message: "The MCP call was cancelled." } };
      if (invocation.tool.source?.kind !== "mcp" ||
          invocation.tool.source.remoteToolName !== binding.remoteToolName ||
          invocation.tool.source.discoveryFingerprint !== binding.discoveryFingerprint) {
        return { status: "failed", failure: { kind: "unavailable", message: "The attached MCP definition no longer matches this permission." } };
      }
      let args: unknown;
      try { args = JSON.parse(invocation.call.arguments.text || "{}"); }
      catch { return { status: "failed", failure: { kind: "rejected", message: "The model supplied invalid JSON tool arguments." } }; }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { status: "failed", failure: { kind: "rejected", message: "MCP tool arguments must be an object." } };
      }
      try {
        const response = await fetch("/api/mcp/execute", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            toolCallId: invocation.toolCallId,
            serverId: binding.serverId,
            remoteToolName: binding.remoteToolName,
            discoveryFingerprint: binding.discoveryFingerprint,
            arguments: args,
          }),
          signal: runtime.signal,
        });
        const value = await response.json() as ToolExecutionOutcome & { error?: string };
        if (!response.ok) return { status: "failed", failure: { kind: "rejected", message: value.error ?? "The MCP call was refused." } };
        if (value.status !== "completed" && value.status !== "failed") {
          return { status: "failed", failure: { kind: "invalid_result", message: "The service returned an invalid MCP outcome." } };
        }
        return value;
      } catch {
        return { status: "failed", failure: { kind: runtime.signal?.aborted ? "cancelled" : "execution_failed", message: "The local MCP execution service did not answer." } };
      }
    },
  };
}
