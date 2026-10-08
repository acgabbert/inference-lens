"use client";

import {
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import type { ProviderCapabilities } from "../packages/core/src/types";
import {
  createProjectFile,
  updateConnectionRequirementEndpoint,
} from "../packages/core/src/project";
import {
  createEntityId,
  createSingleTurnRunExecution,
} from "../packages/core/src/run-kernel";
import { modalOwnsKeyboardCommands } from "./keyboard-command-scope.client";
import type {
  RunTrace,
  ConversationMessage,
  MessageId,
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
  ToolDefinition,
} from "../packages/core/src/run-kernel";
import { buildChatCompletionsRequest } from "../packages/core/src/openai-compatible";
import {
  createInferenceTransport,
  isTauriRuntime,
} from "./tauri-inference-transport.client";
import { AppErrorBoundary } from "./app-error-boundary.client";
import { useInsecureOriginNotice } from "./use-insecure-origin.client";
import { randomUUID } from "../packages/core/src/random-id.ts";
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
import { N8nImportModal } from "./n8n-import-modal.client";
import { ProjectCreationDialog } from "./project-creation-dialog.client";
import { ProjectReplacementDialog } from "./project-replacement-dialog.client";
import { useModelDiscovery } from "./use-model-discovery.client";
import { useConnectionProfiles } from "./use-connection-profiles.client";
import { toggleFavoriteModel } from "./profile-store.client";
import { useRequestDraft } from "./use-request-draft.client";
import { useRequestSettings } from "./request/use-request-settings.client";
import { useProjectWorkspace } from "./use-project-workspace.client";
import { ConnectionDrawer } from "./connection-drawer.client";
import { Topbar } from "./topbar.client";
import { ResponseOutput } from "./response-output.client";
import { WorkbenchShell } from "./workbench-shell.client";
import type { WorkbenchView } from "./workbench-shell.client";
import { RunTracePanel } from "./run-trace-panel.client";
import { traceFileName } from "../packages/core/src/run-trace";
import { RunHistoryDrawer } from "./run-history-drawer.client";
import { useEvaluationBaselines } from "./evaluations/use-evaluation-baselines.client";
import type {
  ProjectExperimentHistoryItem,
  ProjectRunHistoryItem,
} from "./use-project-run-history.client";
import { useProjectRunHistory } from "./use-project-run-history.client";
import {
  ConfirmationDialog,
} from "./confirmation-dialog.client";
import { runEmptyStatePresentation, runReadiness } from "./run-readiness.client";
import type { ReadinessDestination } from "./run-readiness.client";
import { RUN_READINESS_SUMMARY_ID } from "./run-readiness-notice.client";
import type {
  ConfirmationDialogRequest,
} from "./confirmation-dialog.client";
import { prepareWorkbenchRun } from "./run/prepare-workbench-run.client";
import { useRunSession } from "./run/use-run-session.client";
import { RunEvidenceDetail } from "./run/run-evidence-detail.client";
import { useResponseView } from "./run/use-response-view.client";
import { useBatchCompletion } from "./run/use-batch-completion.client";
import { usePendingBranch } from "./run/use-pending-branch.client";
import { useRunsNavigation } from "./run/use-runs-navigation.client";
import { toolBindingFor } from "./run/run-session-state.client";
import { useCommandTools } from "./tools/use-command-tools.client";
import { useMcpConsents } from "./tools/use-mcp-consents.client";
import { commandToolUnavailableMessage } from "./tools/command-tool-availability.client";
import { useRepeatedExperimentSession } from "./run/use-repeated-experiment-session.client";
import { RepeatedExperimentDialog } from "./run/repeated-experiment-dialog.client";
import { useProjectTemplates } from "./templates/use-project-templates.client";
import { RequestComposer } from "./request/request-composer.client";
import { useEvaluationSuiteAuthoring } from "./evaluations/use-evaluation-suite-authoring.client";
import { useEvaluationReassessment } from "./evaluations/use-evaluation-reassessment.client";
import { useEvaluationExecutionSession } from "./evaluations/use-evaluation-execution-session.client";
import { useEvaluationWorkspace } from "./evaluations/use-evaluation-workspace.client";
import { useEvaluationCaseSource } from "./evaluations/use-evaluation-case-source.client";
import { EvaluationStartDialog } from "./evaluations/evaluation-start-dialog.client";
import { PromoteTraceToCaseDialog } from "./evaluations/promote-trace-to-case-dialog.client";
import type { EvaluationComparisonReturnTarget } from "./evaluations/evaluation-comparison-workspace.client";
import { EVALUATION_PREFLIGHT_SUMMARY_ID } from "./evaluations/evaluation-suite-editor.client";
import type { AppMode } from "./modes/app-mode";
import { EvaluationsMode } from "./modes/evaluations-mode.client";
import { RunsMode } from "./modes/runs-mode.client";
import { PromptsMode } from "./modes/prompts-mode.client";
import { usePromptNavigation } from "./templates/use-prompt-navigation.client";
import { useToasts } from "./notifications/use-toasts.client";
import { ToastRegion } from "./notifications/toast-region.client";
import { AppBanner } from "./notifications/app-banner.client";
import { chooseAppBanner } from "./notifications/banner-priority.client";
import type { AppBanner as AppBannerCandidate } from "./notifications/banner-priority.client";

const inferenceTransport = createInferenceTransport();

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
      id: createEntityId("message", randomUUID()),
      role: "system",
      content: [{ type: "text", text: "You are a concise, thoughtful assistant." }],
    },
    {
      id: createEntityId("message", randomUUID()),
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
    profilesLoaded,
    activeProfile,
    capabilities: activeCapabilities,
    selectProfile,
    addProfile,
    updateProfile,
    updateActiveProfile,
    activeProfileDeletionRefusal,
    removeActiveProfile,
    setCapabilityOverride,
    serverDefault,
    serverDefaultProfileNotice,
    adoptServerDefaultProfile,
    dismissServerDefaultProfileNotice,
    credential,
  } = useConnectionProfiles({ isDesktopRuntime });
  const originNotice = useInsecureOriginNotice(serverDefault.containerized);
  // The transient tier. Publication is threaded into the feature hooks below as
  // an ordinary callback, the same way `onError` and `onTraceSaved` already
  // are, so every toast in the app has a reviewable path from cause to message.
  const toasts = useToasts();
  const [toolRegistry, setToolRegistry] = useState<ToolRegistryV1>(
    emptyToolRegistry(),
  );
  const [toolRegistryLoaded, setToolRegistryLoaded] = useState(false);
  const [toolRegistryOpen, setToolRegistryOpen] = useState(false);
  const [n8nImportOpen, setN8nImportOpen] = useState(false);
  const [confirmation, setConfirmation] =
    useState<ConfirmationDialogRequest>();
  const [projectCreationMode, setProjectCreationMode] =
    useState<"new" | "save" | "save-before-switch">();
  const [connectionDrawerOpen, setConnectionDrawerOpen] = useState(false);
  const [sessionPromptProjectNotice, setSessionPromptProjectNotice] =
    useState<string>();
  const [pendingReadinessDestination, setPendingReadinessDestination] =
    useState<ReadinessDestination>();
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  // Set once the suite editor's past-execution list has been expanded. Listing
  // costs a full parse of every artifact in the project folder, so neither
  // surface being open means no listing happens at all. Held here because the
  // listing is shared: this, the run-history drawer, and Runs each demand it.
  const [suiteHistoryRequested, setSuiteHistoryRequested] = useState(false);
  const [savedRunVersion, setSavedRunVersion] = useState(0);
  // Bumped when an import lands in the composer's message list, so the composer
  // returns to Messages and the newly imported snapshot is on screen. This used
  // to ride on the presence of the import notice, which stopped being possible
  // once that notice became a toast with no state behind it.
  const [importedRevision, setImportedRevision] = useState(0);
  const [workbenchView, setWorkbenchView] =
    useState<WorkbenchView>("request");
  // Navigation state, deliberately transient: a reload lands on Compose rather
  // than reopening onto a project that may no longer hold what was selected.
  // Each mode's sub-state lives in the feature hooks above this line, so
  // switching modes and back is lossless for as long as the app is open.
  const [mode, setMode] = useState<AppMode>("compose");
  const promptNavigation = usePromptNavigation();
  const [traceOpen, setTraceOpen] = useState(false);
  // A comparison is unmounted while its evidence is read in Compose. Retain
  // this tiny target at the route boundary so closing that trace returns to
  // the same case and repetition instead of silently resetting to repetition 1.
  const [comparisonReturnTarget, setComparisonReturnTarget] = useState<EvaluationComparisonReturnTarget>();
  const [comparisonTraceOpen, setComparisonTraceOpen] = useState(false);
  // The callbacks below read `requestSettings` and `projectTemplates`, both
  // declared after this hook because they read its project and mapping. Safe:
  // the workspace calls these only from project commands and effects, never
  // during render.
  const project = useProjectWorkspace({
    activeProfile,
    profiles,
    profilesLoaded,
    onActivateProfile: selectProfile,
    folderAccessAvailable,
    createFreshProject() {
      return createProjectFile({
        name: "Untitled Inference Lens project",
        request: {
          provider: "openai-compatible",
          endpoint: activeProfile.endpoint,
          model: activeProfile.model,
          messages: createInitialMessages(chooseDefaultUserPrompt()),
          temperature: activeProfile.temperature,
          responseMode: requestSettings.responseMode,
          capabilities: activeCapabilities,
        },
      });
    },
    createProject() {
      return createProjectFile({
        name: "Untitled Inference Lens project",
        request: requestSettings.currentRequest(),
      });
    },
    currentDraft() {
      const activeRevision = projectFile?.conversationRevisions.find(
        ({ id }) => id === projectFile.defaults.conversationRevisionId,
      );
      return {
        messages,
        ...(activeRevision ? { items: activeRevision.items } : {}),
        model: requestSettings.model,
        temperature: requestSettings.temperature,
        tools: serializedTools(),
        toolMocks,
        enabledToolIds,
      };
    },
    onApplyDraft(draft, projectId) {
      if (projectFile?.projectId !== projectId) clearRequestTools();
      replaceProjectDraft(draft);
      projectTemplates.clearTransientOverrides();
      // Declared after this hook because it reads the run session. Safe: a
      // draft is applied only from project commands, never during render.
      pendingBranch.clear();
      requestSettings.applyDraft(draft);
      runSession.reset();
    },
    onSaved({ name, destination }) {
      toasts.publish({
        key: "project-saved",
        title: `Saved “${name}”`,
        detail:
          destination === "folder"
            ? "Written to the project folder."
            : "Downloaded as a project file.",
        durableHome: "the project name in the topbar, which drops its unsaved marker",
      });
    },
  });
  const {
    projectFile,
    projectWorkspace,
    projectDirty,
    projectStorageState,
    projectError,
    projectErrorKind,
    mappedProfileIds,
  } = project;
  const runHistory = useProjectRunHistory(
    projectWorkspace,
    runHistoryOpen || suiteHistoryRequested || mode === "runs",
    savedRunVersion,
  );
  // Named baselines are annotations over the same artifacts the history
  // listing reads, so they share its reader rather than opening the folder a
  // second time with its own idea of what is in it.
  const evaluationBaselines = useEvaluationBaselines({
    workspace: projectWorkspace,
    readExperiment: runHistory.readExperiment,
    findExperiment: (baseline) =>
      runHistory.experiments.find(
        (item): item is Extract<typeof item, { kind: "evaluation" }> =>
          item.kind === "evaluation" && item.experimentId === baseline.experimentId,
      ),
  });
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
    moveTool,
    setToolEnabled,
    mockForTool,
    updateToolMock,
    attachRegistryToolToProject,
    attachRegistryToolToRequest,
    attachMcpToolToProject,
    attachMcpToolToRequest,
    removeRequestTool,
    saveRequestToolToProject,
    clearRequestTools,
    replaceProjectDraft,
  } = useRequestDraft({
    initialMessages: createInitialMessages(),
    onProjectDirty: project.markDirty,
    onProjectError: project.setError,
  });
  const requestSettings = useRequestSettings({
    projectFile,
    mappedProfileIds,
    profiles,
    activeProfile,
    messages,
    updateActiveProfile,
    onProjectEdited: project.markDirty,
  });
  // Device-local execution capability. Owned here only long enough to be
  // joined with the project's mocks below: what serves a tool is one question,
  // and the run session must not have to ask it twice.
  const commandTools = useCommandTools();
  const mcpConsents = useMcpConsents();
  // The one answer to "what serves this tool here?", for every run surface:
  // a local grant, else an enabled project mock.
  const bindingForTool = (tool: ToolDefinition) =>
    toolBindingFor(tool.id, mockForTool(tool.id), commandTools.bindingFor(tool.id), mcpConsents.bindingFor(tool));
  const runSession = useRunSession({
    transport: inferenceTransport,
    prepareCredential: () =>
      credential.prepareForProfile(requestSettings.profile.id, requestSettings.profile.endpoint),
    bindingForTool,
    mcpApprovalModeFor: mcpConsents.approvalModeFor,
    readTrace: runHistory.readTrace,
    onShowResponse() {
      setWorkbenchView("response");
      // Declared after this hook because it reads `runState`. Safe: the run
      // session calls this only from its run, continue, and retry commands,
      // never during render.
      responseView.followLatest();
    },
    onOpenTrace() {
      setWorkbenchView("inspect");
      setTraceOpen(true);
    },
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
    // Declared after this hook because it reads `runState`. Safe: the run
    // session resets the branch only from its adopt-trace command.
    onResetBranch() { pendingBranch.clear(); },
    onError(message) { project.setError(message, { clearKind: true }); },
    onClearError() { project.setError(undefined, { clearKind: true }); },
  });
  const { runState, isRequestActive, toolResultDrafts, traceStorage,
    hasDiagnosticCapture, visibleBranchProvenance, parentTrace, transcript } = runSession;
  const responseView = useResponseView(runState);
  const runsNavigation = useRunsNavigation({
    ...(projectFile ? { projectId: projectFile.projectId } : {}),
    readTrace: runHistory.readTrace,
  });
  const repeatedExperiment = useRepeatedExperimentSession({
    transport: inferenceTransport,
    prepareCredential: () =>
      credential.prepareForProfile(requestSettings.profile.id, requestSettings.profile.endpoint),
    bindingForTool,
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
    onError(message) { project.setError(message, { clearKind: true }); },
    onOpenTrace(trace, origin) { runSession.adoptTrace(trace, origin); },
    onFinished({ experimentId, repetitions }) {
      batchCompletion.recordFinished({ kind: "repeated", experimentId, repetitions });
    },
  });
  const evaluationExecution = useEvaluationExecutionSession({
    transport: inferenceTransport,
    prepareCredential(target) {
      const profile = profiles.find(
        ({ id }) => createEntityId("profile", id) === target.profileId,
      );
      if (!profile) return Promise.reject(new Error(`No mapped profile exists for ${target.profileId}.`));
      return credential.prepareForProfile(profile.id, target.endpoint);
    },
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
    onError(message) { project.setError(message, { clearKind: true }); },
    onOpenTrace(trace, origin) { runSession.adoptTrace(trace, origin); },
    onFinished({ experimentId }) {
      batchCompletion.recordFinished({ kind: "evaluation", experimentId });
    },
  });
  // Both sessions' `onFinished` call `batchCompletion`, declared here after
  // them because it reads their snapshots. That is safe: a session reports
  // completion only after awaiting its batch, never during render.
  const batchCompletion = useBatchCompletion({
    mode,
    repeated: repeatedExperiment,
    evaluation: evaluationExecution,
    publishToast: toasts.publish,
    viewResults: () => setMode("runs"),
  });
  // Reinterpreting a finished evaluation is its own feature with its own state,
  // so the route only joins it to the execution it reads and the project it can
  // write a correction into.
  const evaluationReassessment = useEvaluationReassessment({
    ...(evaluationExecution.execution ? { execution: evaluationExecution.execution } : {}),
    project: projectFile,
    adoptProjectMutation: project.adoptProjectMutation,
  });
  const pendingBranch = usePendingBranch({
    runState,
    transcript,
    traceStorage,
    resetMessages,
    onError(message) { project.setError(message); },
  });

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
    if (!toolRegistryLoaded) return;
    writeToolRegistry(toolRegistry);
  }, [toolRegistry, toolRegistryLoaded]);

  const selectedProjectToolCount = tools.filter(({ id }) =>
    enabledToolIds.includes(id),
  ).length;
  const selectedToolCount = selectedProjectToolCount + requestTools.length;
  const unservableToolNames = unservableTools().map(({ name }) => name);
  const { discovery: activeModelDiscovery, loadModels } = useModelDiscovery({
    profileId: requestSettings.profile.id,
    endpoint: requestSettings.profile.endpoint,
    capabilities: requestSettings.capabilities,
    transport: inferenceTransport,
    prepareCredential: () =>
      credential.prepareForProfile(requestSettings.profile.id, requestSettings.profile.endpoint),
  });

  function ensureProjectDocument() {
    return projectFile
      ? project.currentProjectDocument()
      : project.materializeProject();
  }

  const projectTemplates = useProjectTemplates({
    projectFile,
    projectDirty,
    messages,
    model: requestSettings.model,
    temperature: requestSettings.temperature,
    serializedTools,
    toolMocks,
    enabledToolIds,
    branchParentRevisionId: pendingBranch.pending?.parentConversationRevisionId,
    ensureProjectDocument,
    adoptProjectMutation: project.adoptProjectMutation,
    replaceProjectDraft,
    markProjectError: project.setError,
    resetMessages,
    addDraftMessage: addMessage,
    updateDraftMessage: updateMessage,
    removeDraftMessage: removeMessage,
    clearPendingBranch: pendingBranch.clear,
    requestConfirmation: setConfirmation,
    onImportApplied() {
      setMode("compose");
      setWorkbenchView("request");
      setImportedRevision((current) => current + 1);
      setN8nImportOpen(false);
    },
    onImported({ name, template, variableCount }) {
      toasts.publish({
        key: "prompt-imported",
        title: `Imported prompt “${name}”${template ? "" : " into Messages"}`,
        detail: template
          ? `${variableCount} ${variableCount === 1 ? "variable" : "variables"} imported from the saved execution.`
          : "Execution messages imported into the composer.",
        durableHome: template
          ? "the prompt, in Compose → Prompts"
          : "the imported messages, in Compose → Messages",
        ...(template
          ? {
              action: {
                label: "View prompt",
                onSelect: () =>
                  resolveReadiness({
                    surface: "prompts",
                    control: "prompt-library",
                  }),
              },
            }
          : {}),
      });
    },
    onSessionPromptNeedsProject(message) {
      setSessionPromptProjectNotice(message);
      setConnectionDrawerOpen(true);
      setPendingReadinessDestination({
        surface: "connections",
        control: "endpoint",
      });
    },
  });
  const evaluationAuthoring = useEvaluationSuiteAuthoring({
    project: projectFile,
    adoptProjectMutation: project.adoptProjectMutation,
    requestConfirmation: setConfirmation,
    onNotify({ templateName, messageCount, variableCount }) {
      toasts.publish({
        key: "evaluation-input-changed",
        title: `Evaluation input now uses “${templateName}”`,
        detail: `It pins ${messageCount} ${messageCount === 1 ? "message" : "messages"} and ${
          variableCount === 0
            ? "no variables"
            : `${variableCount} ${variableCount === 1 ? "variable" : "variables"}`
        }. Messages was not changed.`,
        durableHome: "the suite's revision picker, which now names this prompt",
      });
    },
  });
  const evaluationWorkspace = useEvaluationWorkspace({
    authoring: evaluationAuthoring,
    project: projectFile,
    workspace: projectWorkspace,
    profiles,
    mappedProfileIds,
    bindingForTool,
    commandToolsUnavailableReason: commandToolUnavailableMessage(commandTools),
    activityInProgress: isRequestActive || repeatedExperiment.isRunning || evaluationExecution.isRunning,
    running: evaluationExecution.isRunning,
    onBegin: evaluationExecution.begin,
    onError(message) { project.setError(message); },
    clearError() { project.clearErrorKind(); },
    runHistory,
    baselines: evaluationBaselines,
    onHistoryRequested() { setSuiteHistoryRequested(true); },
    onOpenExecution: (item) => openHistoryExperiment(item),
    onComparisonOpened() {
      // A comparison is a results surface, so anything else holding the
      // Runs mode is released the same way opening a saved execution does.
      repeatedExperiment.clear();
      evaluationExecution.clear();
      runSession.reset();
      setMode("runs");
    },
  });
  const evaluationCaseSource = useEvaluationCaseSource({
    workspace: projectWorkspace,
    project: projectFile,
    ...(evaluationAuthoring.suiteId ? { suiteId: evaluationAuthoring.suiteId } : {}),
    ...(evaluationAuthoring.focusedCaseId ? { focusedCaseId: evaluationAuthoring.focusedCaseId } : {}),
    adoptProjectMutation: project.adoptProjectMutation,
    publishToast: toasts.publish,
    onPromoted(suiteId, caseId) {
      evaluationAuthoring.selectSuite(suiteId);
      evaluationAuthoring.focusCase(caseId);
      setMode("evaluations");
    },
    onOpenTrace(trace, origin) {
      runSession.adoptTrace(trace, origin);
      setTraceOpen(true);
      setMode("compose");
      setWorkbenchView("inspect");
    },
  });
  function templateRequestPreview():
    | { body: unknown; messages: ConversationMessage[] }
    | { error: string }
    | undefined {
    if (!projectFile || !projectTemplates.activeProjectRevision) {
      return undefined;
    }
    if (projectTemplates.templateWorkbench.resolutionError) {
      return { error: projectTemplates.templateWorkbench.resolutionError };
    }
    const resolution = projectTemplates.templateWorkbench.resolution;
    if (!resolution) return undefined;
    try {
      const request = {
        ...requestSettings.currentRequest(),
        messages: resolution.messages,
      };
      const execution = createSingleTurnRunExecution(
        request,
        {
          conversationId: projectTemplates.activeProjectRevision.conversationId,
          conversationRevisionId: projectTemplates.activeProjectRevision.id,
        },
        "template-preview",
        "1970-01-01T00:00:00.000Z",
        [...resolvedTools(), ...requestTools],
        resolution.templateResolutions,
      );
      return {
        messages: resolution.messages,
        body: buildChatCompletionsRequest({
          runId: execution.runId,
          turnId: execution.turnId,
          exchangeId: execution.exchangeId,
          attempt: execution.attempt,
          input: execution.turnInput,
        }).body,
      };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Could not build request preview.",
      };
    }
  }

  function editFromHere(messageId: MessageId): void {
    if (pendingBranch.editFromHere(messageId)) setWorkbenchView("request");
  }

  function chooseProfile(profileId: string): void {
    const profile = profiles.find(({ id }) => id === profileId);
    if (!profile) return;
    if (requestSettings.connectionRequirement) {
      project.mapProfile(requestSettings.connectionRequirement.id, profile);
    }
    selectProfile(profileId);
  }

  /**
   * Deletion is confirmed rather than undoable: the profile's credential is
   * destroyed with it, and nothing in the UI could put a keychain secret back.
   */
  function confirmDeleteActiveProfile(): void {
    const profileId = activeProfile.id;
    setConfirmation({
      title: `Delete "${activeProfile.name || "Untitled profile"}"?`,
      description:
        "This connection and any credential stored for it on this device are removed. Saved run traces keep the connection they recorded.",
      confirmLabel: "Delete profile",
      destructive: true,
      details: [
        { label: "Endpoint", value: activeProfile.endpoint },
        { label: "Model", value: activeProfile.model || "none" },
      ],
      onConfirm() {
        removeActiveProfile();
        // A project mapped to this profile is left unmapped, which restores the
        // prompt to choose one instead of running against a connection the user
        // never picked.
        project.unmapProfile(profileId);
      },
    });
  }

  /**
   * Re-points the project's declared connection at the mapped profile, after
   * showing what is being replaced. The declaration travels in the shared
   * project file and the previous value is not recoverable from the UI, so the
   * old and new endpoints are put side by side before the write.
   */
  function confirmUpdateProjectEndpoint(requirementId: string): void {
    const requirement = projectFile?.connectionRequirements.find(({ id }) => id === requirementId);
    const mappedProfile = profiles.find(({ id }) => id === mappedProfileIds[requirementId]);
    if (!requirement || !mappedProfile) return;
    const endpoint = mappedProfile.endpoint;
    setConfirmation({
      title: "Update the project's declared endpoint?",
      description:
        "The project file records the new endpoint. Anyone you share it with sees this connection instead. Credentials are never written to the project.",
      confirmLabel: "Update project",
      details: [
        { label: "Currently declares", value: requirement.endpoint },
        { label: "Change to", value: endpoint },
      ],
      onConfirm() {
        try {
          project.adoptProjectMutation(
            updateConnectionRequirementEndpoint(
              project.currentProjectDocument(),
              requirement.id,
              endpoint,
            ),
          );
        } catch (error) {
          project.setError(
            error instanceof Error
              ? error.message
              : "Could not update the project's declared endpoint.",
          );
        }
      },
    });
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
    repeatedExperiment.clear();
    evaluationExecution.clear();
    project.clearErrorKind();
    const requestSnapshot = requestSettings.currentRequest();
    const prepared = prepareWorkbenchRun({
      request: requestSnapshot,
      project: projectFile ?? undefined,
      projectTools: resolvedTools(),
      requestTools,
      capabilities: requestSettings.capabilities,
      profileName: requestSettings.profile.name,
      templateRunOverrides: projectTemplates.templateRunOverrides,
      ...pendingBranch.preparationInputs(),
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
    if (prepared.executedRevisionId) {
      projectTemplates.markExecutedRevision(prepared.executedRevisionId);
    }
    pendingBranch.settle(prepared);
    const input = prepared.input;
    const branchedFrom = prepared.branchedFrom;
    const request = {
      ...requestSnapshot,
      messages: input.messages,
    };
    input.target.profileId = createEntityId("profile", requestSettings.profile.id);
    runsNavigation.selectCurrent(input.runId);
    const sessionStart = runSession.start(input, {
      request,
      workspace: projectWorkspace,
      ...(branchedFrom ? { branchedFrom } : {}),
    });
    await sessionStart;
  }

  /**
   * The exposed tools nothing on this device can serve.
   *
   * A batch answers its own tool calls, so a tool with no binding would stop
   * every repetition at a call nobody is watching. This is the gate the plan
   * calls "every exposed tool has an automatically resolvable binding" — a
   * mock, command, or MCP grant.
   */
  function unservableTools(): ToolDefinition[] {
    return [...resolvedTools(), ...requestTools].filter((tool) => !bindingForTool(tool));
  }

  function unservableToolsMessage(unservable: readonly ToolDefinition[]): string {
    const names = unservable.map(({ name }) => name).join(", ");
    // The shell statement is inherited, not restated: a repetition that would
    // run a command tool cannot run at all where nothing can spawn.
    const shell = commandToolUnavailableMessage(commandTools);
    return `A repeated experiment answers its own tool calls, and nothing on this device serves ${names}. Enable a mock, grant a command tool, or allow an MCP tool first.${shell ? ` ${shell}` : ""}`;
  }

  function repeat(): void {
    evaluationExecution.clear();
    project.clearErrorKind();
    const unservable = unservableTools();
    if (unservable.length > 0) {
      project.setError(unservableToolsMessage(unservable));
      return;
    }
    const requestSnapshot = requestSettings.currentRequest();
    const prepared = prepareWorkbenchRun({
      request: requestSnapshot,
      project: projectFile ?? undefined,
      projectTools: resolvedTools(),
      requestTools,
      capabilities: requestSettings.capabilities,
      profileName: requestSettings.profile.name,
      templateRunOverrides: projectTemplates.templateRunOverrides,
      ...pendingBranch.preparationInputs(),
    });
    if (!prepared.ok) {
      if (prepared.errorKind === "tools-disabled") project.setToolsDisabledError(prepared.message);
      else project.setError(prepared.message);
      return;
    }
    const input = {
      ...prepared.input,
      target: {
        ...prepared.input.target,
        profileId: createEntityId("profile", requestSettings.profile.id),
      },
    };
    repeatedExperiment.begin(input, requestSettings.profile.name || "Untitled profile", () => {
      if (prepared.projectMutation) project.adoptBranchRevision(prepared.projectMutation);
      if (prepared.executedRevisionId) projectTemplates.markExecutedRevision(prepared.executedRevisionId);
      pendingBranch.settle(prepared);
      runSession.reset();
      setTraceOpen(false);
      // A batch's results are read in the Runs mode, so the batch opens there
      // rather than displacing whatever the current pane was showing.
      setMode("runs");
    });
  }

  function confirmEvaluation(): void {
    runSession.reset();
    repeatedExperiment.clear();
    setTraceOpen(false);
    setMode("runs");
    void evaluationExecution.confirm(projectWorkspace);
  }

  async function continueRun(): Promise<void> {
    return runSession.continueRun();
  }

  async function retryRun(): Promise<void> {
    return runSession.retry();
  }

  function stop() {
    runSession.stop();
  }

  function downloadDiagnostics() {
    runSession.downloadDiagnostics();
  }
  async function openHistoryTrace(item: ProjectRunHistoryItem): Promise<void> {
    const workspace = projectWorkspace;
    if (!workspace) throw new Error("The project folder is no longer open.");
    runSession.adoptTrace(await runHistory.readTrace(item.fileName), {
      workspace,
      fileName: item.fileName,
    });
    repeatedExperiment.clear();
    evaluationExecution.clear();
    // A single saved run reads in the response pane, which belongs to Compose.
    setMode("compose");
    setRunHistoryOpen(false);
  }
  function branchFromHistoryTrace(trace: RunTrace): void {
    if (!pendingBranch.branchFromTrace(trace)) return;
    setMode("compose");
    setWorkbenchView("request");
  }
  async function openHistoryExperiment(item: ProjectExperimentHistoryItem): Promise<void> {
    const workspace = projectWorkspace;
    if (!workspace) throw new Error("The project folder is no longer open.");
    const opened = await runHistory.readExperiment(item);
    if (opened.plan.kind === "evaluation") {
      evaluationExecution.openSaved({ ...opened, plan: opened.plan }, workspace);
      repeatedExperiment.clear();
    } else {
      repeatedExperiment.openSaved(opened, workspace);
      evaluationExecution.clear();
    }
    runsNavigation.selectExperiment(item);
    setMode("runs");
    setRunHistoryOpen(false);
  }
  /**
   * Releases a finished batch from the response pane. A durable batch is
   * written to the project folder and reopens from run history, so dismissing
   * it is navigation. An unsaved one exists only in this session's state, and
   * clearing it is the last copy — that case is confirmed first.
   */
  function dismissFinishedExperiment(kind: "evaluation" | "repeated"): void {
    const session = kind === "evaluation" ? evaluationExecution : repeatedExperiment;
    // Releasing a batch leaves the Runs mode with nothing to show, so it also
    // returns to wherever the batch was started from.
    const clear = () => {
      session.clear();
      setMode(kind === "evaluation" ? "evaluations" : "compose");
    };
    if (!session.execution || session.execution.storage === "durable") {
      clear();
      return;
    }
    setConfirmation({
      title: kind === "evaluation" ? "Discard these evaluation results?" : "Discard these experiment results?",
      description:
        "This batch was never saved to a project folder, so its runs cannot be reopened from run history once they are cleared.",
      confirmLabel: "Discard results",
      destructive: true,
      onConfirm: clear,
    });
  }
  const runReachedTerminalStatus = Boolean(
    runState &&
      ["completed", "cancelled", "failed"].includes(runState.status.kind),
  );
  const runHistoryBlocked =
    (Boolean(runState) && !runReachedTerminalStatus) ||
    repeatedExperiment.isRunning ||
    evaluationExecution.isRunning;
  const requestPreview = templateRequestPreview();
  const composerItems = projectTemplates.templateWorkbench.composerItems;
  const readiness = runReadiness({
    projectOpen: Boolean(projectFile),
    connectionMapped: projectTemplates.activeConnectionRequirement
      ? requestSettings.profileMapped
      : true,
    activeProfileName: requestSettings.profile.name,
    activeProfileEndpoint: requestSettings.profile.endpoint,
    activeProfileModel: requestSettings.model,
    selectedToolCount,
    toolsEnabled: requestSettings.capabilities.tools,
    ...(projectTemplates.activeConnectionRequirement
      ? {
          requiredEndpoint: projectTemplates.activeConnectionRequirement.endpoint,
          activeConnectionRequirementId: projectTemplates.activeConnectionRequirement.id,
        }
      : {}),
    ...(projectTemplates.templateWorkbench.resolutionError
      ? { templateResolutionError: projectTemplates.templateWorkbench.resolutionError }
      : {}),
    templateIssues:
      projectTemplates.templateWorkbench.resolution?.diagnostics.map(
        ({ templateUseId, diagnostic }) => ({
          templateUseId,
          ...(diagnostic.code === "missing-template-variable"
            ? { variableName: diagnostic.name }
            : {}),
        }),
      ) ?? [],
    templateTargets:
      composerItems.flatMap((item) => {
        if (item.kind !== "template-use") return [];
        const template = projectFile?.promptTemplates.find(
          ({ id }) => id === item.use.templateId,
        );
        const target = template?.recommendedTarget;
        if (!template || !target) return [];
        const requirement = projectFile?.connectionRequirements.find(
          ({ id }) => id === target.connectionRequirementId,
        );
        return [
          {
            templateName: template.name,
            connectionRequirementId: target.connectionRequirementId,
            connectionRequirementName:
              requirement?.name ?? target.connectionRequirementId,
            model: target.model,
          },
        ];
      }) ?? [],
  });

  function resolveReadiness(destination: ReadinessDestination): void {
    setPendingReadinessDestination(destination);
    if (destination.surface === "connections") {
      setConnectionDrawerOpen(true);
    } else if (destination.surface === "prompts") {
      setMode("prompts");
    } else {
      // Every request-surface destination names a control in the composer, so
      // the routing has to cross the mode boundary before it can focus one.
      setMode("compose");
      setWorkbenchView("request");
    }
  }

  function changeMode(nextMode: AppMode): void {
    if (nextMode === "prompts" && mode !== "prompts") {
      promptNavigation.clearReturn();
    }
    if (nextMode === "runs" && !runsNavigation.selection && runState) {
      runsNavigation.selectCurrent(runState.runId);
    }
    setMode(nextMode);
  }

  function editPromptSource(
    useId: PromptTemplateUseId,
    templateId: PromptTemplateId,
    revisionId: PromptTemplateRevisionId,
  ): void {
    promptNavigation.editSource(useId, templateId, revisionId);
    setMode("prompts");
  }

  function returnFromPromptSource(): void {
    const target = promptNavigation.returnFromSource();
    setMode("compose");
    setWorkbenchView("request");
    if (!target) return;
    const useStillExists = projectTemplates.templateWorkbench.composerItems.some(
      (item) => item.kind === "template-use" && item.use.id === target.useId,
    );
    if (useStillExists) {
      setPendingReadinessDestination({
        surface: "request",
        tab: "messages",
        control: "template-use",
        entityId: target.useId,
      });
      return;
    }
    toasts.publish({
      key: "prompt-return-target-missing",
      title: "Returned to the request",
      detail: "The prompt use you opened is no longer in this conversation.",
      durableHome: "the Messages list",
    });
  }
  const responseEmptyState = runEmptyStatePresentation(readiness);
  const onContextualRunShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
    event.preventDefault();
    if (
      modalOwnsKeyboardCommands() ||
      confirmation ||
      repeatedExperiment.draft ||
      evaluationExecution.draft ||
      isRequestActive ||
      repeatedExperiment.isRunning ||
      evaluationExecution.isRunning
    ) return;
    // Each mode's primary action is what the shortcut fires. Runs has none:
    // it is where results are read, not where work is started.
    if (mode === "evaluations") {
      if (!evaluationWorkspace.startDisabledReason) evaluationWorkspace.start();
      return;
    }
    if (mode !== "compose") return;
    if (readiness?.blocked) return;
    if (runState?.status.kind === "paused" && runState.status.reason === "attempt_failed") {
      void retryRun();
    } else if (runState?.status.kind !== "awaiting_tool_results") {
      void run();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onContextualRunShortcut);
    return () => window.removeEventListener("keydown", onContextualRunShortcut);
  }, []);

  /**
   * The one banner slot, in priority order.
   *
   * A failure that refuses the user's work outranks an advisory about the
   * environment, which outranks an offer they can take at leisure. Whichever
   * loses is counted by `chooseAppBanner` rather than dropped, and returns to
   * the slot on its own once what outranked it is resolved or dismissed.
   */
  function projectErrorBanner(): AppBannerCandidate | undefined {
    if (!projectError) return undefined;
    return {
      id: "project-error",
      tone: "failure",
      title: projectError,
      actions: [
        ...(projectErrorKind === "workspace-reconnect"
          ? [{
              key: "reconnect",
              label: "Reconnect",
              primary: true,
              onSelect: () => void project.reconnectProjectWorkspace(),
            }]
          : []),
        ...(projectErrorKind === "tools-disabled"
          ? [{
              key: "connection-settings",
              label: "Open connection settings",
              primary: true,
              onSelect: () => setConnectionDrawerOpen(true),
            }]
          : []),
        { key: "dismiss", label: "Dismiss", onSelect: () => project.dismissError() },
      ],
    };
  }

  function insecureOriginBanner(): AppBannerCandidate | undefined {
    const notice = originNotice.notice;
    if (!notice) return undefined;
    return {
      id: "insecure-origin",
      tone: "advisory",
      title: notice.headline,
      detail: notice.detail,
      actions: [
        ...(notice.suggestedUrl
          ? [{
              key: "open",
              label: "Open it",
              primary: true,
              href: notice.suggestedUrl,
              onSelect: originNotice.dismiss,
            }]
          : []),
        { key: "dismiss", label: "Dismiss", onSelect: originNotice.dismiss },
      ],
    };
  }

  function serverDefaultBanner(): AppBannerCandidate | undefined {
    if (!serverDefaultProfileNotice) return undefined;
    return {
      id: "server-default-profile",
      tone: "advisory",
      title: "Server default connection available",
      detail:
        "A profile using this server's configured endpoint was added to Connections.",
      actions: [
        { key: "use", label: "Use it", primary: true, onSelect: adoptServerDefaultProfile },
        {
          key: "review",
          label: "Review",
          onSelect: () => {
            dismissServerDefaultProfileNotice();
            setConnectionDrawerOpen(true);
          },
        },
        { key: "dismiss", label: "Dismiss", onSelect: dismissServerDefaultProfileNotice },
      ],
    };
  }

  const appBanner = chooseAppBanner([
    projectErrorBanner(),
    insecureOriginBanner(),
    serverDefaultBanner(),
  ]);

  function saveOrChooseProjectLocation(): void {
    if (projectWorkspace || !folderAccessAvailable) {
      void project.saveProject();
      return;
    }
    setProjectCreationMode("save");
  }

  // The single-run response and its trace panel are one surface with one
  // owner, mounted by Compose and reused by the Runs mode when a run is
  // selected out of a batch. Composing them once here is what keeps the app
  // from growing a second response implementation.
  const responseSurface = (
    <section className="result">
      <ResponseOutput
        output={responseView.output}
        reasoning={responseView.reasoning}
        status={responseView.status}
        runState={runState}
        isRequestActive={isRequestActive}
        markdownPreview={responseView.markdownPreview}
        outputFollowing={responseView.following}
        outputScrollRef={responseView.scrollRef}
        completedToolCalls={responseView.completedToolCalls}
        toolResultDrafts={toolResultDrafts}
        traceStorage={traceStorage}
        transcript={transcript}
        nonBranchableMessageIds={pendingBranch.nonBranchableMessageIds}
        branchedFrom={visibleBranchProvenance}
        emptyState={responseEmptyState}
        onMarkdownPreviewChange={responseView.setMarkdownPreview}
        onOutputScroll={responseView.updateFollowState}
        onJumpToLatest={responseView.jumpToLatest}
        onToolResultDraftChange={runSession.updateToolResultDraft}
        onApproveMcp={runSession.approveMcpCall}
        onRejectMcp={runSession.rejectMcpCall}
        onContinue={() => void continueRun()}
        onRetry={() => void retryRun()}
        onDiscardFailedRun={stop}
        onSaveTrace={() => void runSession.exportTrace()}
        onEditFromHere={editFromHere}
        onEmptyStateAction={() => {
          if (responseEmptyState.action) {
            resolveReadiness(responseEmptyState.action.destination);
          }
        }}
      />
    </section>
  );
  const traceSurface = (
    <RunTracePanel
      open={traceOpen}
      runState={runState}
      branchedFrom={visibleBranchProvenance}
      parentTrace={parentTrace}
      onLoadParentTrace={() => void runSession.loadParentTrace()}
      onOpenChange={(open) => {
        setTraceOpen(open);
        if (!open && comparisonTraceOpen) {
          setComparisonTraceOpen(false);
          setMode("runs");
        }
      }}
      {...(projectFile ? { onPromoteTrace: (trace: RunTrace) => evaluationCaseSource.requestPromotion(trace) } : {})}
    />
  );
  const n8nImportDisabledReason = pendingBranch.pending
    ? "Finish or discard the pending branch before importing a prompt."
    : Boolean(runState) && !runReachedTerminalStatus
      ? "Finish or stop the current run before importing a prompt."
      : undefined;
  return (
    <main
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          saveOrChooseProjectLocation();
        }
      }}
    >
      <Topbar
        profiles={profiles}
        activeProfile={requestSettings.profile}
        {...(requestSettings.connectionRequirement
          ? { projectConnectionName: requestSettings.connectionRequirement.name }
          : {})}
        hasCredential={credential.hasCredential}
        projectName={projectFile?.name}
        projectDirty={projectDirty}
        {...(projectStorageState ? { projectStorageState } : {})}
        folderAccessAvailable={folderAccessAvailable}
        hasDiagnosticCapture={hasDiagnosticCapture}
        hasRunTrace={runReachedTerminalStatus}
        hasProjectWorkspace={Boolean(projectWorkspace)}
        runHistoryBlocked={runHistoryBlocked}
        isRequestActive={isRequestActive}
        isExperimentActive={repeatedExperiment.isRunning || evaluationExecution.isRunning}
        mode={mode}
        onModeChange={changeMode}
        modeIndicators={batchCompletion.indicator ? { runs: batchCompletion.indicator } : {}}
        awaitingToolResults={runState?.status.kind === "awaiting_tool_results"}
        retryableFailure={
          runState?.status.kind === "paused" &&
          runState.status.reason === "attempt_failed"
        }
        runDisabled={Boolean(readiness?.blocked)}
        runDisabledReasonId={RUN_READINESS_SUMMARY_ID}
        evaluationStartDisabled={Boolean(evaluationWorkspace.startDisabledReason)}
        evaluationStartDisabledReasonId={EVALUATION_PREFLIGHT_SUMMARY_ID}
        onChooseProfile={chooseProfile}
        onOpenConnections={() => setConnectionDrawerOpen(true)}
        onNewProject={() => setProjectCreationMode("new")}
        onOpenProject={() => void project.openProjectWorkspace()}
        onSaveProject={saveOrChooseProjectLocation}
        onImportProject={(event) => void project.importProject(event)}
        onExportProject={project.exportProject}
        {...(n8nImportDisabledReason ? { n8nImportDisabledReason } : {})}
        onOpenN8nImport={() => setN8nImportOpen(true)}
        onDownloadDiagnostics={downloadDiagnostics}
        onDownloadRunTrace={() => void runSession.exportTrace()}
        onImportRunTrace={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void runSession.importTrace(file);
          }
          event.target.value = "";
        }}
        onOpenRunHistory={() => setRunHistoryOpen(true)}
        onStop={stop}
        onStopExperiment={evaluationExecution.isRunning ? evaluationExecution.cancel : repeatedExperiment.cancel}
        onRun={() => void run()}
        onStartEvaluation={evaluationWorkspace.start}
      />

      <AppBanner {...(appBanner ? { selection: appBanner } : {})} />

      <ConnectionDrawer
        open={connectionDrawerOpen}
        onClose={() => {
          setConnectionDrawerOpen(false);
          setSessionPromptProjectNotice(undefined);
        }}
        profiles={profiles}
        activeProfile={activeProfile}
        capabilities={activeCapabilities}
        credential={credential}
        serverDefault={serverDefault}
        isDesktopRuntime={isDesktopRuntime}
        onSelectProfile={selectProfile}
        onAddProfile={() => {
          addProfile();
        }}
        onDeleteProfile={confirmDeleteActiveProfile}
        deleteProfileRefusal={activeProfileDeletionRefusal}
        onUpdateProfile={updateActiveProfile}
        onCapabilityChange={changeCapability}
        connectionRequirements={projectFile?.connectionRequirements}
        mappedProfileIds={mappedProfileIds}
        onMapProfile={(requirementId, profileId) => {
          const profile = profiles.find(({ id }) => id === profileId);
          if (profile) {
            project.mapProfile(requirementId, profile);
            selectProfile(profile.id);
          }
        }}
        onUpdateProjectEndpoint={confirmUpdateProjectEndpoint}
        pendingDestination={pendingReadinessDestination}
        onDestinationHandled={() => setPendingReadinessDestination(undefined)}
        {...(sessionPromptProjectNotice
          ? { authoringNotice: sessionPromptProjectNotice }
          : {})}
      />

      <RunHistoryDrawer
        open={runHistoryOpen}
        projectName={projectFile?.name}
        selectedRunId={runState?.runId}
        selectedExperimentId={evaluationExecution.execution?.plan.experimentId ?? repeatedExperiment.execution?.plan.experimentId}
        history={runHistory}
        onClose={() => setRunHistoryOpen(false)}
        onSelect={(item) => openHistoryTrace(item)}
        onSelectExperiment={(item) => openHistoryExperiment(item)}
      />

      {mode === "compose" ? (
      <WorkbenchShell
        view={workbenchView}
        onViewChange={setWorkbenchView}
        inspectAvailable={Boolean(runState && runState.status.kind !== "not_started")}
        responseStatus={responseView.status}
        request={
        <RequestComposer
          requestDraft={{
            messages, tools, requestTools, enabledToolIds, addTool, removeTool, moveTool, updateTool,
            setToolEnabled, mockForTool, updateToolMock, removeRequestTool, saveRequestToolToProject,
            attachMcpToolToProject, attachMcpToolToRequest,
          }}
          commandTools={commandTools}
          mcpConsents={mcpConsents}
          templates={projectTemplates}
          project={projectFile}
          settings={{
            model: requestSettings.model,
            temperature: requestSettings.temperature,
            responseMode: requestSettings.responseMode,
            streamingAvailable: requestSettings.capabilities.streaming,
            toolsEnabled: requestSettings.capabilities.tools,
            modelDiscovery: activeModelDiscovery,
            favoriteModels: requestSettings.profile.favoriteModels ?? [],
            onModelChange: requestSettings.setModel,
            onTemperatureChange: requestSettings.setTemperature,
            onStreamingPreferenceChange: requestSettings.setStreamingPreferred,
            onLoadModels: (force) => void loadModels(force),
            onToggleFavoriteModel: (model) =>
              updateProfile(requestSettings.profile.id, {
                favoriteModels: toggleFavoriteModel(
                  requestSettings.profile.favoriteModels,
                  model,
                ),
              }),
            ...(projectFile
              ? {
                  inherited: {
                    label: "profile defaults",
                    value: {
                      model: requestSettings.profile.model,
                      temperature: requestSettings.profile.temperature,
                      responseMode: requestSettings.responseMode,
                    },
                  },
                }
              : {}),
          }}
          {...(readiness ? { readiness } : {})}
          repeat={{
            disabled: Boolean(readiness?.blocked) || unservableToolNames.length > 0,
            ...(readiness?.blocked
              ? { disabledReason: readiness.summary }
              : unservableToolNames.length > 0
                ? { disabledReason: `Nothing on this device serves ${unservableToolNames.join(", ")}.` }
                : {}),
            onRepeat: repeat,
          }}
          pendingDestination={pendingReadinessDestination}
          importedRevision={importedRevision}
          onReadinessAction={resolveReadiness}
          onDestinationHandled={() => setPendingReadinessDestination(undefined)}
          activeProfile={requestSettings.profile}
          {...(pendingBranch.pending ? { pendingBranch: pendingBranch.pending } : {})}
          {...(requestPreview ? { requestPreview } : {})}
          onOpenConnectionSettings={() => setConnectionDrawerOpen(true)}
          onOpenPrompts={() => {
            promptNavigation.clearReturn();
            setMode("prompts");
          }}
          onEditPromptSource={editPromptSource}
          onOpenToolLibrary={() => setToolRegistryOpen(true)}
          onSaveParentTrace={() => void runSession.exportTrace()}
          onDiscardPendingBranch={pendingBranch.clear}
        />
        }
        response={responseSurface}
        inspect={traceSurface}
      />
      ) : mode === "prompts" ? (
        <PromptsMode
          {...(projectFile ? { project: projectFile } : {})}
          templates={projectTemplates}
          draftMessageCount={messages.length}
          persistence={{
            autoSaveFailed: projectErrorKind === "auto-save",
            folderBacked: Boolean(projectWorkspace),
            dirty: projectDirty,
          }}
          navigation={promptNavigation}
          evaluations={evaluationAuthoring}
          {...(n8nImportDisabledReason ? { n8nImportDisabledReason } : {})}
          focusRequested={pendingReadinessDestination?.surface === "prompts"}
          onFocusHandled={() => setPendingReadinessDestination(undefined)}
          onOpenN8nImport={() => setN8nImportOpen(true)}
          onInserted={() => {
            promptNavigation.clearReturn();
            setMode("compose");
            setWorkbenchView("request");
          }}
          onReturn={returnFromPromptSource}
          onRevisionEvaluationStarted={() => {
            setMode("evaluations");
            evaluationWorkspace.layout.onSetupOpenChange(true);
          }}
          onEvaluationSuiteOpened={() => setMode("evaluations")}
        />
      ) : mode === "evaluations" ? (
        <EvaluationsMode
          authoring={evaluationAuthoring}
          execution={evaluationWorkspace.execution}
          {...(evaluationWorkspace.history ? { history: evaluationWorkspace.history } : {})}
          layout={evaluationWorkspace.layout}
          modelFavorites={{
            models: activeProfile.favoriteModels ?? [],
            onToggle: (model) =>
              updateActiveProfile({
                favoriteModels: toggleFavoriteModel(activeProfile.favoriteModels, model),
              }),
          }}
          onOpenTemplates={() =>
            resolveReadiness({ surface: "prompts", control: "prompt-library" })
          }
          {...(evaluationCaseSource.source ? { caseSource: evaluationCaseSource.source } : {})}
          onOpenSourceTrace={evaluationCaseSource.openSource}
        />
      ) : (
        <RunsMode
          browser={{
            ...(projectFile ? { projectId: projectFile.projectId } : {}),
            ...(runState?.input
              ? {
                  currentRun: {
                    runId: runState.runId,
                    model: runState.input.target.model,
                    status: runState.status.kind,
                    ...(runState.startedAt ? { startedAt: runState.startedAt } : {}),
                  },
                }
              : {}),
            ...(projectWorkspace ? { history: runHistory } : {}),
            ...(runsNavigation.selection ? { selection: runsNavigation.selection } : {}),
            filter: runsNavigation.filter,
            scrollTop: runsNavigation.scrollTop,
            ...(runsNavigation.selection?.kind === "current-run" && runState?.runId === runsNavigation.selection.runId
              ? { selectedEvidence: responseSurface }
              : runsNavigation.inspection?.status === "ready" && runsNavigation.inspection.trace
                ? {
                    selectedEvidence: (
                      <RunEvidenceDetail
                        trace={runsNavigation.inspection.trace}
                        fileName={runsNavigation.inspection.selection.fileName}
                        onBranch={branchFromHistoryTrace}
                      />
                    ),
                  }
                : {}),
            ...(runsNavigation.inspection?.status === "loading" ? { loading: true } : {}),
            ...(runsNavigation.inspection?.status === "error" && runsNavigation.inspection.error
              ? { error: runsNavigation.inspection.error }
              : {}),
            onFilterChange: runsNavigation.setFilter,
            onScrollTopChange: runsNavigation.setScrollTop,
            onSelectCurrent: runsNavigation.selectCurrent,
            onSelectRun: (item) => void runsNavigation.selectSavedRun(item),
            onSelectExperiment: (item) => void openHistoryExperiment(item),
          }}
          {...(evaluationBaselines.comparison && !evaluationExecution.execution && !repeatedExperiment.execution
            ? {
                comparison: {
                  loaded: evaluationBaselines.comparison,
                  // Same rule as a dismissed batch: releasing the last thing in
                  // the Runs mode returns to where it was started from.
                  onDismiss: () => {
                    evaluationBaselines.clearComparison();
                    setComparisonReturnTarget(undefined);
                    setMode("evaluations");
                  },
                  onOpenTrace: (side, runId, target) => {
                    const trace = side.traces.get(runId);
                    if (!trace || !projectWorkspace) return;
                    setComparisonReturnTarget(target);
                    setComparisonTraceOpen(true);
                    runSession.adoptTrace(trace, {
                      workspace: projectWorkspace,
                      fileName: side.traceFileNames.get(runId) ?? traceFileName(runId),
                      source: "experiment",
                    });
                    setTraceOpen(true);
                    setMode("compose");
                    setWorkbenchView("inspect");
                  },
                  onPromoteCandidate: (trace, experimentCellId) => evaluationCaseSource.requestPromotion(trace, experimentCellId),
                  ...(comparisonReturnTarget ? { returnTarget: comparisonReturnTarget } : {}),
                  onReturnTargetChange: setComparisonReturnTarget,
                },
              }
            : {})}
          {...(evaluationExecution.execution
            ? {
                evaluation: {
                  execution: evaluationExecution.execution,
                  onStop: evaluationExecution.cancel,
                  onOpenTrace: evaluationExecution.openTrace,
                  onPromoteTrace: (trace, experimentCellId) => evaluationCaseSource.requestPromotion(trace, experimentCellId),
                  onReturnToList: evaluationExecution.returnToEvaluation,
                  onDismiss: () => dismissFinishedExperiment("evaluation"),
                  reassessment: evaluationReassessment,
                },
              }
            : {})}
          {...(repeatedExperiment.execution
            ? {
                repeated: {
                  execution: repeatedExperiment.execution,
                  onStop: repeatedExperiment.cancel,
                  onOpenTrace: repeatedExperiment.openTrace,
                  onReturnToList: repeatedExperiment.returnToRequest,
                  onDismiss: () => dismissFinishedExperiment("repeated"),
                },
              }
            : {})}
          detail={
            <>
              {responseSurface}
              {traceSurface}
            </>
          }
          {...(projectWorkspace
            ? {
                savedHistory: {
                  disabled: runHistoryBlocked,
                  ...(runHistoryBlocked
                    ? {
                        disabledReason:
                          "Finish or stop the current run before opening history.",
                      }
                    : {}),
                  onOpen: () => setRunHistoryOpen(true),
                },
              }
            : {})}
          onStartSomething={() => setMode("evaluations")}
        />
      )}
      {toolRegistryOpen && (
        <ToolRegistryModal
          open
          registry={toolRegistry}
          onChange={setToolRegistry}
          onAttachToProject={attachRegistryToolToProject}
          onAttachToRequest={attachRegistryToolToRequest}
          requestConfirmation={setConfirmation}
          onClose={() => setToolRegistryOpen(false)}
        />
      )}
      {n8nImportOpen && (
        <N8nImportModal
          open
          onClose={() => setN8nImportOpen(false)}
          recommendation={{
            ...(projectTemplates.activeConnectionRequirement
              ? { connectionRequirementName: projectTemplates.activeConnectionRequirement.name }
              : {}),
            projectModel: requestSettings.model,
          }}
          onImport={projectTemplates.importN8nPrompt}
        />
      )}
      {projectCreationMode && (
        <ProjectCreationDialog
          initialName={
            projectCreationMode === "new"
              ? "Untitled Inference Lens project"
              : projectFile?.name ?? "Untitled Inference Lens project"
          }
          {...(projectCreationMode === "save-before-switch"
            ? {
                copy: {
                  eyebrow: "Save before switching",
                  title: "Save the current project",
                  description:
                    "Choose a folder for the current project. Inference Lens will switch projects only after the save succeeds.",
                  submitLabel: "Save and switch…",
                },
              }
            : projectCreationMode === "save"
              ? {
                  copy: {
                    eyebrow: "Save project",
                    title: "Save this project",
                    description:
                      "Choose a folder for this project. Its current prompts and settings will be saved there.",
                    submitLabel: "Save to folder…",
                  },
                }
              : {})}
          onClose={() => setProjectCreationMode(undefined)}
          onCreate={(options) => {
            if (projectCreationMode === "new") {
              void project.newProjectFolder(options);
            } else if (projectCreationMode === "save-before-switch") {
              void project.saveAndContinueProjectReplacement(options);
            } else {
              void project.saveProject(options);
            }
          }}
        />
      )}
      {project.pendingProjectReplacement &&
        projectCreationMode !== "save-before-switch" && (
          <ProjectReplacementDialog
            replacement={project.pendingProjectReplacement}
            onCancel={project.cancelProjectReplacement}
            onDiscard={() =>
              void project.discardAndContinueProjectReplacement()
            }
            onSave={() => {
              if (project.pendingProjectReplacement?.saveNeedsLocation) {
                setProjectCreationMode("save-before-switch");
              } else {
                void project.saveAndContinueProjectReplacement();
              }
            }}
          />
        )}
      {repeatedExperiment.draft && (
        <RepeatedExperimentDialog
          draft={repeatedExperiment.draft}
          settings={{
            streamingAvailable: requestSettings.capabilities.streaming,
            modelDiscovery: activeModelDiscovery,
            favoriteModels: requestSettings.profile.favoriteModels ?? [],
            onLoadModels: (force) => void loadModels(force),
            onToggleFavoriteModel: (model) =>
              updateProfile(requestSettings.profile.id, {
                favoriteModels: toggleFavoriteModel(
                  requestSettings.profile.favoriteModels,
                  model,
                ),
              }),
          }}
          onCountChange={repeatedExperiment.setRepetitionCount}
          onTurnCeilingChange={repeatedExperiment.setTurnCeiling}
          onSettingsChange={repeatedExperiment.updateSettings}
          onCancel={repeatedExperiment.dismissDialog}
          onConfirm={() => void repeatedExperiment.confirm(projectWorkspace)}
        />
      )}
      {evaluationExecution.draft && (
        <EvaluationStartDialog
          draft={evaluationExecution.draft}
          onCancel={evaluationExecution.dismissDialog}
          onConfirm={confirmEvaluation}
        />
      )}
      {evaluationCaseSource.promotion && projectFile && (
        <PromoteTraceToCaseDialog
          project={projectFile}
          trace={evaluationCaseSource.promotion.trace}
          onCancel={evaluationCaseSource.cancelPromotion}
          onPromote={evaluationCaseSource.promote}
        />
      )}
      {confirmation && (
        <ConfirmationDialog
          request={confirmation}
          onClose={() => setConfirmation(undefined)}
        />
      )}
      <ToastRegion
        toasts={toasts.toasts}
        onDismiss={toasts.dismiss}
        onPausedChange={toasts.setPaused}
      />
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
