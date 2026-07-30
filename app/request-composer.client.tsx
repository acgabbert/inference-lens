"use client";

import { useState } from "react";
import type { ConversationMessage, ToolDefinition, ToolId } from "../packages/core/src/run-kernel";
import type { ProjectFile, ToolMock } from "../packages/core/src/project";
import { conversationMessageText } from "./conversation-display";
import { ModelCombobox } from "./model-combobox.client";
import type { ModelDiscoveryState } from "./use-model-discovery.client";
import { PaneTabs } from "./workbench-shell.client";
import { ProjectTemplatesPane, TemplateUseCard } from "./project-templates-pane.client";
import { ToolsPane } from "./tools-pane.client";
import { RunReadinessNotice } from "./run-readiness-notice.client";
import type { RunReadiness, RunReadinessActionKind } from "./run-readiness.client";
import type { ProjectTemplatesHandle } from "./use-project-templates.client";

type RequestTab = "messages" | "templates" | "tools";

type RequestPreview =
  | { body: unknown; messages: ConversationMessage[] }
  | { error: string };

/**
 * The request-pane feature owns its local navigation and presentation. Its
 * data remains deliberately owned by the request draft, template workbench,
 * profile, project, and run-readiness features that supply these snapshots.
 */
export interface RequestComposerProps {
  requestDraft: {
    messages: ConversationMessage[];
    tools: ToolDefinition[];
    requestTools: ToolDefinition[];
    enabledToolIds: ToolId[];
    addTool(): void;
    removeTool(id: ToolId): void;
    updateTool(id: ToolId, patch: Partial<ToolDefinition>): void;
    setToolEnabled(id: ToolId, enabled: boolean): void;
    mockForTool(id: ToolId): ToolMock | undefined;
    updateToolMock(id: ToolId, text: string, enabled: boolean): void;
    removeRequestTool(id: ToolId): void;
  };
  templates: ProjectTemplatesHandle;
  project: Pick<ProjectFile, "projectId" | "promptTemplates" | "connectionRequirements" | "defaults" | "externalImports"> | null;
  settings: {
    model: string;
    temperature: number;
    responseMode: "streaming" | "buffered";
    streamingAvailable: boolean;
    toolsEnabled: boolean;
    modelDiscovery: ModelDiscoveryState | null;
    onModelChange(model: string): void;
    onTemperatureChange(temperature: number): void;
    onStreamingPreferenceChange(streaming: boolean): void;
    onLoadModels(force?: boolean): void;
  };
  readiness?: RunReadiness;
  onReadinessAction(kind: RunReadinessActionKind): void;
  activeProfile: { name: string };
  pendingBranch?: {
    parentRunId: string;
    branchMessageId: string;
    parentTraceNeedsSaving: boolean;
  };
  requestPreview?: RequestPreview;
  onOpenConnectionSettings(): void;
  onOpenToolLibrary(): void;
  onSaveParentTrace(): void;
  onDiscardPendingBranch(): void;
}

