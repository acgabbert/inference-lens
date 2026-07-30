"use client";

import type { ToolDefinition, ToolId } from "../packages/core/src/run-kernel";
import type { ToolMock } from "../packages/core/src/project";
import { ToolDefinitionEditor } from "./tool-definition-editor.client";

interface ToolsPaneProps {
  tools: ToolDefinition[];
  requestTools: ToolDefinition[];
  enabledToolIds: ToolId[];
  activeProfileName: string;
  toolsEnabled: boolean;
  onOpenLibrary(): void;
  onOpenConnectionSettings(): void;
  onAddTool(): void;
  onRemoveTool(id: ToolId): void;
  onUpdateTool(id: ToolId, patch: Partial<ToolDefinition>): void;
  onSetToolEnabled(id: ToolId, enabled: boolean): void;
  mockForTool(id: ToolId): ToolMock | undefined;
  onUpdateToolMock(id: ToolId, text: string, enabled: boolean): void;
  onRemoveRequestTool(id: ToolId): void;
}

/**
 * Project-owned definitions, and one manifest of what actually goes on the
 * wire. A tool reaches a request through two different routes — a project tool
 * that is selected, or a one-shot snapshot from the local library — but the
 * question a user asks is always the same one, so both are answered in a
 * single list rather than in a separate card per route.
 */
export function ToolsPane({
  tools, requestTools, enabledToolIds, activeProfileName, toolsEnabled,
  onOpenLibrary, onOpenConnectionSettings, onAddTool, onRemoveTool, onUpdateTool,
  onSetToolEnabled, mockForTool, onUpdateToolMock, onRemoveRequestTool,
}: ToolsPaneProps) {
  const selectedProjectTools = tools.filter(({ id }) =>
    enabledToolIds.includes(id),
  );
  const selectedCount = selectedProjectTools.length + requestTools.length;
  const profileName = activeProfileName.trim() || "Untitled profile";
  const state =
    selectedCount === 0 ? "empty" : toolsEnabled ? "ready" : "blocked";

  return (
    <>
      <section
        aria-label="Tool selection for this request"
        className={`tool-manifest ${state}`}
        data-readiness-target="tool-manifest"
        tabIndex={-1}
      >
        <header>
          <div>
            <span className="eyebrow">Next request</span>
            <strong>
              {selectedCount === 0
                ? "No tools will be sent"
                : state === "blocked"
                  ? `${selectedCount} ${
                      selectedCount === 1 ? "tool is" : "tools are"
                    } selected`
                  : `${selectedCount} ${
                      selectedCount === 1 ? "tool" : "tools"
                    } will be sent`}
            </strong>
            <p>
              {state === "empty"
                ? "Select a project tool below, or attach a one-shot copy from the local library."
                : state === "blocked"
                  ? `Profile “${profileName}” does not allow tool calling, so none of these reach the model.`
                  : "Everything listed here is serialized into the request when the run starts."}
            </p>
          </div>
          {state === "blocked" && (
            <button
              className="button secondary"
              type="button"
              onClick={onOpenConnectionSettings}
            >
              Allow tool calling…
            </button>
          )}
        </header>
        {selectedCount > 0 && (
          <ul className="tool-manifest-list">
            {selectedProjectTools.map((tool) => (
              <li key={tool.id}>
                <span className="tool-manifest-name">
                  <code>{tool.name.trim() || "Unnamed tool"}</code>
                  {tool.description && <small>{tool.description}</small>}
                </span>
                <span className="tool-origin project">Project</span>
                <button
                  aria-label={`Stop sending ${tool.name || "this tool"}`}
                  className="text-button"
                  type="button"
                  onClick={() => onSetToolEnabled(tool.id, false)}
                >
                  Don’t send
                </button>
              </li>
            ))}
            {requestTools.map((tool) => (
              <li key={tool.id}>
                <span className="tool-manifest-name">
                  <code>{tool.name.trim() || "Unnamed tool"}</code>
                  {tool.description && <small>{tool.description}</small>}
                </span>
                <span
                  className="tool-origin once"
                  title="A library snapshot held for one run, then cleared from the composer."
                >
                  Once
                </span>
                <button
                  aria-label={`Remove ${tool.name || "this tool"} from the next request`}
                  className="text-button"
                  type="button"
                  onClick={() => onRemoveRequestTool(tool.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="tools-tab-toolbar">
        <div>
          <span className="eyebrow">Project</span>
          <strong>Tool definitions</strong>
          <p>Stored with this project. Only selected definitions are sent.</p>
        </div>
        <div className="tool-header-actions">
          <button className="text-button" type="button" onClick={onOpenLibrary}>Browse local library</button>
          <button className="text-button" type="button" onClick={onAddTool}>+ Add project tool</button>
        </div>
      </div>
      <div className="tool-list">
        {tools.length === 0 ? <p className="tool-empty">No project-owned tools. Add one here or copy a snapshot from the local library.</p> : tools.map((tool) => {
          const mock = mockForTool(tool.id);
          const mockText = mock?.result.content.map(({ text }) => text).join("") ?? "";
          return <article className="tool-editor" key={tool.id}>
            <div className="tool-editor-toolbar"><label className="tool-enabled"><input type="checkbox" checked={enabledToolIds.includes(tool.id)} onChange={(event) => onSetToolEnabled(tool.id, event.target.checked)} />Send with requests</label><button className="remove-button" type="button" onClick={() => onRemoveTool(tool.id)}>Remove</button></div>
            <ToolDefinitionEditor value={tool} onChange={(value) => onUpdateTool(tool.id, value)} />
            <div className="tool-fields tool-mock-fields"><label className="tool-mock-toggle"><input type="checkbox" checked={mock?.enabled ?? false} onChange={(event) => onUpdateToolMock(tool.id, mockText, event.target.checked)} />Use static mock result</label>{mock?.enabled && <label className="tool-mock-result">Mock result<textarea value={mockText} onChange={(event) => onUpdateToolMock(tool.id, event.target.value, true)} /></label>}</div>
          </article>;
        })}
      </div>
    </>
  );
}
