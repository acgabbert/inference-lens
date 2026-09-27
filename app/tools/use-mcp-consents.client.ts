"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";
import type { ToolDefinition, ToolId } from "../../packages/core/src/run-kernel/types.ts";
import type { McpServerSummary } from "../../packages/contracts/src/mcp-discovery.ts";
import { isTauriRuntime } from "../runtime.client.ts";
import {
  localToolGrantCheckItem,
  mcpToolBinding,
  updateLocalToolGrants,
  useLocalToolGrants,
  withLocalToolGrant,
  withoutLocalToolGrant,
} from "./local-tool-grants.client.ts";
import type { McpToolGrant } from "./local-tool-grants.client.ts";
import { checkToolBindingsOnHost } from "./tool-binding-check.client.ts";

export type McpConsentView = McpToolGrant;

export interface McpConsentsHandle {
  servers: McpServerSummary[];
  grants: McpConsentView[];
  error?: string;
  grant(tool: ToolDefinition, serverId: string, mode: McpConsentView["mode"]): Promise<boolean>;
  revoke(toolId: ToolId): Promise<void>;
  bindingFor(tool: ToolDefinition): ToolBinding | undefined;
  grantFor(toolId: ToolId): McpConsentView | undefined;
  /** Interactive approval policy for a granted tool; batches ignore it. */
  approvalModeFor(toolId: ToolId): McpConsentView["mode"] | undefined;
}

/**
 * The MCP permission owner: which declared servers exist, and which attached
 * snapshots the user allowed to call them.
 *
 * Permissions live in the shared local grant record and last until revoked.
 * A new one is checked with the host first, so a snapshot that no longer
 * matches its server is refused when granted rather than when first called.
 */
export function useMcpConsents(): McpConsentsHandle {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [error, setError] = useState<string>();
  const localGrants = useLocalToolGrants();
  const grants = useMemo(
    () => localGrants.filter((grant): grant is McpToolGrant => grant.kind === "mcp"),
    [localGrants],
  );

  useEffect(() => {
    if (isTauriRuntime()) return;
    let active = true;
    void (fetch("/api/mcp/servers").then((response) => response.json()) as Promise<{ servers?: McpServerSummary[] }>)
      .then((catalog) => { if (active) setServers(catalog.servers ?? []); })
      .catch(() => { if (active) setError("Declared MCP servers could not be loaded."); });
    return () => { active = false; };
  }, []);

  const grant = useCallback(async (tool: ToolDefinition, serverId: string, mode: McpConsentView["mode"]): Promise<boolean> => {
    if (tool.source?.kind !== "mcp") return false;
    const candidate: McpToolGrant = {
      kind: "mcp",
      toolId: tool.id,
      serverId,
      remoteToolName: tool.source.remoteToolName,
      discoveryFingerprint: tool.source.discoveryFingerprint,
      mode,
      grantedAt: new Date().toISOString(),
    };
    try {
      const [result] = await checkToolBindingsOnHost([localToolGrantCheckItem(candidate)]);
      if (result?.status !== "ready") {
        throw new Error(result?.message ?? "The MCP permission was refused.");
      }
      updateLocalToolGrants((current) => withLocalToolGrant(current, candidate));
      setError(undefined);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The MCP permission was refused.");
      return false;
    }
  }, []);

  const revoke = useCallback(async (toolId: ToolId): Promise<void> => {
    // Only an MCP grant is this owner's to revoke.
    updateLocalToolGrants((current) => current.some((grant) => grant.toolId === toolId && grant.kind === "mcp")
      ? withoutLocalToolGrant(current, toolId)
      : [...current]);
    setError(undefined);
  }, []);

  return useMemo<McpConsentsHandle>(() => {
    const grantFor = (toolId: ToolId) => grants.find((grant) => grant.toolId === toolId);
    return {
      servers,
      grants,
      ...(error ? { error } : {}),
      grant,
      revoke,
      grantFor,
      bindingFor(tool) {
        const stored = grantFor(tool.id);
        return stored ? mcpToolBinding(stored, tool, servers) : undefined;
      },
      approvalModeFor: (toolId) => grantFor(toolId)?.mode,
    };
  }, [servers, grants, error, grant, revoke]);
}