export function RequestComposer({
  requestDraft,
  templates,
  project,
  settings,
  readiness,
  onReadinessAction,
  activeProfile,
  pendingBranch,
  requestPreview,
  onOpenConnectionSettings,
  onOpenToolLibrary,
  onSaveParentTrace,
  onDiscardPendingBranch,
}: RequestComposerProps) {
  const [tab, setTab] = useState<RequestTab>("messages");
  const selectedProjectToolCount = requestDraft.tools.filter(({ id }) =>
    requestDraft.enabledToolIds.includes(id),
  ).length;
  const selectedToolCount = selectedProjectToolCount + requestDraft.requestTools.length;
  // A newly imported snapshot is always shown before its notice is dismissed.
  const activeTab = templates.importNotice ? "messages" : tab;

  function routeReadinessAction(kind: RunReadinessActionKind): void {
    if (kind === "review-tools") {
      setTab("tools");
      return;
    }
    if (kind === "edit-template" || kind === "review-templates") {
      setTab("templates");
      return;
    }
    if (kind !== "map-profile" && kind !== "open-connections") {
      setTab("messages");
      return;
    }
    onReadinessAction(kind);
  }

  return (
    <section className="composer">
      <div className="panel-header request-header">
        <div>
          <span className="eyebrow">Request</span>
          <h2>Composer</h2>
        </div>
        <PaneTabs
          label="Request editor"
          value={activeTab}
          onChange={(value) => setTab(value as RequestTab)}
          tabs={[
            { id: "messages", label: "Messages", count: requestDraft.messages.length },
            { id: "templates", label: "Templates", count: project?.promptTemplates.length ?? 0 },
            { id: "tools", label: "Tools", count: selectedToolCount },
          ]}
        />
        {activeTab === "messages" ? (
          <button className="text-button header-text-action" onClick={templates.addComposerMessage}>
            + Add message
          </button>
        ) : activeTab === "tools" ? (
          <button className="text-button header-text-action" type="button" onClick={requestDraft.addTool}>
            + Add tool
          </button>
        ) : null}
      </div>
      <RunReadinessNotice {...(readiness ? { readiness } : {})} onAction={routeReadinessAction} />
      {templates.importNotice && (
        <div className="workbench-notice" role="status">
          <div className="workbench-notice-copy">
            <strong>
              Imported &ldquo;{templates.importNotice.name}&rdquo;{templates.importNotice.template ? " as a reusable template" : ""}
            </strong>
            <span>
              {templates.importNotice.template
                ? `${templates.importNotice.variableCount} ${templates.importNotice.variableCount === 1 ? "variable was" : "variables were"} carried over from the saved execution.`
                : "The saved execution messages are now in the composer."}
            </span>
          </div>
          <div className="workbench-notice-actions">
            {templates.importNotice.template && (
              <button className="button primary" type="button" onClick={() => { setTab("templates"); templates.clearImportNotice(); }}>
                View template
              </button>
            )}
            <button className="button" type="button" onClick={() => { setTab("messages"); templates.clearImportNotice(); }}>Dismiss</button>
          </div>
        </div>
      )}
      {pendingBranch && (
        <div className="branch-pending" role="status">
          Branching from run <code>{pendingBranch.parentRunId}</code> at message <code>{pendingBranch.branchMessageId}</code> — the original trace is untouched.
          {pendingBranch.parentTraceNeedsSaving && (
            <button className="button secondary" type="button" onClick={onSaveParentTrace}>Save trace…</button>
          )}
          <button className="button secondary" type="button" onClick={onDiscardPendingBranch}>Discard branch</button>
        </div>
      )}

      <div className="pane-scroll request-content">
        {activeTab === "messages" ? (
          <>
            <section className="run-settings" aria-label="Run settings">
              <div className="run-settings-heading">
                <span>
                  <strong>Run settings</strong>
                  <small>{project ? "Project override" : "Profile default"}</small>
                </span>
                <button className="text-button" type="button" onClick={onOpenConnectionSettings}>Connection settings</button>
              </div>
              <p className={selectedToolCount > 0 && !settings.toolsEnabled ? "request-tool-line blocked" : "request-tool-line"} role="status">
                <span>
                  {selectedToolCount === 0
                    ? "No tools sent with this request."
                    : !settings.toolsEnabled
                      ? `${selectedToolCount} ${selectedToolCount === 1 ? "tool is" : "tools are"} selected, but this profile does not allow tool calling.`
                      : requestDraft.requestTools.length > 0
                        ? `${selectedToolCount} ${selectedToolCount === 1 ? "tool" : "tools"} sent, ${requestDraft.requestTools.length} only once.`
                        : `${selectedToolCount} ${selectedToolCount === 1 ? "tool" : "tools"} sent with this request.`}
                </span>
                <button className="text-button" type="button" onClick={() => setTab("tools")}>
                  {selectedToolCount === 0 ? "Add tools" : "Review"}
                </button>
              </p>
              <div className="run-settings-grid">
                <ModelCombobox value={settings.model} onChange={settings.onModelChange} discovery={settings.modelDiscovery} onLoadModels={settings.onLoadModels} />
                <label className="temperature-control">
                  Temperature
                  <div className="range-row">
                    <input type="range" min="0" max="2" step="0.1" value={settings.temperature} onChange={(event) => settings.onTemperatureChange(Number(event.target.value))} />
                    <output>{settings.temperature.toFixed(1)}</output>
                  </div>
                </label>
                <label className={settings.streamingAvailable ? "streaming-control" : "streaming-control disabled"} title={settings.streamingAvailable ? undefined : "This profile does not support streaming responses."}>
                  <input type="checkbox" checked={settings.responseMode === "streaming"} disabled={!settings.streamingAvailable} onChange={(event) => settings.onStreamingPreferenceChange(event.target.checked)} />
                  <span>Stream response<small>{settings.streamingAvailable ? "Show output as the provider sends it." : "Unavailable for this profile; responses are buffered."}</small></span>
                </label>
              </div>
            </section>
            <div className="message-list">
              {templates.templateWorkbench.composerItems.map((item, index) => {
                if (item.kind === "template-use") {
                  const template = project?.promptTemplates.find(({ id }) => id === item.use.templateId);
                  if (!template) return null;
                  return <TemplateUseCard key={item.use.id} use={item.use} template={template}
                    diagnostics={templates.templateWorkbench.resolution?.diagnostics.filter(({ templateUseId }) => templateUseId === item.use.id) ?? []}
                    runOverrides={templates.templateRunOverrides[item.use.id] ?? {}}
                    importedFrom={project?.externalImports.find((receipt) => receipt.projection.kind === "prompt-template" && receipt.projection.templateRevisionId === item.use.templateRevisionId)}
                    onSaveValues={(values) => templates.updateTemplateUseValues(item.use.id, values)}
                    onSaveRunValue={(values, runOverrides) => templates.saveTemplateUseRunValue(item.use.id, values, runOverrides)}
                    onRunOverridesChange={(values) => templates.updateTemplateUseOverride(item.use.id, values)}
                    onUpdateLatest={() => templates.updateTemplateUseToLatestRevision(item.use.id)}
                    onDetach={() => templates.detachTemplateUse(item.use.id)}
                    onRemove={() => templates.removeTemplateUse(item.use.id)} />;
                }
                const message = item.message;
                const importReceipt = item.externalImportId ? project?.externalImports.find(({ id }) => id === item.externalImportId) : undefined;
                const roleIsStructural = message.role === "tool" || (message.role === "assistant" && Boolean(message.toolCalls?.length));
                const text = conversationMessageText(message);
                return <article className="message-card" key={message.id}>
                  <div className="message-toolbar">
                    <select aria-label={`Message ${index + 1} role`} value={message.role} disabled={roleIsStructural} onChange={(event) => templates.updateComposerMessage(message.id, { role: event.target.value as ConversationMessage["role"] })}>
                      <option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option><option value="tool">Tool</option>
                    </select>
                    {importReceipt && <span className="message-import-provenance" title={`Imported from ${importReceipt.source.adapter} execution ${importReceipt.source.execution?.id ?? "unavailable"} with ${importReceipt.fidelity.replaceAll("-", " ")} fidelity.`}>Imported from {importReceipt.source.adapter}{" · "}{importReceipt.fidelity.replaceAll("-", " ")}</span>}
                    <button aria-label={`Remove message ${index + 1}`} className="remove-button" onClick={() => templates.removeComposerMessage(message.id)}>Remove</button>
                  </div>
                  <textarea aria-label={`Message ${index + 1} content`} value={text} onChange={(event) => templates.updateComposerMessage(message.id, { content: [{ type: "text", text: event.target.value }] })} rows={message.role === "system" ? 4 : 7} />
                  {message.role === "tool" && <small className="message-metadata">Tool result for {message.name ?? "unnamed tool"} ({message.toolCallId})</small>}
                  {message.role === "assistant" && message.toolCalls?.map((call) => <div className="tool-call-card message-tool-call" key={call.id}><div className="tool-call-heading"><div><span className="eyebrow">Tool call</span><h3>{call.name}</h3></div><span className="provider-pill">Read-only</span></div><label>Arguments<pre>{call.arguments.text || "{}"}</pre></label></div>)}
                </article>;
              })}
            </div>
            {requestPreview && <details className="request-preview"><summary>Resolved request preview</summary>{"error" in requestPreview ? <div className="template-diagnostic">{requestPreview.error}</div> : <><>{(templates.templateWorkbench.resolution?.diagnostics.length ?? 0) > 0 && <div className="template-warning" role="status">Preview contains unresolved variables. Running is blocked until they have values.</div>}</><h3>Resolved messages</h3><div className="request-preview-messages">{requestPreview.messages.map((message, index) => <article className="request-preview-message" key={`${message.role}-${index}`}><span className="eyebrow">{message.role}</span><pre>{conversationMessageText(message)}</pre></article>)}</div><details className="request-preview-raw"><summary>Raw OpenAI-compatible request body</summary><pre>{JSON.stringify(requestPreview.body, null, 2)}</pre></details></>}</details>}
          </>
        ) : activeTab === "templates" ? (
          <ProjectTemplatesPane key={project?.projectId ?? "unsaved-project"} templates={project?.promptTemplates ?? []} connectionRequirements={project?.connectionRequirements ?? []} defaultConnectionRequirementId={project?.defaults.target.connectionRequirementId} usageCounts={templates.templateUsageCounts} itemCount={templates.activeProjectRevision?.items.length ?? requestDraft.messages.length} onCreate={templates.createProjectTemplate} onSave={templates.saveProjectTemplate} onInsert={(...args) => { templates.insertProjectTemplate(...args); setTab("messages"); }} />
        ) : (
          <ToolsPane tools={requestDraft.tools} requestTools={requestDraft.requestTools} enabledToolIds={requestDraft.enabledToolIds} activeProfileName={activeProfile.name} toolsEnabled={settings.toolsEnabled} onOpenLibrary={onOpenToolLibrary} onOpenConnectionSettings={onOpenConnectionSettings} onAddTool={requestDraft.addTool} onRemoveTool={requestDraft.removeTool} onUpdateTool={requestDraft.updateTool} onSetToolEnabled={requestDraft.setToolEnabled} mockForTool={requestDraft.mockForTool} onUpdateToolMock={requestDraft.updateToolMock} onRemoveRequestTool={requestDraft.removeRequestTool} />
        )}
      </div>
    </section>
  );
}
