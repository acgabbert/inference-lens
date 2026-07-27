"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ProviderCapabilities,
  RichInferenceRequest,
} from "../packages/core/src/types";
import {
  createProjectFile,
} from "../packages/core/src/project";
import { createEntityId, transcriptFromRunState } from "../packages/core/src/run-kernel";
import type {
  RunState,
  RunTrace,
  ConversationMessage,
  ConversationId,
  ConversationRevisionId,
  MessageId,
  RunId,
} from "../packages/core/src/run-kernel";
import {
  createInferenceTransport,
  isTauriRuntime,
} from "./tauri-inference-transport.client";
import { AppErrorBoundary } from "./app-error-boundary.client";
import { projectFolderAccessAvailable } from "./project-workspace.client";
import { emptyToolRegistry } from "../packages/core/src/tool-registry";
import type {
  ToolRegistryV1,
} from "../packages/core/src/tool-registry";
import {
  readToolRegistry,
  writeToolRegistry,
} from "./tool-registry-store.client";
import { ToolRegistryModal } from "./tool-registry-modal.client";
import { useModelDiscovery } from "./use-model-discovery.client";
import { useConnectionProfiles } from "./use-connection-profiles.client";
import { useRequestDraft } from "./use-request-draft.client";
import { useProjectWorkspace } from "./use-project-workspace.client";
import { ConnectionDrawer } from "./connection-drawer.client";
import { Topbar } from "./topbar.client";
import { ResponseOutput } from "./response-output.client";
import { WorkbenchShell } from "./workbench-shell.client";
import type { WorkbenchView } from "./workbench-shell.client";
import { RunTracePanel } from "./run-trace-panel.client";
import { RunHistoryDrawer } from "./run-history-drawer.client";
import type { ProjectRunHistoryItem } from "./use-project-run-history.client";
import { useProjectRunHistory } from "./use-project-run-history.client";
import {
  ConfirmationDialog,
} from "./confirmation-dialog.client";
import { runReadiness } from "./run-readiness.client";
import { useProjectTemplates } from "./use-project-templates.client";
import { RequestComposer } from "./request-composer.client";
import { prepareWorkbenchRun } from "./prepare-workbench-run.client";
import { useRunSession } from "./use-run-session.client";

const inferenceTransport = createInferenceTransport();

const MARKDOWN_PREVIEW_STORAGE_KEY = "trace-lens:markdown-preview:v1";

interface BranchContext {
  parentRunId: RunId;
  parentConversationRevisionId?: ConversationRevisionId;
  branchMessageId: MessageId;
  parentTraceNeedsSaving: boolean;
}

function subscribeToDesktopRuntime(): () => void {
  return () => {};
}

function serverDesktopRuntime(): boolean {
  return false;
}

function useDesktopRuntime(): boolean {
  return useSyncExternalStore(
    subscribeToDesktopRuntime,
    isTauriRuntime,
    serverDesktopRuntime,
  );
}

function useProjectFolderAccess(): boolean {
  return useSyncExternalStore(
    subscribeToDesktopRuntime,
    projectFolderAccessAvailable,
    serverDesktopRuntime,
  );
}

const defaultUserPrompts = [
  "Write a tiny mystery set in a lighthouse, ending with an unexpected kindness, in two sentences.",
  "Describe the first sunrise on Mars from the perspective of a botanist in two sentences.",
  "Invent a folktale explaining why thunder always follows lightning in two sentences.",
  "Write a product launch announcement for a backpack that can translate bird songs in two sentences.",
  "Explain the tradeoff between a cache and a database index to a new engineer in two sentences.",
  "Suggest a graceful recovery plan for a web app whose payment API has begun timing out in two sentences.",
  "Write a TypeScript function that returns the unique values in an array, then explain its time complexity in two sentences.",
  "Describe how you would make a command-line tool feel friendly to a first-time user in two sentences.",
  "Compare event-driven and polling-based systems through the lens of a busy restaurant in two sentences.",
  "Propose a concise commit message and pull-request summary for fixing an off-by-one pagination bug in two sentences.",
  "Write a detective's field note about a suspiciously helpful houseplant in two sentences.",
  "Explain how a password manager improves security without using technical jargon in two sentences.",
] as const;

