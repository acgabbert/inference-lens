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

export type McpAttachmentMode = "ask" | "automatic" | "manual";
interface Props {
  onAttach(tool: McpDiscoveredTool, name: string, destination: "project" | "request", serverId: string, mode: McpAttachmentMode): Promise<string | undefined>;
  attachedNames: string[];
}

function changedFields(previous: McpDiscoveredTool, current: McpDiscoveredTool): string[] {
  const fields: Array<keyof McpDiscoveredTool> = ["title", "description", "inputSchema", "outputSchema"];
  return fields.filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(current[field]));
}

/** Explicitly connects only after a user chooses a declared host profile. */
export function McpDiscoveryPanel({ onAttach, attachedNames }: Props) {
  const [selection, setSelection] = useState<string[]>([]);
  const [destination, setDestination] = useState<"project" | "request">("request");
  const [mode, setMode] = useState<McpAttachmentMode>("ask");
  const [attaching, setAttaching] = useState(false);
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

  async function attach(): Promise<void> {
    if (!discovery || attaching) return;
    const names = selection.map((remoteName) => (aliases[remoteName] ?? remoteName).trim());
    if (names.some((name) => !isValidToolName(name)) || new Set(names).size !== names.length) {
      setError("Each selected tool needs a valid, unique model-visible name.");
      return;
    }
    if (names.some((name) => attachedNames.includes(name))) {
      setError("A selected name is already attached. Deselect it or choose another name.");
      return;
    }
    setAttaching(true);
    setError(undefined);
    setNotice(undefined);
    const attached: string[] = [];
    try {
      for (const remoteName of selection) {
        const tool = discovery.tools.find((item) => item.remoteName === remoteName);
        if (!tool) continue;
        const problem = await onAttach(tool, (aliases[remoteName] ?? remoteName).trim(), destination, discovery.server.id,
          discovery.server.executionAvailable ? mode : "manual");
        if (problem) { setError(problem); break; }
        attached.push(remoteName);
      }
      setSelection((current) => current.filter((name) => !attached.includes(name)));
      if (attached.length) setNotice(`Attached ${attached.length} ${attached.length === 1 ? "tool" : "tools"}${destination === "project" ? " to the project" : " in this tab"}.`);
    } finally { setAttaching(false); }
  }

  if (isTauriRuntime()) return <section aria-label="MCP servers"><h3>MCP servers</h3><p>MCP discovery is available in the service-hosted app.</p></section>;

  return <section aria-label="MCP servers" className="tool-editor mcp-discovery-panel">
    <div className="tool-editor-toolbar"><div><span className="eyebrow">External tools</span><h3>MCP servers</h3></div></div>
    <div className="mcp-discovery-body">
    <p>Connect to an operator-declared server, inspect its tools, and attach a definition. Choose tools and how their calls are handled.</p>
    {catalogError && <p role="alert">{catalogError}</p>}
    {!catalog && !catalogError && <p>Loading declared servers…</p>}
    {catalog && !catalog.available && <p>{catalog.problem ?? `Set ${catalog.configurationVariable} on the service to declare an MCP server.`}</p>}
    {catalog?.available && catalog.servers.length === 0 && <p>No MCP servers are declared in the catalog.</p>}
    {catalog?.available && catalog.servers.length > 0 && <>
      <div className="tool-fields">
        <label>Declared MCP server
          <select disabled={attaching} value={selectedServer} onChange={(event) => { setSelectedServer(event.target.value); setSelection([]); setDiscovery(undefined); setPrevious(undefined); setAliases({}); setError(undefined); }}>
            {catalog.servers.map((server: McpServerSummary) => <option key={server.id} value={server.id}>{server.label} — {server.endpointIdentity}</option>)}
          </select>
        </label>
        <button className="button secondary" disabled={busy || attaching} type="button" onClick={() => void connect()}>{busy ? "Connecting…" : discovery ? "Refresh tools" : "Connect and browse tools"}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {discovery && <>
        <p>Connected to {discovery.serverIdentity.name} {discovery.serverIdentity.version} · MCP {discovery.protocolVersion} · {discovery.tools.length} tools · Refreshed {new Date(discovery.refreshedAt).toLocaleString()}</p>
        <label>Search tools <input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        {missing.length > 0 && <p role="status">No longer advertised: {missing.map((tool) => tool.remoteName).join(", ")}. Attached snapshots stay unchanged.</p>}
        <div className="tool-fields mcp-attachment-controls">
          <label>Attachment
            <select value={destination} disabled={attaching} onChange={(event) => setDestination(event.target.value as "request" | "project")}>
              <option value="request">Keep attached in this tab</option>
              <option value="project">Save to project</option>
            </select>
          </label>
          {discovery.server.executionAvailable ? <label>Execution mode
            <select value={mode} disabled={attaching} onChange={(event) => setMode(event.target.value as McpAttachmentMode)}>
              <option value="ask">Ask before running</option>
              <option value="automatic">Run automatically</option>
              <option value="manual">Manual results</option>
            </select>
          </label> : <p>This server supports discovery only. Attached tools use manual results.</p>}
          <button type="button" className="button secondary" disabled={attaching || selection.length === 0} onClick={() => void attach()}>
            {attaching ? "Attaching…" : `Attach selected (${selection.length})`}
          </button>
        </div>
        <p>{destination === "request" ? "Available for subsequent runs in this tab until removed. Cleared on reload or opening a different project." : "Definitions are saved with the project. Execution permissions are temporary and are not saved."}</p>
        {visibleTools.length === 0 && <p>No tools match your search.</p>}
        <div className="tool-list">
          {visibleTools.map((tool) => {
            const before = previous?.server.id === discovery.server.id ? previousByName.get(tool.remoteName) : undefined;
            const fields = before && before.fingerprint !== tool.fingerprint ? changedFields(before, tool) : [];
            const name = (aliases[tool.remoteName] ?? tool.remoteName).trim();
            const nameValid = isValidToolName(name);
            const alreadyAttached = attachedNames.includes(name);
            const attachable = !tool.invalidReason && nameValid && !alreadyAttached;
            return <article className="tool-editor" key={tool.remoteName}>
              <label><input type="checkbox" aria-label={`Select ${tool.remoteName}`} checked={selection.includes(tool.remoteName)} disabled={(!attachable && !selection.includes(tool.remoteName)) || attaching} onChange={(event) => setSelection((current) => event.target.checked ? [...current, tool.remoteName] : current.filter((name) => name !== tool.remoteName))} /> {tool.title ?? tool.remoteName}</label>
              {alreadyAttached && <small>Already attached</small>}
              <details><summary>Tool details</summary>
              {tool.title && <p>Remote name: <code>{tool.remoteName}</code></p>}
              {tool.description && <p>{tool.description}</p>}
              {fields.length > 0 && <p role="status">Changed since last refresh: {fields.join(", ")}. Existing attachments remain unchanged.</p>}
              {tool.invalidReason && <p role="alert">Cannot attach: {tool.invalidReason}</p>}
              <details><summary>Input schema</summary><pre>{JSON.stringify(tool.inputSchema ?? {}, null, 2)}</pre></details>
              {tool.outputSchema && <details><summary>Output schema</summary><pre>{JSON.stringify(tool.outputSchema, null, 2)}</pre></details>}
              {!tool.invalidReason && <>
                <label>Model-visible name <input aria-label={`Model-visible name for ${tool.remoteName}`} value={aliases[tool.remoteName] ?? tool.remoteName} onChange={(event) => setAliases((current) => ({ ...current, [tool.remoteName]: event.target.value }))} /></label>
                {!nameValid && <p>Use 1–64 letters, digits, underscores, or dashes.</p>}

              </>}
              </details>
            </article>;
          })}
        </div>
      </>}
    </>}
    </div>
  </section>;
}
