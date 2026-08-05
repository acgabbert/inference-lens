"use client";

import type { ToolDefinition, ToolId } from "../packages/core/src/run-kernel";
import type { ToolMock } from "../packages/core/src/project";
import { PaneEmptyState } from "./pane-empty-state.client";
import { ToolDefinitionEditor } from "./tool-definition-editor.client";
import { CommandToolBindingEditor } from "./tools/command-tool-binding-editor.client";
import type { CommandToolsHandle } from "./tools/use-command-tools.client";

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
  onMoveTool(id: ToolId, offset: number): void;
  onUpdateTool(id: ToolId, patch: Partial<ToolDefinition>): void;
  onSetToolEnabled(id: ToolId, enabled: boolean): void;
  mockForTool(id: ToolId): ToolMock | undefined;
  onUpdateToolMock(id: ToolId, text: string, enabled: boolean): void;
  onRemoveRequestTool(id: ToolId): void;
  /** What this device may run, and what each tool has been allowed to run. */
  commandTools: CommandToolsHandle;
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
  onOpenLibrary, onOpenConnectionSettings, onAddTool, onRemoveTool, onMoveTool, onUpdateTool,
  onSetToolEnabled, mockForTool, onUpdateToolMock, onRemoveRequestTool, commandTools,
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
                ? "Attach an available project tool or a session-only library copy."
                : state === "blocked"
                  ? `Profile “${profileName}” does not allow tool calling, so none of these reach the model.`
                  : "These definitions accompany the request in this order."}
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
                  aria-label={`Detach ${tool.name || "this tool"}`}
                  className="text-button"
                  type="button"
                  onClick={() => onSetToolEnabled(tool.id, false)}
                >
                  Detach
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
          <p>Available in this project; attached only when enabled below.</p>
        </div>
        <div className="tool-header-actions">
          <button className="text-button" type="button" onClick={onOpenLibrary}>Browse local library</button>
          <button className="text-button" type="button" onClick={onAddTool}>+ Add project tool</button>
        </div>
      </div>
      <div className="tool-list">
        {tools.length === 0 ? (
          <PaneEmptyState
            eyebrow="Project"
            heading="No project tools yet"
            detail="Tool definitions are available to this project and accompany a request only when attached."
            action={{ label: "+ Add project tool", onClick: onAddTool }}
          />
        ) : tools.map((tool, index) => {
          const mock = mockForTool(tool.id);
          const mockText = mock?.result.content.map(({ text }) => text).join("") ?? "";
          const toolLabel = tool.name.trim() || `tool ${index + 1}`;
          // Both can be configured at once, and only one can answer. Saying so
          // beside the one that will not is cheaper than a user discovering it
          // from a transcript.
          const commandServes = Boolean(commandTools.bindingFor(tool.id));
          return <article className="tool-editor" key={tool.id}>
            <div className="tool-editor-toolbar"><label className="tool-enabled"><input type="checkbox" checked={enabledToolIds.includes(tool.id)} onChange={(event) => onSetToolEnabled(tool.id, event.target.checked)} />Attach to requests</label><div className="tool-reorder"><button aria-label={`Move ${toolLabel} earlier in the request`} className="text-button" disabled={index === 0} type="button" onClick={() => onMoveTool(tool.id, -1)}>↑</button><button aria-label={`Move ${toolLabel} later in the request`} className="text-button" disabled={index === tools.length - 1} type="button" onClick={() => onMoveTool(tool.id, 1)}>↓</button></div><button className="remove-button" type="button" onClick={() => onRemoveTool(tool.id)}>Remove</button></div>
            <ToolDefinitionEditor value={tool} onChange={(value) => onUpdateTool(tool.id, value)} />
            <div className="tool-fields tool-mock-fields"><label className="tool-mock-toggle"><input type="checkbox" checked={mock?.enabled ?? false} onChange={(event) => onUpdateToolMock(tool.id, mockText, event.target.checked)} />Use static mock result</label>{mock?.enabled && <label className="tool-mock-result">Mock result<textarea value={mockText} onChange={(event) => onUpdateToolMock(tool.id, event.target.value, true)} /></label>}{mock?.enabled && commandServes && <p className="tool-mock-superseded">A command tool is allowed to answer {toolLabel} on this device, so this mock is not used.</p>}</div>
            <CommandToolBindingEditor toolId={tool.id} toolLabel={toolLabel} commandTools={commandTools} />
          </article>;
        })}
      </div>
    </>
  );
}
