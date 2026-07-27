"use client";

import { useState } from "react";
import type { PromptTemplate } from "../packages/core/src/project";
import type {
  ConversationMessage,
  MessageId,
  RunId,
  ToolDefinition,
  ToolId,
} from "../packages/core/src/run-kernel";
import type { ToolMock } from "../packages/core/src/project";
import { ModelCombobox } from "./model-combobox.client";
import { ProjectTemplatesPane, TemplateUseCard } from "./project-templates-pane.client";
import type { RunReadiness, RunReadinessActionKind } from "./run-readiness.client";
import { RunReadinessNotice } from "./run-readiness-notice.client";
import { ToolsPane } from "./tools-pane.client";
import type { ModelDiscoveryState } from "./use-model-discovery.client";
import type { ProjectTemplatesHandle } from "./use-project-templates.client";
import { PaneTabs } from "./workbench-shell.client";

type RequestTab = "messages" | "templates" | "tools";

interface PendingBranch {
  parentRunId: RunId;
  branchMessageId: MessageId;
  parentTraceNeedsSaving: boolean;
}

interface RequestComposerProps {
  messages: ConversationMessage[];
  projectId?: string;
  promptTemplates: PromptTemplate[];
  hasProject: boolean;
  templates: ProjectTemplatesHandle;
  readiness?: RunReadiness;
  pendingBranch?: PendingBranch;
  activeModel: string;
  activeModelDiscovery: ModelDiscoveryState | null;
  activeTemperature: number;
  selectedToolCount: number;
  requestToolCount: number;
  toolsEnabled: boolean;
  activeProfileName: string;
  tools: ToolDefinition[];
  requestTools: ToolDefinition[];
  enabledToolIds: ToolId[];
  onMapActiveProfile(): void;
  onOpenConnectionSettings(): void;
  onLoadModels(force?: boolean): void;
  onModelChange(model: string): void;
  onTemperatureChange(temperature: number): void;
  onSavePendingBranchTrace(): void;
  onDiscardPendingBranch(): void;
  onOpenToolLibrary(): void;
  onAddTool(): void;
  onRemoveTool(id: ToolId): void;
  onUpdateTool(id: ToolId, patch: Partial<ToolDefinition>): void;
  onSetToolEnabled(id: ToolId, enabled: boolean): void;
  mockForTool(id: ToolId): ToolMock | undefined;
  onUpdateToolMock(id: ToolId, text: string, enabled: boolean): void;
  onRemoveRequestTool(id: ToolId): void;
}

