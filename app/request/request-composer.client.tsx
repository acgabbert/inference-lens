"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationMessage, ToolDefinition, ToolId } from "../../packages/core/src/run-kernel";
import type { ProjectFile, ToolMock } from "../../packages/core/src/project";
import { conversationMessageText } from "../conversation-display";
import { PaneTabs } from "../workbench-shell.client";
import { ProjectTemplatesPane, TemplateUseCard } from "../project-templates-pane.client";
import { ToolsPane } from "../tools-pane.client";
import { RunReadinessNotice } from "../run-readiness-notice.client";
import { FocusModeToggle, useFocusMode } from "../focus-mode.client";
import type {
  ReadinessDestination,
  RunReadiness,
  RunReadinessAction,
} from "../run-readiness.client";
import type { ProjectTemplatesHandle } from "../templates/use-project-templates.client";
import { EvaluationSuiteEditor } from "../evaluations/evaluation-suite-editor.client";
import type { EvaluationSuiteExecutionActions } from "../evaluations/evaluation-suite-editor.client";
import type { EvaluationSuiteAuthoringHandle } from "../evaluations/use-evaluation-suite-authoring.client";
import { RequestSettings } from "./request-settings.client";
import type { RequestSettingsProps } from "./request-settings.client";

type RequestTab = "messages" | "templates" | "tools" | "evaluations";

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
  evaluations: EvaluationSuiteAuthoringHandle;
  evaluationExecution: EvaluationSuiteExecutionActions;
  project: Pick<ProjectFile, "projectId" | "promptTemplates" | "connectionRequirements" | "defaults" | "externalImports"> | null;
  settings: RequestSettingsProps & {
    toolsEnabled: boolean;
  };
  readiness?: RunReadiness;
  pendingDestination?: ReadinessDestination;
  onReadinessAction(destination: ReadinessDestination): void;
  onDestinationHandled(): void;
  activeProfile: { name: string };
  pendingBranch?: {
    parentRunId: string;
    branchMessageId: string;
    parentTraceNeedsSaving: boolean;
  };
  requestPreview?: RequestPreview;
  n8nImportDisabledReason?: string;
  onOpenConnectionSettings(): void;
  onOpenN8nImport(): void;
  onOpenToolLibrary(): void;
  onSaveParentTrace(): void;
  onDiscardPendingBranch(): void;
  onActionContextChange(context: "ordinary" | "evaluation"): void;
}

