"use client";

import { useEffect, useRef, useState } from "react";

import type { ToolDefinition, ToolId } from "../packages/core/src/run-kernel";
import type { ToolMock } from "../packages/core/src/project";
import { ToolDefinitionEditor } from "./tool-definition-editor.client";
import { CommandToolBindingEditor } from "./tools/command-tool-binding-editor.client";
import type { CommandToolsHandle } from "./tools/use-command-tools.client";
import { McpDiscoveryPanel } from "./tools/mcp-discovery-panel.client";
import { McpConsentEditor } from "./tools/mcp-consent-editor.client";
import type { McpConsentsHandle } from "./tools/use-mcp-consents.client";
import { AttachDestinationControl } from "./tools/attach-destination-control.client";
import type {
  ToolAttachmentDestination,
  ToolAttachmentSource,
} from "./request/use-request-draft.client";

interface ToolsPaneProps {
  tools: ToolDefinition[];
  requestTools: ToolDefinition[];
  enabledToolIds: ToolId[];
  activeProfileName: string;
  toolsEnabled: boolean;
  onOpenLibrary(destination: ToolAttachmentDestination): void;
  onOpenConnectionSettings(): void;
  onAttach(source: ToolAttachmentSource, destination: ToolAttachmentDestination): ToolDefinition | string;
  onRemoveTool(id: ToolId): void;
  onMoveTool(id: ToolId, offset: number): void;
  onUpdateTool(id: ToolId, patch: Partial<ToolDefinition>): void;
  onSetToolEnabled(id: ToolId, enabled: boolean): void;
  mockForTool(id: ToolId): ToolMock | undefined;
  onUpdateToolMock(id: ToolId, text: string, enabled: boolean): void;
  onSaveRequestToolToProject?(id: ToolId): void;
  onUpdateRequestTool(id: ToolId, patch: Partial<ToolDefinition>): void;
  onMoveRequestTool(id: ToolId, offset: number): void;
  onRemoveRequestTool(id: ToolId): void;
  /** What this device may run, and what each tool has been allowed to run. */
  commandTools: CommandToolsHandle;
  mcpConsents?: McpConsentsHandle;
}

function toolName(tool: ToolDefinition): string {
  return tool.name.trim() || "Unnamed tool";
}

/**
 * Project-owned definitions, and one manifest of what actually goes on the
 * wire. A tool reaches a request through two different routes — a project tool
 * that is selected, or a temporary snapshot kept in this tab — but the
 * question a user asks is always the same one, so both are answered in a
 * single list rather than in a separate card per route.
 *
 * That list is also the only place a tool is attached, detached, or moved,
 * and every way in starts from its one "Attach tool" menu, which asks the
 * same "this tab or the project" question whatever the source. The project
 * cards below only edit definitions.
 */
