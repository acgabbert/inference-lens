import type { JsonObject } from "../../core/src/run-kernel/types.ts";

export const MCP_SERVERS_API_PATH = "/api/mcp/servers";
export const MCP_DISCOVERY_API_PATH = "/api/mcp/discovery";

export interface McpServerSummary {
  id: string;
  label: string;
  /** Origin only; no path, query, authorization, or session value. */
  endpointIdentity: string;
}

export interface McpServersResponse {
  available: boolean;
  problem?: string;
  configurationVariable: string;
  servers: McpServerSummary[];
}

export interface McpDiscoveredTool {
  remoteName: string;
  title?: string;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  fingerprint?: string;
  invalidReason?: string;
}

export interface McpDiscoveryResponse {
  server: McpServerSummary;
  serverIdentity: { name: string; version: string };
  protocolVersion: string;
  capabilities: { tools: boolean };
  refreshedAt: string;
  tools: McpDiscoveredTool[];
}
