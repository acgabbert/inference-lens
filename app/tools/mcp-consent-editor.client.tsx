"use client";

import { useState } from "react";
import type { ToolDefinition } from "../../packages/core/src/run-kernel/types.ts";
import type { McpConsentsHandle } from "./use-mcp-consents.client.ts";

export function McpConsentEditor({ tool, consents }: { tool: ToolDefinition; consents: McpConsentsHandle }) {
  const [selectedServer, setSelectedServer] = useState("");
  const [busy, setBusy] = useState(false);
  if (tool.source?.kind !== "mcp") return null;
  const grant = consents.grantFor(tool.id);
  const current = grant?.remoteToolName === tool.source.remoteToolName &&
    grant.discoveryFingerprint === tool.source.discoveryFingerprint &&
    consents.servers.some(({ id }) => id === grant.serverId);
  const serverId = current ? grant!.serverId : selectedServer || consents.servers[0]?.id || "";
  const label = consents.servers.find(({ id }) => id === serverId)?.label ?? serverId;

  async function choose(mode: "ask" | "automatic") {
    setBusy(true);
    await consents.grant(tool, serverId, mode);
    setBusy(false);
  }

  return <div className="tool-fields" role="group" aria-label={`MCP execution for ${tool.name}`}>
    <strong>MCP execution</strong>
    {current ? <>
      <p>{label} · {grant!.remoteToolName} · {grant!.mode === "automatic" ? "Run automatically" : "Ask each time"}. Permission ends with this service session.</p>
      {grant!.mode === "ask" ?
        <button type="button" className="button secondary" disabled={busy} onClick={() => void choose("automatic")}>Run automatically for this tool</button> :
        <button type="button" className="button secondary" disabled={busy} onClick={() => void choose("ask")}>Ask each time</button>}
      <button type="button" className="text-button" disabled={busy} onClick={() => void consents.revoke(tool.id)}>Remove MCP permission</button>
    </> : <>
      <label>Local MCP server
        <select value={serverId} onChange={(event) => setSelectedServer(event.target.value)}>
          {consents.servers.map((server) => <option key={server.id} value={server.id}>{server.label} — {server.endpointIdentity}</option>)}
        </select>
      </label>
      <button type="button" className="button secondary" disabled={!serverId || busy} onClick={() => void choose("ask")}>Allow execution; ask each time</button>
    </>}
    {consents.error && <p role="alert">{consents.error}</p>}
  </div>;
}
