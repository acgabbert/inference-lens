"use client";

import { useEffect, useMemo, useState } from "react";

import {
  MCP_DISCOVERY_API_PATH,
  MCP_SERVERS_API_PATH,
} from "../../packages/contracts/src/mcp-discovery.ts";
import type {
  McpDiscoveredTool,
  McpDiscoveryResponse,
  McpServerSummary,
  McpServersResponse,
} from "../../packages/contracts/src/mcp-discovery.ts";
import { isValidToolName } from "../../packages/core/src/tool-name.ts";
import { isTauriRuntime } from "../runtime.client.ts";

interface Props {
  onAttachToProject(tool: McpDiscoveredTool, name: string): string | undefined;
  onAttachToRequest(tool: McpDiscoveredTool, name: string): string | undefined;
}

function changedFields(previous: McpDiscoveredTool, current: McpDiscoveredTool): string[] {
  const fields: Array<keyof McpDiscoveredTool> = ["title", "description", "inputSchema", "outputSchema"];
  return fields.filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(current[field]));
}

/** Explicitly connects only after a user chooses a declared host profile. */
export function McpDiscoveryPanel({ onAttachToProject, onAttachToRequest }: Props) {
  const [catalog, setCatalog] = useState<McpServersResponse>();
  const [catalogError, setCatalogError] = useState<string>();
  const [selectedServer, setSelectedServer] = useState<string>("");
  const [discovery, setDiscovery] = useState<McpDiscoveryResponse>();
  const [previous, setPrevious] = useState<McpDiscoveryResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [search, setSearch] = useState("");
  const [aliases, setAliases] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isTauriRuntime()) return;
    let active = true;
    void fetch(MCP_SERVERS_API_PATH, { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`The service answered ${response.status}.`);
        return response.json() as Promise<McpServersResponse>;
      })
      .then((value) => {
        if (!active) return;
        setCatalog(value);
        setSelectedServer(value.servers[0]?.id ?? "");
      })
      .catch((reason: unknown) => {
        if (active) setCatalogError(reason instanceof Error ? reason.message : "The MCP catalog could not be loaded.");
      });
    return () => { active = false; };
  }, []);

  const visibleTools = useMemo(() => discovery?.tools.filter((tool) =>
    `${tool.remoteName} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  ) ?? [], [discovery, search]);
  const previousByName = new Map(previous?.tools.map((tool) => [tool.remoteName, tool]) ?? []);
  const missing = previous && discovery && previous.server.id === discovery.server.id
    ? previous.tools.filter((tool) => !discovery.tools.some((current) => current.remoteName === tool.remoteName))
    : [];

  async function connect(): Promise<void> {
    if (!selectedServer || busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(MCP_DISCOVERY_API_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ serverId: selectedServer }),
      });
      const value = await response.json() as McpDiscoveryResponse & { error?: string };
      if (!response.ok) throw new Error(value.error ?? `Discovery failed (${response.status}).`);
      setPrevious(discovery?.server.id === selectedServer ? discovery : undefined);
      setDiscovery(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP discovery failed.");
    } finally {
      setBusy(false);
    }
  }

  function attach(tool: McpDiscoveredTool, kind: "project" | "request"): void {
    const name = (aliases[tool.remoteName] ?? tool.remoteName).trim();
    const problem = kind === "project"
      ? onAttachToProject(tool, name)
      : onAttachToRequest(tool, name);
    setError(problem);
    setNotice(problem ? undefined : `Attached ${name} to ${kind === "project" ? "the project" : "the next request"} as a snapshot.`);
  }

  if (isTauriRuntime()) return <section aria-label="MCP servers"><h3>MCP servers</h3><p>MCP discovery is available in the service-hosted app.</p></section>;

  return <section aria-label="MCP servers" className="tool-editor">
    <div className="tool-editor-toolbar"><div><span className="eyebrow">External tools</span><h3>MCP servers</h3></div></div>
    <p>Connect to an operator-declared server, inspect its tools, and attach a definition. Attachment does not grant execution.</p>
    {catalogError && <p role="alert">{catalogError}</p>}
    {!catalog && !catalogError && <p>Loading declared servers…</p>}
    {catalog && !catalog.available && <p>{catalog.problem ?? `Set ${catalog.configurationVariable} on the service to declare an MCP server.`}</p>}
    {catalog?.available && catalog.servers.length === 0 && <p>No MCP servers are declared in the catalog.</p>}
    {catalog?.available && catalog.servers.length > 0 && <>
      <div className="tool-fields">
        <label>Declared MCP server
          <select value={selectedServer} onChange={(event) => { setSelectedServer(event.target.value); setDiscovery(undefined); setPrevious(undefined); setAliases({}); setError(undefined); }}>
            {catalog.servers.map((server: McpServerSummary) => <option key={server.id} value={server.id}>{server.label} — {server.endpointIdentity}</option>)}
          </select>
        </label>
        <button className="button secondary" disabled={busy} type="button" onClick={() => void connect()}>{busy ? "Connecting…" : discovery ? "Refresh tools" : "Connect and browse tools"}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {discovery && <>
        <p>Connected to {discovery.serverIdentity.name} {discovery.serverIdentity.version} · MCP {discovery.protocolVersion} · {discovery.tools.length} tools · Refreshed {new Date(discovery.refreshedAt).toLocaleString()}</p>
        <label>Search tools <input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        {missing.length > 0 && <p role="status">No longer advertised: {missing.map((tool) => tool.remoteName).join(", ")}. Attached snapshots stay unchanged.</p>}
        <div className="tool-list">
          {visibleTools.map((tool) => {
            const before = previous?.server.id === discovery.server.id ? previousByName.get(tool.remoteName) : undefined;
            const fields = before && before.fingerprint !== tool.fingerprint ? changedFields(before, tool) : [];
            const name = (aliases[tool.remoteName] ?? tool.remoteName).trim();
            const nameValid = isValidToolName(name);
            const attachable = !tool.invalidReason && nameValid;
            return <article className="tool-editor" key={tool.remoteName}>
              <h4>{tool.title ?? tool.remoteName}</h4>
              {tool.title && <p>Remote name: <code>{tool.remoteName}</code></p>}
              {tool.description && <p>{tool.description}</p>}
              {fields.length > 0 && <p role="status">Changed since last refresh: {fields.join(", ")}. Existing attachments remain unchanged.</p>}
              {tool.invalidReason && <p role="alert">Cannot attach: {tool.invalidReason}</p>}
              <details><summary>Input schema</summary><pre>{JSON.stringify(tool.inputSchema ?? {}, null, 2)}</pre></details>
              {tool.outputSchema && <details><summary>Output schema</summary><pre>{JSON.stringify(tool.outputSchema, null, 2)}</pre></details>}
              {!tool.invalidReason && <>
                <label>Model-visible name <input aria-label={`Model-visible name for ${tool.remoteName}`} value={aliases[tool.remoteName] ?? tool.remoteName} onChange={(event) => setAliases((current) => ({ ...current, [tool.remoteName]: event.target.value }))} /></label>
                {!nameValid && <p>Use 1–64 letters, digits, underscores, or dashes.</p>}
                <div className="tool-header-actions">
                  <button className="button secondary" disabled={!attachable} type="button" onClick={() => attach(tool, "project")}>Attach to project</button>
                  <button className="button secondary" disabled={!attachable} type="button" onClick={() => attach(tool, "request")}>Attach to next request</button>
                </div>
              </>}
            </article>;
          })}
        </div>
      </>}
    </>}
  </section>;
}
