"use client";

import { useState } from "react";
import type { ToolDefinition } from "../../packages/core/src/run-kernel/types.ts";
import type { McpConsentsHandle } from "./use-mcp-consents.client.ts";

export function McpConsentEditor({ tool, consents }: { tool: ToolDefinition; consents: McpConsentsHandle }) {
  const [selectedServer, setSelectedServer] = useState("");
  const [busy, setBusy] = useState(false);
  if (tool.source?.kind !== "mcp") return null;
  const grant = consents.grantFor(tool.id);
  const current = Boolean(consents.bindingFor(tool));
  const servers = consents.servers.filter((server) => server.executionAvailable);
  const serverId = current ? grant!.serverId : selectedServer || servers[0]?.id || "";

  async function choose(mode: string) {
    setBusy(true);
    try {
      if (mode === "manual") await consents.revoke(tool.id);
      else await consents.grant(tool, serverId, mode as "ask" | "automatic");
    } finally { setBusy(false); }
  }

  return <div className="tool-fields mcp-execution-controls" role="group" aria-label={`MCP execution for ${tool.name}`}>
    {current ? <small>{consents.servers.find(({ id }) => id === serverId)?.label} · {grant!.remoteToolName}</small> :
      <label>Local MCP server
        <select disabled={busy} value={serverId} onChange={(event) => setSelectedServer(event.target.value)}>
          {!servers.length && <option value="">No executable servers available</option>}
          {servers.map((server) => <option key={server.id} value={server.id}>{server.label} — {server.endpointIdentity}</option>)}
        </select>
      </label>}
    <label>Execution mode
      <select aria-label={`Execution mode for ${tool.name}`} disabled={busy} value={current ? grant!.mode : "manual"} onChange={(event) => void choose(event.target.value)}>
        <option value="manual">Manual results</option>
        <option value="ask" disabled={!serverId}>Ask before running</option>
        <option value="automatic" disabled={!serverId}>Run automatically</option>
      </select>
    </label>
    {consents.error && <p role="alert">{consents.error}</p>}
  </div>;
}
