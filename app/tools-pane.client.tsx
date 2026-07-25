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

/** Project-owned definitions and one-shot tool attachments. */
export function ToolsPane({
  tools, requestTools, enabledToolIds, activeProfileName, toolsEnabled,
  onOpenLibrary, onOpenConnectionSettings, onAddTool, onRemoveTool, onUpdateTool,
  onSetToolEnabled, mockForTool, onUpdateToolMock, onRemoveRequestTool,
}: ToolsPaneProps) {
  return (
    <>
      <div className="tool-scope-guide" aria-label="How tools reach a request">
        <div><span className="tool-scope-number">1</span><span><strong>Local tool library</strong><small>Reusable definitions saved locally for this app.</small></span></div>
        <span className="tool-scope-arrow" aria-hidden="true">→</span>
        <div><span className="tool-scope-number">2</span><span><strong>Select for a request</strong><small>Expose a project tool or attach a one-shot copy.</small></span></div>
        <span className="tool-scope-arrow" aria-hidden="true">→</span>
        <div><span className="tool-scope-number">3</span><span><strong>Active profile</strong><small>Must allow tool calling before anything is sent.</small></span></div>
      </div>
      <div className="tools-tab-toolbar">
        <div><span className="eyebrow">Project</span><strong>Tool definitions</strong><p>Project tools are stored with this project. Only checked tools are selected for requests.</p></div>
        <div className="tool-header-actions"><button className="text-button" type="button" onClick={onOpenLibrary}>Browse local library</button><button className="text-button" type="button" onClick={onAddTool}>+ Add project tool</button></div>
      </div>
      {(enabledToolIds.length > 0 || requestTools.length > 0) && !toolsEnabled && (
        <div className="tool-capability-warning" role="status"><div><strong>Selected tools will not run with “{activeProfileName || "Untitled profile"}”</strong><span>This profile does not currently allow tool calling.</span></div><button className="button secondary" type="button" onClick={onOpenConnectionSettings}>Open connection settings</button></div>
      )}
      {requestTools.length > 0 && (
        <div className="request-tool-attachments"><div><span className="eyebrow">One-shot attachments</span><strong>Next request</strong><p>These snapshots are sent once, then cleared from the composer.</p></div><div className="request-tool-chips">{requestTools.map((tool) => <span className="request-tool-chip" key={tool.id}>{tool.name}<button aria-label={`Remove ${tool.name} from next request`} type="button" onClick={() => onRemoveRequestTool(tool.id)}>×</button></span>)}</div></div>
      )}
      <div className="tool-list">
        {tools.length === 0 ? <p className="tool-empty">No project-owned tools. Add one here or copy a snapshot from the local library.</p> : tools.map((tool) => {
          const mock = mockForTool(tool.id);
          const mockText = mock?.result.content.map(({ text }) => text).join("") ?? "";
          return <article className="tool-editor" key={tool.id}>
            <div className="tool-editor-toolbar"><label className="tool-enabled"><input type="checkbox" checked={enabledToolIds.includes(tool.id)} onChange={(event) => onSetToolEnabled(tool.id, event.target.checked)} />Expose to model</label><button className="remove-button" type="button" onClick={() => onRemoveTool(tool.id)}>Remove</button></div>
            <ToolDefinitionEditor value={tool} onChange={(value) => onUpdateTool(tool.id, value)} />
            <div className="tool-fields tool-mock-fields"><label className="tool-mock-toggle"><input type="checkbox" checked={mock?.enabled ?? false} onChange={(event) => onUpdateToolMock(tool.id, mockText, event.target.checked)} />Use static mock result</label>{mock?.enabled && <label className="tool-mock-result">Mock result<textarea value={mockText} onChange={(event) => onUpdateToolMock(tool.id, event.target.value, true)} /></label>}</div>
          </article>;
        })}
      </div>
    </>
  );
}
