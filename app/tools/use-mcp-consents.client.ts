"use client";

import { useCallback, useEffect, useState } from "react";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";
import type { ToolDefinition, ToolId } from "../../packages/core/src/run-kernel/types.ts";
import type { McpServerSummary } from "../../packages/contracts/src/mcp-discovery.ts";
import { isTauriRuntime } from "../runtime.client.ts";

export interface McpConsentView {
  toolId: string;
  serverId: string;
  remoteToolName: string;
  discoveryFingerprint: string;
  mode: "ask" | "automatic";
  grantedAt: string;
}

export interface McpConsentsHandle {
  servers: McpServerSummary[];
  grants: McpConsentView[];
  error?: string;
  grant(tool: ToolDefinition, serverId: string, mode: McpConsentView["mode"]): Promise<boolean>;
  revoke(toolId: ToolId): Promise<void>;
  bindingFor(tool: ToolDefinition): ToolBinding | undefined;
  grantFor(toolId: ToolId): McpConsentView | undefined;
}

export function useMcpConsents(): McpConsentsHandle {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [grants, setGrants] = useState<McpConsentView[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (isTauriRuntime()) return;
    let active = true;
    void Promise.all([
      fetch("/api/mcp/servers").then((response) => response.json()) as Promise<{ servers: McpServerSummary[] }>,
      fetch("/api/mcp/grants").then((response) => response.json()) as Promise<{ grants: McpConsentView[] }>,
    ]).then(([catalog, stored]) => {
      if (!active) return;
      setServers(catalog.servers ?? []);
      setGrants(stored.grants ?? []);
    }).catch(() => { if (active) setError("MCP execution permissions could not be loaded."); });
    return () => { active = false; };
  }, []);

  const grant = useCallback(async (tool: ToolDefinition, serverId: string, mode: McpConsentView["mode"]): Promise<boolean> => {
    if (tool.source?.kind !== "mcp") return false;
    try {
      const response = await fetch("/api/mcp/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolId: tool.id, serverId, remoteToolName: tool.source.remoteToolName,
          discoveryFingerprint: tool.source.discoveryFingerprint, mode,
        }),
      });
      const body = await response.json() as { grant?: McpConsentView; error?: string };
      if (!response.ok || !body.grant) throw new Error(body.error ?? "The MCP permission was refused.");
      setGrants((current) => [...current.filter(({ toolId }) => toolId !== tool.id), body.grant!]);
      setError(undefined);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The MCP permission was refused.");
      return false;
    }
  }, []);

  const revoke = useCallback(async (toolId: ToolId): Promise<void> => {
    try {
      const response = await fetch("/api/mcp/grants", {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolId }),
      });
      if (!response.ok) throw new Error("The MCP permission could not be removed.");
      setGrants((current) => current.filter((grant) => grant.toolId !== toolId));
      setError(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The MCP permission could not be removed."); }
  }, []);

  function grantFor(toolId: ToolId): McpConsentView | undefined {
    return grants.find((grant) => grant.toolId === toolId);
  }

  function bindingFor(tool: ToolDefinition): ToolBinding | undefined {
    const stored = grantFor(tool.id);
    if (!stored || tool.source?.kind !== "mcp" ||
        stored.remoteToolName !== tool.source.remoteToolName ||
        stored.discoveryFingerprint !== tool.source.discoveryFingerprint ||
        !servers.some(({ id }) => id === stored.serverId)) return;
    return {
      kind: "mcp", toolId: tool.id,
      executorId: `${stored.remoteToolName}@${stored.discoveryFingerprint.slice(0, 12)}`,
      label: servers.find(({ id }) => id === stored.serverId)?.label,
      serverId: stored.serverId, remoteToolName: stored.remoteToolName,
      discoveryFingerprint: stored.discoveryFingerprint, mode: stored.mode,
    };
  }

  return { servers, grants, error, grant, revoke, bindingFor, grantFor };
}