export function ToolsPane({
  tools, requestTools, enabledToolIds, activeProfileName, toolsEnabled,
  onOpenLibrary, onOpenConnectionSettings, onAttach, onRemoveTool, onMoveTool, onUpdateTool,
  onSetToolEnabled, mockForTool, onUpdateToolMock, onSaveRequestToolToProject,
  onUpdateRequestTool, onMoveRequestTool, onRemoveRequestTool, commandTools, mcpConsents,
}: ToolsPaneProps) {
  const [destination, setDestination] = useState<ToolAttachmentDestination>("request");
  const [menuOpen, setMenuOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  // The panel keeps the choice it was opened with; the menu starts over.
  const [mcpDestination, setMcpDestination] = useState<ToolAttachmentDestination>("request");
  const [attachError, setAttachError] = useState<string>();
  const [newToolId, setNewToolId] = useState<ToolId>();
  const mcpRef = useRef<HTMLDivElement>(null);
  const attachTriggerRef = useRef<HTMLButtonElement>(null);

  // The panel opens below the project cards, which can be off screen.
  useEffect(() => {
    if (mcpOpen) mcpRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [mcpOpen]);

  const selectedProjectTools = tools.filter(({ id }) =>
    enabledToolIds.includes(id),
  );
  const detachedProjectTools = tools.filter(({ id }) => !enabledToolIds.includes(id));
  const selectedCount = selectedProjectTools.length + requestTools.length;
  const profileName = activeProfileName.trim() || "Untitled profile";
  const state =
    selectedCount === 0 ? "empty" : toolsEnabled ? "ready" : "blocked";

  function attachNew(): void {
    const attached = onAttach({ kind: "new" }, destination);
    if (typeof attached === "string") {
      setAttachError(attached);
      return;
    }
    setNewToolId(attached.id);
    closeMenu();
  }

  /** Every opening starts from the default, so a project attach stays deliberate. */
  function openMenu(): void {
    setDestination("request");
    setMenuOpen(true);
  }

  function closeMenu(): void {
    setMenuOpen(false);
    setAttachError(undefined);
  }

  function reorderButtons(tool: ToolDefinition, index: number, count: number, move: (id: ToolId, offset: number) => void) {
    return <span className="tool-reorder">
      <button aria-label={`Move ${toolName(tool)} earlier in the request`} className="text-button" disabled={index === 0} type="button" onClick={() => move(tool.id, -1)}>↑</button>
      <button aria-label={`Move ${toolName(tool)} later in the request`} className="text-button" disabled={index === count - 1} type="button" onClick={() => move(tool.id, 1)}>↓</button>
    </span>;
  }

  return (
    <>
      <section
        aria-label="Tools attached to this request"
        className={`tool-manifest ${state}`}
        data-readiness-target="tool-manifest"
        tabIndex={-1}
      >
        <header>
          <div>
            <span className="eyebrow">Next request</span>
            <strong>
              {selectedCount === 0
                ? "No tools attached"
                : state === "blocked"
                  ? `${selectedCount} ${
                      selectedCount === 1 ? "tool is" : "tools are"
                    } attached`
                  : `${selectedCount} ${
                      selectedCount === 1 ? "tool" : "tools"
                    } attached`}
            </strong>
            <p>
              {state === "empty"
                ? "Attach a new definition, one from your local library, or one from an MCP server."
                : state === "blocked"
                  ? `Profile “${profileName}” does not allow tool calling, so none of these reach the model.`
                  : selectedProjectTools.length > 0 && requestTools.length > 0
                    ? "These definitions accompany the request in this order; tools kept in this tab follow project tools."
                    : "These definitions accompany the request in this order."}
            </p>
          </div>
          <div className="tool-manifest-actions">
            {state === "blocked" && (
              <button
                className="button secondary allow-tool-calling"
                type="button"
                onClick={onOpenConnectionSettings}
              >
                Allow tool calling…
              </button>
            )}
            <button
              aria-expanded={menuOpen}
              className="button secondary"
              ref={attachTriggerRef}
              type="button"
              onClick={() => (menuOpen ? closeMenu() : openMenu())}
            >
              Attach tool
            </button>
          </div>
        </header>
        {menuOpen && (
          <div
            aria-label="Attach a tool"
            className="attach-tool-menu"
            role="group"
            onKeyDown={(event) => { if (event.key === "Escape") closeMenu(); }}
          >
            <AttachDestinationControl value={destination} onChange={setDestination} />
            <div className="attach-tool-sources">
              <button className="button secondary" type="button" onClick={attachNew}>New definition</button>
              <button className="button secondary" type="button" onClick={() => {
                // The trigger becomes the library's opener, so closing it returns there.
                attachTriggerRef.current?.focus();
                closeMenu();
                onOpenLibrary(destination);
              }}>From local library…</button>
              <button className="button secondary" type="button" onClick={() => { closeMenu(); setMcpDestination(destination); setMcpOpen(true); }}>From MCP server…</button>
            </div>
            {attachError && <p role="alert">{attachError}</p>}
            {detachedProjectTools.length > 0 && (
              <div className="attach-tool-detached">
                <span className="eyebrow">Project tools not attached</span>
                <ul>
                  {detachedProjectTools.map((tool) => (
                    <li key={tool.id}>
                      <code>{toolName(tool)}</code>
                      <button
                        aria-label={`Attach ${toolName(tool)}`}
                        className="text-button"
                        type="button"
                        onClick={() => { onSetToolEnabled(tool.id, true); closeMenu(); }}
                      >
                        Attach
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {selectedCount > 0 && (
          <ul className="tool-manifest-list">
            {selectedProjectTools.map((tool, index) => (
              <li key={tool.id}>
                <span className="tool-manifest-name">
                  <code>{toolName(tool)}</code>
                  {tool.description && <small>{tool.description}</small>}
                  {tool.source?.kind === "mcp" && <small>MCP snapshot of {tool.source.remoteToolName}</small>}
                </span>
                <span
                  className="tool-origin project"
                  title="Saved with the project and attached to every run in it."
                >
                  Project
                </span>
                {reorderButtons(tool, index, selectedProjectTools.length, onMoveTool)}
                {tool.source?.kind === "mcp" && mcpConsents && <McpConsentEditor tool={tool} consents={mcpConsents} />}
                <button
                  aria-label={`Detach ${toolName(tool)}`}
                  className="text-button"
                  type="button"
                  onClick={() => onSetToolEnabled(tool.id, false)}
                >
                  Detach
                </button>
              </li>
            ))}
            {requestTools.map((tool, index) => (
              <li key={tool.id}>
                <span className="tool-manifest-name">
                  <code>{toolName(tool)}</code>
                  {tool.description && <small>{tool.description}</small>}
                  {tool.source?.kind === "mcp" && <small>MCP snapshot of {tool.source.remoteToolName}</small>}
                </span>
                <span
                  className="tool-origin once"
                  title="Kept across runs in this tab; cleared on reload or opening a different project."
                >
                  This tab
                </span>
                {reorderButtons(tool, index, requestTools.length, onMoveRequestTool)}
                <button
                  aria-label={`Detach ${toolName(tool)} from this tab`}
                  className="text-button"
                  type="button"
                  onClick={() => onRemoveRequestTool(tool.id)}
                >
                  Detach
                </button>
                {onSaveRequestToolToProject && <button type="button" className="text-button" onClick={() => onSaveRequestToolToProject(tool.id)}>Save to project</button>}
                {tool.source?.kind === "mcp" && mcpConsents && <McpConsentEditor tool={tool} consents={mcpConsents} />}
                {/* Tab tools have no project card, so they are edited here. */}
                <details className="tool-definition-disclosure tool-manifest-editor" open={newToolId === tool.id}>
                  <summary>Edit definition</summary>
                  <ToolDefinitionEditor value={tool} onChange={(value) => onUpdateRequestTool(tool.id, value)} />
                  {tool.source?.kind === "mcp" && <p>Editing this definition detaches its source receipt.</p>}
                </details>
              </li>
            ))}
          </ul>
        )}
        {[...selectedProjectTools, ...requestTools].some((tool) => tool.source?.kind === "mcp") && <p className="mcp-permission-note">MCP permissions stay on this device until you revoke them, and stop working if the server changes the tool. Saving a tool to the project does not save permission.</p>}
      </section>
      <div className="tools-tab-toolbar">
        <div>
          <span className="eyebrow">Project</span>
          <strong>Project tools · {tools.length}</strong>
          <p>
            {tools.length > 0
              ? "Saved definitions. Attach, detach, and order them in the list above."
              : "Tools you attach to the project are saved here."}
          </p>
        </div>
      </div>
      <div className="tool-list">
        {tools.map((tool, index) => {
          const mock = mockForTool(tool.id);
          const mockText = mock?.result.content.map(({ text }) => text).join("") ?? "";
          const toolLabel = tool.name.trim() || `tool ${index + 1}`;
          const attached = enabledToolIds.includes(tool.id);
          // Both can be configured at once, and only one can answer. Saying so
          // beside the one that will not is cheaper than a user discovering it
          // from a transcript.
          const commandServes = Boolean(commandTools.bindingFor(tool.id));
          const mcpServes = Boolean(mcpConsents?.bindingFor(tool));
          return <article className="tool-editor" key={tool.id}>
            <div className="tool-editor-toolbar"><span className={attached ? "tool-attach-status attached" : "tool-attach-status"}>{attached ? "Attached" : "Not attached"}</span><button className="remove-button" type="button" onClick={() => onRemoveTool(tool.id)}>Remove</button></div>
            {!attached && tool.source?.kind === "mcp" && mcpConsents && <McpConsentEditor tool={tool} consents={mcpConsents} />}
            <details className="tool-definition-disclosure" open={newToolId === tool.id}><summary>{tool.name || "Unnamed tool"} · Edit definition</summary>
            <ToolDefinitionEditor value={tool} onChange={(value) => onUpdateTool(tool.id, value)} />
            {tool.source?.kind === "mcp" && <p>MCP snapshot of <code>{tool.source.remoteToolName}</code> · fingerprint <code>{tool.source.discoveryFingerprint.slice(0, 12)}</code>. Editing this definition detaches its source receipt.</p>}
            <div className="tool-fields tool-mock-fields"><label className="tool-mock-toggle"><input type="checkbox" checked={mock?.enabled ?? false} onChange={(event) => onUpdateToolMock(tool.id, mockText, event.target.checked)} />Use static mock result</label>{mock?.enabled && <label className="tool-mock-result">Mock result<textarea value={mockText} onChange={(event) => onUpdateToolMock(tool.id, event.target.value, true)} /></label>}{mock?.enabled && (commandServes || mcpServes) && <p className="tool-mock-superseded">{mcpServes ? "MCP" : "A command tool"} is allowed to answer {toolLabel} on this device, so this mock is not used.</p>}</div>
            <CommandToolBindingEditor toolId={tool.id} toolLabel={toolLabel} commandTools={commandTools} supersededByMcp={mcpServes} />
            </details>
          </article>;
        })}
      </div>
      {mcpOpen && <div ref={mcpRef}><McpDiscoveryPanel
        destination={mcpDestination}
        onDestinationChange={setMcpDestination}
        onClose={() => setMcpOpen(false)}
        takenNames={[...tools, ...requestTools].map(({ name }) => name)}
        onAttach={async (source, name, attachTo, serverId, mode) => {
          const attached = onAttach({ kind: "mcp", tool: source, name }, attachTo);
          if (typeof attached === "string") return attached;
          if (mode !== "manual" && (!mcpConsents || !await mcpConsents.grant(attached, serverId, mode))) {
            return `${name} was attached, but execution permission could not be set. Change its execution mode in the attached tools list.`;
          }
        }}
      /></div>}
    </>
  );
}