/** Presentation and request-local navigation for the workbench's request pane. */
export function RequestComposer({
  messages,
  projectId,
  promptTemplates,
  hasProject,
  templates,
  readiness,
  pendingBranch,
  activeModel,
  activeModelDiscovery,
  activeTemperature,
  selectedToolCount,
  requestToolCount,
  toolsEnabled,
  activeProfileName,
  tools,
  requestTools,
  enabledToolIds,
  onMapActiveProfile,
  onOpenConnectionSettings,
  onLoadModels,
  onModelChange,
  onTemperatureChange,
  onSavePendingBranchTrace,
  onDiscardPendingBranch,
  onOpenToolLibrary,
  onAddTool,
  onRemoveTool,
  onUpdateTool,
  onSetToolEnabled,
  mockForTool,
  onUpdateToolMock,
  onRemoveRequestTool,
}: RequestComposerProps) {
  const [requestTab, setRequestTab] = useState<RequestTab>("messages");
  const requestPreview = templates.requestPreview;

  function resolveReadiness(kind: RunReadinessActionKind): void {
    if (kind === "map-profile") {
      onMapActiveProfile();
    } else if (kind === "open-connections") {
      onOpenConnectionSettings();
    } else {
      setRequestTab(kind === "review-tools" ? "tools" : "messages");
    }
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
          value={requestTab}
          onChange={(value) => setRequestTab(value as RequestTab)}
          tabs={[
            { id: "messages", label: "Messages", count: messages.length },
            { id: "templates", label: "Templates", count: promptTemplates.length },
            // The badge counts what will be sent, not what is defined, so it
            // agrees with the manifest inside the tab.
            { id: "tools", label: "Tools", count: selectedToolCount },
          ]}
        />
        {requestTab === "messages" ? (
          <button
            className="text-button header-text-action"
            onClick={templates.addComposerMessage}
          >
            + Add message
          </button>
        ) : requestTab === "tools" ? (
          <button
            className="text-button header-text-action"
            type="button"
            onClick={onAddTool}
          >
            + Add tool
          </button>
        ) : null}
      </div>
      <RunReadinessNotice
        {...(readiness ? { readiness } : {})}
        onAction={resolveReadiness}
      />
      {pendingBranch && (
        <div className="branch-pending" role="status">
          Branching from run <code>{pendingBranch.parentRunId}</code> at message{" "}
          <code>{pendingBranch.branchMessageId}</code> — the original trace is untouched.
          {pendingBranch.parentTraceNeedsSaving && (
            <button
              className="button secondary"
              type="button"
              onClick={onSavePendingBranchTrace}
            >
              Save trace…
            </button>
          )}
          <button
            className="button secondary"
            type="button"
            onClick={onDiscardPendingBranch}
          >
            Discard branch
          </button>
        </div>
      )}

      <div className="pane-scroll request-content">
        {requestTab === "messages" ? (
          <>
            <section className="run-settings" aria-label="Run settings">
              <div className="run-settings-heading">
                <span>
                  <strong>Run settings</strong>
                  <small>{hasProject ? "Project override" : "Profile default"}</small>
                </span>
                <button
                  className="text-button"
                  type="button"
                  onClick={onOpenConnectionSettings}
                >
                  Connection settings
                </button>
              </div>
              {/* The Tools tab owns the full manifest; this line only says
                  enough to notice that something needs attention there. */}
              <p
                className={
                  selectedToolCount > 0 && !toolsEnabled
                    ? "request-tool-line blocked"
                    : "request-tool-line"
                }
                role="status"
              >
                <span>
                  {selectedToolCount === 0
                    ? "No tools sent with this request."
                    : !toolsEnabled
                      ? `${selectedToolCount} ${
                          selectedToolCount === 1 ? "tool is" : "tools are"
                        } selected, but this profile does not allow tool calling.`
                      : requestToolCount > 0
                        ? `${selectedToolCount} ${
                            selectedToolCount === 1 ? "tool" : "tools"
                          } sent, ${requestToolCount} only once.`
                        : `${selectedToolCount} ${
                            selectedToolCount === 1 ? "tool" : "tools"
                          } sent with this request.`}
                </span>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setRequestTab("tools")}
                >
                  {selectedToolCount === 0 ? "Add tools" : "Review"}
                </button>
              </p>
              <div className="run-settings-grid">
                <ModelCombobox
                  value={activeModel}
                  onChange={onModelChange}
                  discovery={activeModelDiscovery}
                  onLoadModels={onLoadModels}
                />
                <label className="temperature-control">
                  Temperature
                  <div className="range-row">
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={activeTemperature}
                      onChange={(event) => onTemperatureChange(Number(event.target.value))}
                    />
                    <output>{activeTemperature.toFixed(1)}</output>
                  </div>
                </label>
              </div>
            </section>
            <div className="message-list">
              {templates.composerItems.map((item, index) => {
                if (item.kind === "template-use") {
                  const template = promptTemplates.find(
                    ({ id }) => id === item.use.templateId,
                  );
                  if (!template) return null;
                  return (
                    <TemplateUseCard
                      key={item.use.id}
                      use={item.use}
                      template={template}
                      diagnostics={
                        templates.activeProjectResolution?.diagnostics.filter(
                          ({ templateUseId }) => templateUseId === item.use.id,
                        ) ?? []
                      }
                      runOverrides={templates.runOverrides[item.use.id] ?? {}}
                      onSaveValues={(values) =>
                        templates.updateTemplateUseValues(item.use.id, values)
                      }
                      onRunOverridesChange={(values) =>
                        templates.updateTemplateUseOverride(item.use.id, values)
                      }
                      onUpdateLatest={() =>
                        templates.updateTemplateUseToLatestRevision(item.use.id)
                      }
                      onDetach={() => templates.detachTemplateUseFromProject(item.use.id)}
                      onRemove={() => templates.removeTemplateUseFromProject(item.use.id)}
                    />
                  );
                }
                const message = item.message;
                const roleIsStructural =
                  message.role === "tool" ||
                  (message.role === "assistant" && Boolean(message.toolCalls?.length));
                const text = message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("");
                return (
                  <article className="message-card" key={message.id}>
                    <div className="message-toolbar">
                      <select
                        aria-label={`Message ${index + 1} role`}
                        value={message.role}
                        disabled={roleIsStructural}
                        onChange={(event) =>
                          templates.updateComposerMessage(message.id, {
                            role: event.target.value as ConversationMessage["role"],
                          })
                        }
                      >
                        <option value="system">System</option>
                        <option value="user">User</option>
                        <option value="assistant">Assistant</option>
                        <option value="tool">Tool</option>
                      </select>
                      <button
                        aria-label={`Remove message ${index + 1}`}
                        className="remove-button"
                        onClick={() => templates.removeComposerMessage(message.id)}
                      >
                        Remove
                      </button>
                    </div>
                    <textarea
                      aria-label={`Message ${index + 1} content`}
                      value={text}
                      onChange={(event) =>
                        templates.updateComposerMessage(message.id, {
                          content: [{ type: "text", text: event.target.value }],
                        })
                      }
                      rows={message.role === "system" ? 4 : 7}
                    />
                    {message.role === "tool" && (
                      <small className="message-metadata">
                        Tool result for {message.name ?? "unnamed tool"} ({message.toolCallId})
                      </small>
                    )}
                    {message.role === "assistant" &&
                      message.toolCalls?.map((call) => (
                        <div className="tool-call-card message-tool-call" key={call.id}>
                          <div className="tool-call-heading">
                            <div>
                              <span className="eyebrow">Tool call</span>
                              <h3>{call.name}</h3>
                            </div>
                            <span className="provider-pill">Read-only</span>
                          </div>
                          <label>
                            Arguments
                            <pre>{call.arguments.text || "{}"}</pre>
                          </label>
                        </div>
                      ))}
                  </article>
                );
              })}
            </div>
            {requestPreview && (
              <details className="request-preview" open>
                <summary>Resolved request preview</summary>
                {"error" in requestPreview ? (
                  <div className="template-diagnostic">{requestPreview.error}</div>
                ) : (
                  <>
                    {(templates.activeProjectResolution?.diagnostics.length ?? 0) > 0 && (
                      <div className="template-warning" role="status">
                        Preview contains unresolved variables. Running is blocked until they have values.
                      </div>
                    )}
                    <h3>Resolved messages</h3>
                    <pre>{JSON.stringify(requestPreview.messages, null, 2)}</pre>
                    <h3>OpenAI-compatible request body</h3>
                    <pre>{JSON.stringify(requestPreview.body, null, 2)}</pre>
                  </>
                )}
              </details>
            )}
          </>
        ) : requestTab === "templates" ? (
          <ProjectTemplatesPane
            key={projectId ?? "unsaved-project"}
            templates={promptTemplates}
            usageCounts={templates.usageCounts}
            itemCount={templates.activeProjectRevision?.items.length ?? messages.length}
            onCreate={templates.createProjectTemplate}
            onSave={templates.saveProjectTemplate}
            onInsert={(templateId, role, itemIndex) => {
              templates.insertProjectTemplate(templateId, role, itemIndex);
              setRequestTab("messages");
            }}
          />
        ) : (
          <ToolsPane
            tools={tools}
            requestTools={requestTools}
            enabledToolIds={enabledToolIds}
            activeProfileName={activeProfileName}
            toolsEnabled={toolsEnabled}
            onOpenLibrary={onOpenToolLibrary}
            onOpenConnectionSettings={onOpenConnectionSettings}
            onAddTool={onAddTool}
            onRemoveTool={onRemoveTool}
            onUpdateTool={onUpdateTool}
            onSetToolEnabled={onSetToolEnabled}
            mockForTool={mockForTool}
            onUpdateToolMock={onUpdateToolMock}
            onRemoveRequestTool={onRemoveRequestTool}
          />
        )}
      </div>
    </section>
  );
}