function createInitialMessages(
  userPrompt: string = defaultUserPrompts[0],
): ConversationMessage[] {
  return [
    {
      id: createEntityId("message", crypto.randomUUID()),
      role: "system",
      content: [{ type: "text", text: "You are a concise, thoughtful assistant." }],
    },
    {
      id: createEntityId("message", crypto.randomUUID()),
      role: "user",
      content: [{ type: "text", text: userPrompt }],
    },
  ];
}

function chooseDefaultUserPrompt(): string {
  return defaultUserPrompts[
    Math.floor(Math.random() * defaultUserPrompts.length)
  ];
}

type DisplayStatus = "idle" | "running" | "waiting" | "complete" | "failed";
function displayStatus(state: RunState | null): DisplayStatus {
  if (!state) return "idle";
  switch (state.status.kind) {
    case "completed":
      return "complete";
    case "awaiting_tool_results":
      return "waiting";
    case "paused":
      return state.status.reason === "attempt_failed" ? "failed" : "waiting";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "running";
  }
}

function HomeContent() {
  // Keep the server render and the browser's first render identical. The
  // Tauri bridge exists only in the browser, so checking it during render
  // would otherwise change the hydrated markup.
  const isDesktopRuntime = useDesktopRuntime();
  const folderAccessAvailable = useProjectFolderAccess();
  // Declared before model discovery below, which reads `credential.prepare`
  // during render.
  const {
    profiles,
    activeProfile,
    capabilities: activeCapabilities,
    selectProfile,
    addProfile,
    updateActiveProfile,
    setCapabilityOverride,
    credential,
  } = useConnectionProfiles({ isDesktopRuntime });
  const [toolRegistry, setToolRegistry] = useState<ToolRegistryV1>(
    emptyToolRegistry(),
  );
  const [toolRegistryLoaded, setToolRegistryLoaded] = useState(false);
  const [toolRegistryOpen, setToolRegistryOpen] = useState(false);
  const [connectionDrawerOpen, setConnectionDrawerOpen] = useState(false);
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  const [savedRunVersion, setSavedRunVersion] = useState(0);
  const [workbenchView, setWorkbenchView] =
    useState<WorkbenchView>("request");
  const [traceOpen, setTraceOpen] = useState(true);
  const [outputFollowing, setOutputFollowing] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [markdownPreviewLoaded, setMarkdownPreviewLoaded] = useState(false);
  const templateSessionRef = useRef<{ resetRunOverrides(): void } | null>(null);
  const project = useProjectWorkspace({
    activeProfileId: activeProfile.id,
    folderAccessAvailable,
    createProject() {
      return createProjectFile({
        name: "Untitled Trace Lens project",
        request: currentRequest(),
      });
    },
    currentDraft() {
      const activeRevision = projectFile?.conversationRevisions.find(
        ({ id }) => id === projectFile.defaults.conversationRevisionId,
      );
      return {
        messages,
        ...(activeRevision ? { items: activeRevision.items } : {}),
        model: activeModel,
        temperature: activeTemperature,
        tools: serializedTools(),
        toolMocks,
        enabledToolIds,
      };
    },
    onApplyDraft(draft) {
      replaceProjectDraft(draft);
      templateSessionRef.current?.resetRunOverrides();
      setBranchContext(null);
      setSessionModel(draft.model);
      setSessionTemperature(draft.temperature ?? 0.7);
      runSession.reset();
    },
  });
  const {
    projectFile,
    projectWorkspace,
    projectDirty,
    projectError,
    projectErrorKind,
    mappedProfileId,
  } = project;
  const runHistory = useProjectRunHistory(
    projectWorkspace,
    runHistoryOpen,
    savedRunVersion,
  );
  const {
    messages,
    tools,
    toolMocks,
    enabledToolIds,
    requestTools,
    serializedTools,
    resolvedTools,
    resetMessages,
    addMessage,
    removeMessage,
    updateMessage,
    addTool,
    updateTool,
    removeTool,
    setToolEnabled,
    mockForTool,
    updateToolMock,
    attachRegistryToolToProject,
    attachRegistryToolToRequest,
    removeRequestTool,
    clearRequestTools,
    replaceProjectDraft,
  } = useRequestDraft({
    initialMessages: createInitialMessages(),
    onProjectDirty: project.markDirty,
    onProjectError: project.setError,
  });
  const [sessionModel, setSessionModel] = useState<string>();
  const [sessionTemperature, setSessionTemperature] = useState<number>();
  const adHocConversationIdRef = useRef<ConversationId | null>(null);
  const outputScrollRef = useRef<HTMLDivElement | null>(null);
  const [branchContext, setBranchContext] = useState<BranchContext | null>(null);
  const runSession = useRunSession({
    transport: inferenceTransport,
    prepareCredential: credential.prepare,
    currentDiagnosticRequest: currentRequest,
    resolveToolResultDraft(call) {
      const definition = tools.find((tool) => tool.name === call.name);
      const mock = definition ? mockForTool(definition.id) : undefined;
      return mock?.enabled
        ? { text: mock.result.content.map(({ text }) => text).join(""), resolution: { kind: "mock", ruleId: mock.id } }
        : undefined;
    },
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
  });
  const { runState, isRequestActive, toolResultDrafts, traceStorage, hasDiagnosticCapture } = runSession;
  const nonBranchableMessageIds = new Set(
    runState?.input?.templateResolutions.flatMap((resolution) =>
      resolution.outputMessageIds.slice(0, -1),
    ) ?? [],
  );
  const transcript = runState ? transcriptFromRunState(runState) : [];

  useEffect(() => {
    const promptId = window.setTimeout(() => {
      resetMessages(createInitialMessages(chooseDefaultUserPrompt()));
    }, 0);
    return () => window.clearTimeout(promptId);
  }, [resetMessages]);

  useEffect(() => {
    const registryId = window.setTimeout(() => {
      setToolRegistry(readToolRegistry());
      setToolRegistryLoaded(true);
    }, 0);
    return () => window.clearTimeout(registryId);
  }, []);

  useEffect(() => {
    const previewId = window.setTimeout(() => {
      const saved = window.localStorage.getItem(MARKDOWN_PREVIEW_STORAGE_KEY);
      if (saved === "raw") setMarkdownPreview(false);
      setMarkdownPreviewLoaded(true);
    }, 0);
    return () => window.clearTimeout(previewId);
  }, []);

  useEffect(() => {
    if (!markdownPreviewLoaded) return;
    window.localStorage.setItem(
      MARKDOWN_PREVIEW_STORAGE_KEY,
      markdownPreview ? "markdown" : "raw",
    );
  }, [markdownPreview, markdownPreviewLoaded]);

  useEffect(() => {
    if (!toolRegistryLoaded) return;
    writeToolRegistry(toolRegistry);
  }, [toolRegistry, toolRegistryLoaded]);

  const activeModel = sessionModel ?? activeProfile.model;
  const activeTemperature =
    sessionTemperature ?? activeProfile.temperature ?? 0.7;
  const selectedProjectToolCount = tools.filter(({ id }) =>
    enabledToolIds.includes(id),
  ).length;
  const selectedToolCount = selectedProjectToolCount + requestTools.length;
  const activeConnectionRequirement = projectFile?.connectionRequirements.find(
    ({ id }) => id === projectFile.defaults.target.connectionRequirementId,
  );
  const { discovery: activeModelDiscovery, loadModels } = useModelDiscovery({
    profileId: activeProfile.id,
    endpoint: activeProfile.endpoint,
    capabilities: activeCapabilities,
    transport: inferenceTransport,
    prepareCredential: credential.prepare,
  });

  const { output, reasoning, status } = (() => {
    const attempts =
      runState?.turns.flatMap((turn) => {
        const latest = turn.attempts.at(-1);
        return latest ? [latest] : [];
      }) ?? [];
    return {
      output: attempts.map((attempt) => attempt.text).join(""),
      reasoning: attempts.map((attempt) => attempt.reasoning).join(""),
      status: displayStatus(runState),
    };
  })();

  const completedToolCalls = runState?.turns.flatMap(
    (turn) => turn.attempts.at(-1)?.completedToolCalls ?? [],
  ) ?? [];

  useEffect(() => {
    if (!outputFollowing) return;
    const frame = window.requestAnimationFrame(() => {
      const element = outputScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [completedToolCalls.length, output, outputFollowing, reasoning]);

  function updateOutputFollowState(): void {
    const element = outputScrollRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    setOutputFollowing(distanceFromBottom < 56);
  }

  function jumpToLatestOutput(): void {
    const element = outputScrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setOutputFollowing(true);
  }

  function currentRequest(): RichInferenceRequest {
    return {
      provider: "openai-compatible",
      endpoint: activeProfile.endpoint,
      model: activeModel,
      messages,
      temperature: activeTemperature,
      capabilities: activeCapabilities,
    };
  }

  function ensureProjectDocument() {
    return projectFile
      ? project.currentProjectDocument()
      : project.materializeProject();
  }

  const templates = useProjectTemplates({
    projectFile,
    projectDirty,
    branchParentRevisionId: branchContext?.parentConversationRevisionId,
    ensureProjectDocument,
    adoptProjectMutation: project.adoptProjectMutation,
    replaceProjectDraft,
    messages,
    tools,
    toolMocks,
    enabledToolIds,
    serializedTools,
    resolvedTools,
    requestTools,
    currentRequest,
    addDraftMessage: addMessage,
    updateDraftMessage: updateMessage,
    removeDraftMessage: removeMessage,
  });
  useEffect(() => {
    templateSessionRef.current = templates;
    return () => {
      templateSessionRef.current = null;
    };
  }, [templates]);

  function editFromHere(messageId: MessageId): void {
    if (!runState || !["completed", "cancelled", "failed"].includes(runState.status.kind)) {
      return;
    }
    const index = transcript.findIndex(({ message }) => message.id === messageId);
    if (index < 0) return;
    resetMessages(
      structuredClone(transcript.slice(0, index + 1).map(({ message }) => message)),
    );
    setBranchContext({
      parentRunId: runState.runId,
      parentConversationRevisionId: runState.input?.conversationRevisionId,
      branchMessageId: messageId,
      parentTraceNeedsSaving:
        traceStorage?.kind === "unsaved" || traceStorage?.kind === "error",
    });
    setWorkbenchView("request");
  }

  function setEditorModel(model: string): void {
    if (projectFile) {
      setSessionModel(model);
      project.markDirty();
    } else {
      updateActiveProfile({ model });
    }
  }

  function setEditorTemperature(temperature: number): void {
    if (projectFile) {
      setSessionTemperature(temperature);
      project.markDirty();
    } else {
      updateActiveProfile({ temperature });
    }
  }

  /** Selecting a profile also satisfies an open project's connection mapping. */
  function chooseProfile(profileId: string): void {
    selectProfile(profileId);
    project.mapProfile(profileId);
  }

  function changeCapability(
    key: keyof ProviderCapabilities,
    enabled: boolean,
  ): void {
    setCapabilityOverride(key, enabled);
    // Allowing tools resolves the only project failure the toggle can cause.
    if (key === "tools" && enabled) project.clearToolsDisabledError();
  }

  async function run() {
    project.clearErrorKind();
    const prepared = prepareWorkbenchRun({
      request: currentRequest(),
      resolvedTools: resolvedTools(),
      requestTools,
      activeCapabilities,
      activeProfile: { id: activeProfile.id, name: activeProfile.name },
      projectFile: projectFile ?? undefined,
      mappedProfileId,
      runOverrides: templates.runOverrides,
      branchContext: branchContext ?? undefined,
      adHocConversationId: adHocConversationIdRef.current,
    });
    if (!prepared.ok) {
      if (prepared.errorKind === "tools-disabled") {
        project.setToolsDisabledError(prepared.message);
      } else {
        project.setError(prepared.message);
      }
      return;
    }
    if (prepared.projectMutation) project.adoptBranchRevision(prepared.projectMutation);
    if (prepared.adHocConversationId) {
      adHocConversationIdRef.current = prepared.adHocConversationId;
    }
    if (prepared.executedRevisionId) {
      templates.markRevisionExecuted(prepared.executedRevisionId);
    }
    if (prepared.consumesPendingBranch) setBranchContext(null);

    setWorkbenchView("response");
    setOutputFollowing(true);
    clearRequestTools();
    await runSession.start(prepared.input, {
      request: prepared.request,
      workspace: projectWorkspace,
      ...(prepared.branchedFrom ? { branchedFrom: prepared.branchedFrom } : {}),
    });
  }

  async function continueRun(): Promise<void> { setWorkbenchView("response"); setOutputFollowing(true); await runSession.continueRun(); }
  async function retryRun(): Promise<void> { setWorkbenchView("response"); setOutputFollowing(true); await runSession.retryRun(); }
  function adoptRunTrace(trace: RunTrace, origin: { workspace: NonNullable<typeof projectWorkspace>; fileName: string } | { workspace: null; fileName: string }): void { setBranchContext(null); setWorkbenchView("response"); setTraceOpen(true); runSession.adoptTrace(trace, origin); project.setError(undefined, { clearKind: true }); }
  async function importRunTrace(event: React.ChangeEvent<HTMLInputElement>): Promise<void> { try { await runSession.importRunTrace(event); setBranchContext(null); setWorkbenchView("response"); setTraceOpen(true); project.setError(undefined, { clearKind: true }); } catch (error) { project.setError(error instanceof Error ? error.message : "Could not import the run trace.", { clearKind: true }); } }
  async function openHistoryTrace(item: ProjectRunHistoryItem): Promise<void> {
    const workspace = projectWorkspace;
    if (!workspace) throw new Error("The project folder is no longer open.");
    const trace = await runHistory.readTrace(item.fileName);
    adoptRunTrace(trace, { workspace, fileName: item.fileName });
    setRunHistoryOpen(false);
  }

  const runReachedTerminalStatus = Boolean(
    runState &&
      ["completed", "cancelled", "failed"].includes(runState.status.kind),
  );
  const readiness = runReadiness({
    projectOpen: Boolean(projectFile),
    connectionMapped: Boolean(mappedProfileId),
    activeProfileName: activeProfile.name,
    activeProfileEndpoint: activeProfile.endpoint,
    selectedToolCount,
    toolsEnabled: activeCapabilities.tools,
    ...(activeConnectionRequirement
      ? { requiredEndpoint: activeConnectionRequirement.endpoint }
      : {}),
    ...(templates.templateWorkbench.resolutionError
      ? { templateResolutionError: templates.templateWorkbench.resolutionError }
      : {}),
    templateIssues:
      templates.activeProjectResolution?.diagnostics.map(
        ({ templateUseId, diagnostic }) => ({
          templateUseId,
          ...(diagnostic.code === "missing-template-variable"
            ? { variableName: diagnostic.name }
            : {}),
        }),
      ) ?? [],
  });

  return (
    <main
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void project.saveProject();
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter" &&
          !isRequestActive
        ) {
          event.preventDefault();
          if (readiness?.blocked) return;
          if (
            runState?.status.kind === "paused" &&
            runState.status.reason === "attempt_failed"
          ) {
            void retryRun();
          } else if (runState?.status.kind !== "awaiting_tool_results") {
            void run();
          }
        }
      }}
    >
      <Topbar
        profiles={profiles}
        activeProfile={activeProfile}
        activeModel={activeModel}
        hasCredential={credential.hasCredential}
        projectName={projectFile?.name}
        projectDirty={projectDirty}
        folderAccessAvailable={folderAccessAvailable}
        hasDiagnosticCapture={hasDiagnosticCapture}
        hasRunTrace={runReachedTerminalStatus}
        hasProjectWorkspace={Boolean(projectWorkspace)}
        runHistoryBlocked={Boolean(runState) && !runReachedTerminalStatus}
        isRequestActive={isRequestActive}
        awaitingToolResults={runState?.status.kind === "awaiting_tool_results"}
        retryableFailure={
          runState?.status.kind === "paused" &&
          runState.status.reason === "attempt_failed"
        }
        runDisabled={Boolean(readiness?.blocked)}
        runDisabledReason={readiness?.blocked ? readiness.summary : undefined}
        onChooseProfile={chooseProfile}
        onOpenConnections={() => setConnectionDrawerOpen(true)}
        onNewProject={() => void project.newProjectFolder()}
        onOpenProject={() => void project.openProjectWorkspace()}
        onSaveProject={() => void project.saveProject()}
        onImportProject={(event) => void project.importProject(event)}
        onExportProject={project.exportProject}
        onOpenToolLibrary={() => setToolRegistryOpen(true)}
        onDownloadDiagnostics={runSession.downloadDiagnostics}
        onDownloadRunTrace={() => void runSession.exportRunTrace()}
        onImportRunTrace={(event) => void importRunTrace(event)}
        onOpenRunHistory={() => setRunHistoryOpen(true)}
        onStop={runSession.stop}
        onRun={() => void run()}
        onContinue={() => void continueRun()}
        onRetry={() => void retryRun()}
      />

      {projectError && (
        <div className="project-error" role="alert">
          <span>{projectError}</span>
          <div className="project-error-actions">
            {projectErrorKind === "tools-disabled" && (
              <button
                type="button"
                onClick={() => setConnectionDrawerOpen(true)}
              >
                Open connection settings
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                project.dismissError();
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <ConnectionDrawer
        open={connectionDrawerOpen}
        onClose={() => setConnectionDrawerOpen(false)}
        profiles={profiles}
        activeProfile={activeProfile}
        capabilities={activeCapabilities}
        credential={credential}
        isDesktopRuntime={isDesktopRuntime}
        onSelectProfile={chooseProfile}
        onAddProfile={() => {
          const profileId = addProfile();
          project.mapProfile(profileId);
        }}
        onUpdateProfile={updateActiveProfile}
        onCapabilityChange={changeCapability}
        connectionRequirement={activeConnectionRequirement}
        mappedProfileId={mappedProfileId}
        onMapProfile={() => {
          project.mapActiveProfile();
        }}
      />

      <RunHistoryDrawer
        open={runHistoryOpen}
        projectName={projectFile?.name}
        selectedRunId={runState?.runId}
        history={runHistory}
        onClose={() => setRunHistoryOpen(false)}
        onSelect={(item) => openHistoryTrace(item)}
      />

      <WorkbenchShell
        view={workbenchView}
        onViewChange={setWorkbenchView}
        responseStatus={status}
        request={
          <RequestComposer
            messages={messages}
            projectId={projectFile?.projectId}
            promptTemplates={projectFile?.promptTemplates ?? []}
            hasProject={Boolean(projectFile)}
            templates={templates}
            {...(readiness ? { readiness } : {})}
            pendingBranch={branchContext ?? undefined}
            activeModel={activeModel}
            activeModelDiscovery={activeModelDiscovery}
            activeTemperature={activeTemperature}
            selectedToolCount={selectedToolCount}
            requestToolCount={requestTools.length}
            toolsEnabled={activeCapabilities.tools}
            activeProfileName={activeProfile.name}
            tools={tools}
            requestTools={requestTools}
            enabledToolIds={enabledToolIds}
            onMapActiveProfile={project.mapActiveProfile}
            onOpenConnectionSettings={() => setConnectionDrawerOpen(true)}
            onLoadModels={(force) => void loadModels(force)}
            onModelChange={setEditorModel}
            onTemperatureChange={setEditorTemperature}
            onSavePendingBranchTrace={() => void runSession.exportRunTrace()}
            onDiscardPendingBranch={() => setBranchContext(null)}
            onOpenToolLibrary={() => setToolRegistryOpen(true)}
            onAddTool={addTool}
            onRemoveTool={removeTool}
            onUpdateTool={updateTool}
            onSetToolEnabled={setToolEnabled}
            mockForTool={mockForTool}
            onUpdateToolMock={updateToolMock}
            onRemoveRequestTool={removeRequestTool}
          />
        }
        response={
        <section className="result">
          <ResponseOutput
            output={output}
            reasoning={reasoning}
            status={status}
            runState={runState}
            isRequestActive={isRequestActive}
            markdownPreview={markdownPreview}
            outputFollowing={outputFollowing}
            outputScrollRef={outputScrollRef}
            completedToolCalls={completedToolCalls}
            toolResultDrafts={toolResultDrafts}
            traceStorage={traceStorage}
            transcript={transcript}
            nonBranchableMessageIds={nonBranchableMessageIds}
            branchedFrom={runSession.branchedFrom}
            onMarkdownPreviewChange={setMarkdownPreview}
            onOutputScroll={updateOutputFollowState}
            onJumpToLatest={jumpToLatestOutput}
            onToolResultDraftChange={runSession.updateToolResultDraft}
            onContinue={() => void continueRun()}
            onRetry={() => void retryRun()}
            onSaveTrace={() => void runSession.exportRunTrace()}
            onEditFromHere={editFromHere}
          />

          <RunTracePanel
            open={traceOpen}
            runState={runState}
            onOpenChange={setTraceOpen}
          />
        </section>
        }
      />
      {toolRegistryOpen && (
        <ToolRegistryModal
          open
          registry={toolRegistry}
          onChange={setToolRegistry}
          onAttachToProject={attachRegistryToolToProject}
          onAttachToRequest={attachRegistryToolToRequest}
          onClose={() => setToolRegistryOpen(false)}
        />
      )}
      {templates.confirmation && (
        <ConfirmationDialog
          request={templates.confirmation}
          onClose={templates.dismissConfirmation}
        />
      )}
    </main>
  );
}

export default function Home() {
  return (
    <AppErrorBoundary>
      <HomeContent />
    </AppErrorBoundary>
  );
}