export function RequestComposer({
  requestDraft,
  templates,
  evaluations,
  evaluationExecution,
  project,
  settings,
  readiness,
  pendingDestination,
  onReadinessAction,
  onDestinationHandled,
  activeProfile,
  pendingBranch,
  requestPreview,
  n8nImportDisabledReason,
  onOpenConnectionSettings,
  onOpenN8nImport,
  onOpenToolLibrary,
  onSaveParentTrace,
  onDiscardPendingBranch,
  onActionContextChange,
}: RequestComposerProps) {
  const [tab, setTab] = useState<RequestTab>("messages");
  // Collapsed by default: the settings summary says what the next run will
  // send, which is what most visits to this pane need, and the message list
  // starts higher up for the visits that do not.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [focusModeTab, setFocusModeTab] = useState<RequestTab>("messages");
  const composerRef = useRef<HTMLElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  const selectedProjectToolCount = requestDraft.tools.filter(({ id }) =>
    requestDraft.enabledToolIds.includes(id),
  ).length;
  const selectedToolCount = selectedProjectToolCount + requestDraft.requestTools.length;
  // A newly imported snapshot is always shown before its notice is dismissed.
  const activeTab = templates.importNotice ? "messages" : tab;

  useEffect(() => {
    onActionContextChange(activeTab === "evaluations" ? "evaluation" : "ordinary");
    return () => onActionContextChange("ordinary");
  }, [activeTab, onActionContextChange]);

  // Focus mode belongs to the messages tab. Leaving it drops the state here
  // rather than at each navigation call site, so a tab change from anywhere —
  // the tab strip, a readiness destination, a notice — cannot leave focus mode
  // latent and reopen it on return. Adjusting during render keeps the discarded
  // state from reaching the DOM at all, unlike a post-commit effect.
  if (focusModeTab !== activeTab) {
    setFocusModeTab(activeTab);
    if (focusMode) setFocusMode(false);
  }

  const requestFocusMode = focusMode && activeTab === "messages";

  const { close: closeFocusMode } = useFocusMode({
    open: requestFocusMode,
    setOpen: setFocusMode,
    containerRef: composerRef,
    triggerRef: focusToggleRef,
    initialFocusSelector: ".message-card textarea:not([disabled])",
  });

  function routeReadinessAction(action: RunReadinessAction): void {
    onReadinessAction(action.destination);
  }

  useEffect(() => {
    if (pendingDestination?.surface !== "request") return;
    if (activeTab !== pendingDestination.tab) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setTab(pendingDestination.tab);
      });
      return () => { cancelled = true; };
    }
    // The model field only exists while the settings panel is expanded, so a
    // readiness destination that names it opens the panel first and focuses on
    // the following pass rather than silently finding nothing to focus.
    if (pendingDestination.control === "model" && !settingsOpen) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setSettingsOpen(true);
      });
      return () => { cancelled = true; };
    }
    const target =
      pendingDestination.control === "model"
        ? modelRef.current
        : pendingDestination.control === "tool-manifest"
          ? composerRef.current?.querySelector<HTMLElement>(
              '[data-readiness-target="tool-manifest"]',
            ) ?? null
          : pendingDestination.control === "prompt-library"
            ? composerRef.current?.querySelector<HTMLElement>(
                '[data-readiness-target="prompt-library"]',
              ) ?? null
            : pendingDestination.entityId
              ? pendingDestination.control === "template-variable" && pendingDestination.fieldName
                ? composerRef.current?.querySelector<HTMLTextAreaElement>(
                    `[data-template-use-id="${pendingDestination.entityId}"] textarea[data-template-variable="${pendingDestination.fieldName}"]`,
                  ) ?? null
                : composerRef.current?.querySelector<HTMLElement>(
                    `[data-template-use-id="${pendingDestination.entityId}"]`,
                  ) ?? null
              : null;
    if (!target) return;
    // A variable row can be collapsed. Opening it through the DOM property
    // fires the toggle event the card listens to, so its own state stays in
    // step with what is now on screen.
    const disclosure = target.closest?.("details");
    if (disclosure && !disclosure.open) disclosure.open = true;
    target.scrollIntoView?.({ block: "center" });
    target.focus();
    onDestinationHandled();
  }, [activeTab, onDestinationHandled, pendingDestination, settingsOpen]);

  return (
    <section
      aria-label={requestFocusMode ? "Request composer focus mode" : undefined}
      aria-modal={requestFocusMode ? "true" : undefined}
      className={requestFocusMode ? "composer focus-mode-surface composer-focus-mode" : "composer"}
      ref={composerRef}
      role={requestFocusMode ? "dialog" : undefined}
    >
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
            { id: "templates", label: "Prompt library", count: project?.promptTemplates.filter(({ archivedAt }) => !archivedAt).length ?? 0 },
            { id: "tools", label: "Tools", count: selectedToolCount },
            { id: "evaluations", label: "Evaluations", count: evaluations.project?.evaluationSuites.length ?? 0 },
          ]}
        />
        {activeTab === "messages" ? (
          <div className="request-header-actions">
            <button className="text-button header-text-action" onClick={templates.addComposerMessage}>
              + Add message
            </button>
            <FocusModeToggle
              className="request-focus-toggle"
              open={requestFocusMode}
              subject="request composer"
              toggleRef={focusToggleRef}
              onToggle={() => (requestFocusMode ? closeFocusMode() : setFocusMode(true))}
            />
          </div>
        ) : activeTab === "tools" ? (
          <button className="text-button header-text-action" type="button" onClick={requestDraft.addTool}>
            + Add tool
          </button>
        ) : null}
      </div>
      {activeTab !== "evaluations" && (
        <RunReadinessNotice {...(readiness ? { readiness } : {})} onAction={routeReadinessAction} />
      )}
      {templates.importNotice && (
        <div className="workbench-notice" role="status">
          <div className="workbench-notice-copy">
            <strong>
              Imported &ldquo;{templates.importNotice.name}&rdquo;{templates.importNotice.template ? " as a reusable template" : ""}
            </strong>
            <span>
              {templates.importNotice.template
                ? `${templates.importNotice.variableCount} ${templates.importNotice.variableCount === 1 ? "variable" : "variables"} imported from the saved execution.`
                : "Execution messages imported into the composer."}
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
          Branching from run <code>{pendingBranch.parentRunId}</code> at message <code>{pendingBranch.branchMessageId}</code>. Original trace unchanged.
          {pendingBranch.parentTraceNeedsSaving && (
            <button className="button secondary" type="button" onClick={onSaveParentTrace}>Save trace…</button>
          )}
          <button className="button secondary" type="button" onClick={onDiscardPendingBranch}>Discard branch</button>
        </div>
      )}

      <div className="pane-scroll request-content">
        {activeTab === "messages" ? (
          <>
            <div className="run-settings">
              <RequestSettings
                {...settings}
                modelInputRef={modelRef}
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                scopeNote={project ? "Project override" : "Profile default"}
                action={<button className="text-button" type="button" onClick={onOpenConnectionSettings}>Connection settings</button>}
              />
              {/* Outside the panel deliberately: how many tools accompany the
                  request is not one of the inference options, and its blocked
                  variant must stay readable while the panel is collapsed. */}
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
            </div>
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
          <ProjectTemplatesPane key={project?.projectId ?? "unsaved-project"} templates={project?.promptTemplates ?? []} connectionRequirements={project?.connectionRequirements ?? []} defaultConnectionRequirementId={project?.defaults.target.connectionRequirementId} usageCounts={templates.templateUsageCounts} itemCount={templates.activeProjectRevision?.items.length ?? requestDraft.messages.length} n8nImportDisabledReason={n8nImportDisabledReason} onOpenN8nImport={onOpenN8nImport} onCreate={templates.createProjectTemplate} onSave={templates.saveProjectTemplate} onRename={templates.renameProjectTemplate} onArchive={templates.archiveProjectTemplate} onRestore={templates.restoreProjectTemplate} onInsert={(...args) => { templates.insertProjectTemplate(...args); setTab("messages"); }} />
        ) : activeTab === "tools" ? (
          <ToolsPane tools={requestDraft.tools} requestTools={requestDraft.requestTools} enabledToolIds={requestDraft.enabledToolIds} activeProfileName={activeProfile.name} toolsEnabled={settings.toolsEnabled} onOpenLibrary={onOpenToolLibrary} onOpenConnectionSettings={onOpenConnectionSettings} onAddTool={requestDraft.addTool} onRemoveTool={requestDraft.removeTool} onUpdateTool={requestDraft.updateTool} onSetToolEnabled={requestDraft.setToolEnabled} mockForTool={requestDraft.mockForTool} onUpdateToolMock={requestDraft.updateToolMock} onRemoveRequestTool={requestDraft.removeRequestTool} />
        ) : (
          <EvaluationSuiteEditor
            authoring={evaluations}
            execution={evaluationExecution}
            modelFavorites={{ models: settings.favoriteModels, onToggle: settings.onToggleFavoriteModel }}
            onOpenTemplates={() => setTab("templates")}
          />
        )}
      </div>
    </section>
  );
}
