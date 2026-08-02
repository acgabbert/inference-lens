"use client";

import {
  useEffect,
  useEffectEvent,
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
  projectDraft,
  updateConnectionRequirementEndpoint,
} from "../packages/core/src/project";
import {
  createEntityId,
  createSingleTurnRunExecution,
} from "../packages/core/src/run-kernel";
import type {
  RunState,
  ConversationMessage,
  ConversationId,
  MessageId,
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
import { useModelDiscovery } from "./use-model-discovery.client";
import { useConnectionProfiles } from "./use-connection-profiles.client";
import { toggleFavoriteModel } from "./profile-store.client";
import { useRequestDraft } from "./use-request-draft.client";
import { useProjectWorkspace } from "./use-project-workspace.client";
import { ConnectionDrawer } from "./connection-drawer.client";
import { Topbar } from "./topbar.client";
import { ResponseOutput } from "./response-output.client";
import { WorkbenchShell } from "./workbench-shell.client";
import type { WorkbenchView } from "./workbench-shell.client";
import { RunTracePanel } from "./run-trace-panel.client";
import { RunHistoryDrawer } from "./run-history-drawer.client";
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
import type {
  ConfirmationDialogRequest,
} from "./confirmation-dialog.client";
import {
  prepareWorkbenchRun,
  type WorkbenchBranchContext,
} from "./run/prepare-workbench-run.client";
import { useRunSession } from "./run/use-run-session.client";
import { useRepeatedExperimentSession } from "./run/use-repeated-experiment-session.client";
import { RepeatedExperimentDialog } from "./run/repeated-experiment-dialog.client";
import { RepeatedExperimentWorkspace } from "./run/repeated-experiment-workspace.client";
import { useProjectTemplates } from "./templates/use-project-templates.client";
import { RequestComposer } from "./request/request-composer.client";
import { useEvaluationSuiteAuthoring } from "./evaluations/use-evaluation-suite-authoring.client";
import {
  createEvaluationStartDraft,
  evaluationStartReadiness,
} from "./evaluations/evaluation-start.client";
import { useEvaluationExecutionSession } from "./evaluations/use-evaluation-execution-session.client";
import { EvaluationStartDialog } from "./evaluations/evaluation-start-dialog.client";
import { EvaluationResultsWorkspace } from "./evaluations/evaluation-results-workspace.client";

const inferenceTransport = createInferenceTransport();

const MARKDOWN_PREVIEW_STORAGE_KEY = "inference-lens:markdown-preview:v1";
const STREAMING_PREFERENCE_STORAGE_KEY =
  "inference-lens:streaming-preference:v1";

interface BranchContext extends WorkbenchBranchContext {
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
    profilesLoaded,
    activeProfile,
    capabilities: activeCapabilities,
    selectProfile,
    addProfile,
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
  const [toolRegistry, setToolRegistry] = useState<ToolRegistryV1>(
    emptyToolRegistry(),
  );
  const [toolRegistryLoaded, setToolRegistryLoaded] = useState(false);
  const [toolRegistryOpen, setToolRegistryOpen] = useState(false);
  const [n8nImportOpen, setN8nImportOpen] = useState(false);
  const [confirmation, setConfirmation] =
    useState<ConfirmationDialogRequest>();
  const [projectCreationMode, setProjectCreationMode] =
    useState<"new" | "save">();
  const [connectionDrawerOpen, setConnectionDrawerOpen] = useState(false);
  const [pendingReadinessDestination, setPendingReadinessDestination] =
    useState<ReadinessDestination>();
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  const [savedRunVersion, setSavedRunVersion] = useState(0);
  const clearTemplateOverridesRef = useRef<() => void>(() => {});
  const [workbenchView, setWorkbenchView] =
    useState<WorkbenchView>("request");
  const [requestActionContext, setRequestActionContext] =
    useState<"ordinary" | "evaluation">("ordinary");
  const [traceOpen, setTraceOpen] = useState(false);
  const [outputFollowing, setOutputFollowing] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [markdownPreviewLoaded, setMarkdownPreviewLoaded] = useState(false);
  const [streamingPreferred, setStreamingPreferred] = useState(true);
  const [streamingPreferenceLoaded, setStreamingPreferenceLoaded] =
    useState(false);
  const project = useProjectWorkspace({
    activeProfile,
    profiles,
    profilesLoaded,
    onActivateProfile: selectProfile,
    folderAccessAvailable,
    createProject() {
      return createProjectFile({
        name: "Untitled Inference Lens project",
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
      clearTemplateOverridesRef.current();
      setBranchContext(null);
      setSessionModel(draft.model);
      setSessionTemperature(draft.temperature);
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
  const runSession = useRunSession({
    transport: inferenceTransport,
    prepareCredential: credential.prepare,
    tools,
    mockForTool,
    readTrace: runHistory.readTrace,
    onShowResponse() {
      setWorkbenchView("response");
      setOutputFollowing(true);
    },
    onOpenTrace() {
      setWorkbenchView("inspect");
      setTraceOpen(true);
    },
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
    onResetBranch() { setBranchContext(null); },
    onError(message) { project.setError(message, { clearKind: true }); },
    onClearError() { project.setError(undefined, { clearKind: true }); },
  });
  const { runState, isRequestActive, toolResultDrafts, traceStorage,
    hasDiagnosticCapture, visibleBranchProvenance, parentTrace, transcript } = runSession;
  const repeatedExperiment = useRepeatedExperimentSession({
    transport: inferenceTransport,
    prepareCredential: credential.prepare,
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
    onError(message) { project.setError(message, { clearKind: true }); },
    onOpenTrace(trace, origin) { runSession.adoptTrace(trace, origin); },
  });
  const evaluationExecution = useEvaluationExecutionSession({
    transport: inferenceTransport,
    prepareCredential: credential.prepare,
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
    onError(message) { project.setError(message, { clearKind: true }); },
    onOpenTrace(trace, origin) { runSession.adoptTrace(trace, origin); },
  });
  const [sessionModel, setSessionModel] = useState<string>();
  const [sessionTemperature, setSessionTemperature] = useState<number>();
  const adHocConversationIdRef = useRef<ConversationId | null>(null);
  const outputScrollRef = useRef<HTMLDivElement | null>(null);
  const [branchContext, setBranchContext] = useState<BranchContext | null>(null);
  const nonBranchableMessageIds = new Set(
    runState?.input?.templateResolutions.flatMap((resolution) =>
      resolution.outputMessageIds.slice(0, -1),
    ) ?? [],
  );

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
    const preferenceId = window.setTimeout(() => {
      const saved = window.localStorage.getItem(
        STREAMING_PREFERENCE_STORAGE_KEY,
      );
      if (saved === "buffered") setStreamingPreferred(false);
      setStreamingPreferenceLoaded(true);
    }, 0);
    return () => window.clearTimeout(preferenceId);
  }, []);

  useEffect(() => {
    if (!markdownPreviewLoaded) return;
    window.localStorage.setItem(
      MARKDOWN_PREVIEW_STORAGE_KEY,
      markdownPreview ? "markdown" : "raw",
    );
  }, [markdownPreview, markdownPreviewLoaded]);

  useEffect(() => {
    if (!streamingPreferenceLoaded) return;
    window.localStorage.setItem(
      STREAMING_PREFERENCE_STORAGE_KEY,
      streamingPreferred ? "streaming" : "buffered",
    );
  }, [streamingPreferred, streamingPreferenceLoaded]);

  useEffect(() => {
    if (!toolRegistryLoaded) return;
    writeToolRegistry(toolRegistry);
  }, [toolRegistry, toolRegistryLoaded]);

  const activeModel = sessionModel ?? activeProfile.model;
  const activeTemperature = projectFile
    ? sessionTemperature
    : activeProfile.temperature;
  const activeResponseMode =
    streamingPreferred && activeCapabilities.streaming
      ? "streaming"
      : "buffered";
  const selectedProjectToolCount = tools.filter(({ id }) =>
    enabledToolIds.includes(id),
  ).length;
  const selectedToolCount = selectedProjectToolCount + requestTools.length;
  const { discovery: activeModelDiscovery, loadModels } = useModelDiscovery({
    profileId: activeProfile.id,
    endpoint: activeProfile.endpoint,
    capabilities: activeCapabilities,
    transport: inferenceTransport,
    prepareCredential: credential.prepare,
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
    model: activeModel,
    temperature: activeTemperature,
    serializedTools,
    toolMocks,
    enabledToolIds,
    branchParentRevisionId: branchContext?.parentConversationRevisionId,
    ensureProjectDocument,
    adoptProjectMutation: project.adoptProjectMutation,
    replaceProjectDraft,
    markProjectError: project.setError,
    resetMessages,
    addDraftMessage: addMessage,
    updateDraftMessage: updateMessage,
    removeDraftMessage: removeMessage,
    clearPendingBranch: () => setBranchContext(null),
    requestConfirmation: setConfirmation,
    onImportApplied() {
      setWorkbenchView("request");
      setN8nImportOpen(false);
    },
  });
  const evaluationAuthoring = useEvaluationSuiteAuthoring({
    project: projectFile,
    adoptProjectMutation: project.adoptProjectMutation,
    // The only cross-feature adapter evaluation authoring needs: when it
    // advances the project's active authored revision, the composer draft,
    // transient template overrides, and any pending branch have to follow.
    onActiveRevisionChanged(next) {
      replaceProjectDraft(projectDraft(next));
      clearTemplateOverridesRef.current();
      setBranchContext(null);
    },
    requestConfirmation: setConfirmation,
  });
  useEffect(() => {
    clearTemplateOverridesRef.current = projectTemplates.clearTransientOverrides;
  }, [projectTemplates.clearTransientOverrides]);

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
      responseMode: activeResponseMode,
      capabilities: activeCapabilities,
    };
  }

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
        ...currentRequest(),
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

  function setEditorTemperature(temperature: number | undefined): void {
    if (projectFile) {
      setSessionTemperature(temperature);
      project.markDirty();
    } else {
      updateActiveProfile({ temperature });
    }
  }

  /** Selecting a profile also satisfies an open project's connection mapping. */
  function chooseProfile(profileId: string): void {
    const profile = profiles.find(({ id }) => id === profileId);
    if (!profile) return;
    selectProfile(profileId);
    project.mapProfile(profile);
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
  function confirmUpdateProjectEndpoint(): void {
    const requirement = projectTemplates.activeConnectionRequirement;
    if (!requirement) return;
    const endpoint = activeProfile.endpoint;
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
    if (projectFile && mappedProfileId !== activeProfile.id) {
      project.setError(
        mappedProfileId
          ? "Activate this project's mapped connection before running."
          : "Map this project's connection to a local profile before running.",
      );
      return;
    }
    const requestSnapshot = currentRequest();
    const prepared = prepareWorkbenchRun({
      request: requestSnapshot,
      project: projectFile ?? undefined,
      projectTools: resolvedTools(),
      requestTools,
      capabilities: activeCapabilities,
      profileName: activeProfile.name,
      branchContext: branchContext ?? undefined,
      templateRunOverrides: projectTemplates.templateRunOverrides,
      adHocConversationId: adHocConversationIdRef.current ?? undefined,
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
    if (prepared.adHocConversationId) {
      adHocConversationIdRef.current = prepared.adHocConversationId;
    }
    if (prepared.consumesPendingBranch) setBranchContext(null);
    const input = prepared.input;
    const branchedFrom = prepared.branchedFrom;
    const request = {
      ...requestSnapshot,
      messages: input.messages,
    };
    input.target.profileId = createEntityId("profile", activeProfile.id);
    const sessionStart = runSession.start(input, {
      request,
      workspace: projectWorkspace,
      ...(branchedFrom ? { branchedFrom } : {}),
    });
    clearRequestTools();
    await sessionStart;
  }

  function repeat(): void {
    evaluationExecution.clear();
    project.clearErrorKind();
    if (selectedToolCount > 0) {
      project.setError("Repeated experiments do not support tools yet. Run this request normally instead.");
      return;
    }
    if (projectFile && mappedProfileId !== activeProfile.id) {
      project.setError(
        mappedProfileId
          ? "Activate this project's mapped connection before running."
          : "Map this project's connection to a local profile before running.",
      );
      return;
    }
    const requestSnapshot = currentRequest();
    const prepared = prepareWorkbenchRun({
      request: requestSnapshot,
      project: projectFile ?? undefined,
      projectTools: resolvedTools(),
      requestTools,
      capabilities: activeCapabilities,
      profileName: activeProfile.name,
      branchContext: branchContext ?? undefined,
      templateRunOverrides: projectTemplates.templateRunOverrides,
      adHocConversationId: adHocConversationIdRef.current ?? undefined,
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
        profileId: createEntityId("profile", activeProfile.id),
      },
    };
    repeatedExperiment.begin(input, activeProfile.name || "Untitled profile", () => {
      if (prepared.projectMutation) project.adoptBranchRevision(prepared.projectMutation);
      if (prepared.executedRevisionId) projectTemplates.markExecutedRevision(prepared.executedRevisionId);
      if (prepared.adHocConversationId) adHocConversationIdRef.current = prepared.adHocConversationId;
      if (prepared.consumesPendingBranch) setBranchContext(null);
      clearRequestTools();
      runSession.reset();
      setTraceOpen(false);
      setWorkbenchView("response");
    });
  }

  function startEvaluation(): void {
    project.clearErrorKind();
    if (evaluationStartDisabledReason) {
      project.setError(evaluationStartDisabledReason);
      return;
    }
    if (!projectFile || !evaluationAuthoring.suiteId || !evaluationAuthoring.revisionId) return;
    try {
      evaluationExecution.begin(createEvaluationStartDraft({
        project: projectFile,
        suiteId: evaluationAuthoring.suiteId,
        revisionId: evaluationAuthoring.revisionId,
        selectedCaseIds: [...evaluationAuthoring.selectedCaseIds],
        repetitions: evaluationAuthoring.repetitions,
        profile: activeProfile,
        model: activeModel,
        capabilities: activeCapabilities,
        responseMode: activeResponseMode,
        temperature: activeTemperature,
        durable: Boolean(projectWorkspace),
      }));
    } catch (error) {
      project.setError(error instanceof Error ? error.message : "Could not prepare the evaluation.");
    }
  }

  function confirmEvaluation(): void {
    runSession.reset();
    repeatedExperiment.clear();
    setTraceOpen(false);
    setWorkbenchView("response");
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
    setRunHistoryOpen(false);
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
    runSession.reset();
    setWorkbenchView("response");
    setRunHistoryOpen(false);
  }
  const runReachedTerminalStatus = Boolean(
    runState &&
      ["completed", "cancelled", "failed"].includes(runState.status.kind),
  );
  const requestPreview = templateRequestPreview();
  const composerItems = projectTemplates.templateWorkbench.composerItems;
  const readiness = runReadiness({
    projectOpen: Boolean(projectFile),
    connectionMapped: mappedProfileId === activeProfile.id,
    activeProfileName: activeProfile.name,
    activeProfileEndpoint: activeProfile.endpoint,
    activeProfileModel: activeModel,
    selectedToolCount,
    toolsEnabled: activeCapabilities.tools,
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
    } else {
      setWorkbenchView("request");
    }
  }
  const responseEmptyState = runEmptyStatePresentation(readiness);
  const evaluationStartDisabledReason = evaluationStartReadiness({
    projectOpen: Boolean(projectFile),
    suiteSelected: Boolean(evaluationAuthoring.suiteId),
    revisionSelected: Boolean(evaluationAuthoring.revisionId),
    revisionAvailable: Boolean(projectFile?.conversationRevisions.some(
      ({ id }) => id === evaluationAuthoring.revisionId,
    )),
    diagnostics: evaluationAuthoring.diagnostics,
    selectedCaseCount: evaluationAuthoring.selectedCaseIds.size,
    repetitions: evaluationAuthoring.repetitions,
    selectedToolCount,
    connectionMapped: mappedProfileId === activeProfile.id,
    hasProjectMapping: Boolean(mappedProfileId),
    endpoint: activeProfile.endpoint,
    model: activeModel,
    activityInProgress: isRequestActive || repeatedExperiment.isRunning || evaluationExecution.isRunning,
  }).blockedReason;

  const onContextualRunShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
    event.preventDefault();
    if (
      confirmation ||
      repeatedExperiment.draft ||
      evaluationExecution.draft ||
      isRequestActive ||
      repeatedExperiment.isRunning ||
      evaluationExecution.isRunning
    ) return;
    if (requestActionContext === "evaluation") {
      if (!evaluationStartDisabledReason) startEvaluation();
      return;
    }
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

  function saveOrChooseProjectLocation(): void {
    if (projectWorkspace || !folderAccessAvailable) {
      void project.saveProject();
      return;
    }
    setProjectCreationMode("save");
  }

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
        activeProfile={activeProfile}
        activeModel={activeModel}
        hasCredential={credential.hasCredential}
        projectName={projectFile?.name}
        projectDirty={projectDirty}
        folderAccessAvailable={folderAccessAvailable}
        hasDiagnosticCapture={hasDiagnosticCapture}
        hasRunTrace={runReachedTerminalStatus}
        hasProjectWorkspace={Boolean(projectWorkspace)}
        runHistoryBlocked={(Boolean(runState) && !runReachedTerminalStatus) || repeatedExperiment.isRunning || evaluationExecution.isRunning}
        isRequestActive={isRequestActive}
        isExperimentActive={repeatedExperiment.isRunning || evaluationExecution.isRunning}
        actionContext={requestActionContext}
        awaitingToolResults={runState?.status.kind === "awaiting_tool_results"}
        retryableFailure={
          runState?.status.kind === "paused" &&
          runState.status.reason === "attempt_failed"
        }
        runDisabled={Boolean(readiness?.blocked)}
        runDisabledReason={readiness?.blocked ? readiness.summary : undefined}
        repeatDisabled={Boolean(readiness?.blocked) || selectedToolCount > 0}
        repeatDisabledReason={readiness?.blocked
          ? readiness.summary
          : selectedToolCount > 0
            ? "Repeated experiments do not support tools yet."
            : undefined}
        onChooseProfile={chooseProfile}
        onOpenConnections={() => setConnectionDrawerOpen(true)}
        onNewProject={() => setProjectCreationMode("new")}
        onOpenProject={() => void project.openProjectWorkspace()}
        onSaveProject={saveOrChooseProjectLocation}
        onImportProject={(event) => void project.importProject(event)}
        onExportProject={project.exportProject}
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
        onRepeat={repeat}
        onContinue={() => void continueRun()}
        onRetry={() => void retryRun()}
      />

      {projectError && (
        <div className="project-error" role="alert">
          <span>{projectError}</span>
          <div className="project-error-actions">
            {projectErrorKind === "workspace-reconnect" && (
              <button
                type="button"
                onClick={() => void project.reconnectProjectWorkspace()}
              >
                Reconnect
              </button>
            )}
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
      {(serverDefaultProfileNotice || originNotice.notice) && (
        <div className="workbench-notices">
          {serverDefaultProfileNotice && (
            <div className="workbench-notice" role="status">
              <div className="workbench-notice-copy">
                <strong>Server default connection available</strong>
                <span>
                  A profile using this server&apos;s configured endpoint was
                  added to Connections.
                </span>
              </div>
              <div className="workbench-notice-actions">
                <button
                  className="button primary"
                  type="button"
                  onClick={adoptServerDefaultProfile}
                >
                  Use it
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    dismissServerDefaultProfileNotice();
                    setConnectionDrawerOpen(true);
                  }}
                >
                  Review
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={dismissServerDefaultProfileNotice}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {originNotice.notice && (
            <div className="workbench-notice" role="status">
              <div className="workbench-notice-copy">
                <strong>{originNotice.notice.headline}</strong>
                <span>{originNotice.notice.detail}</span>
              </div>
              <div className="workbench-notice-actions">
                {originNotice.notice.suggestedUrl && (
                  <a
                    className="button primary"
                    href={originNotice.notice.suggestedUrl}
                    onClick={originNotice.dismiss}
                  >
                    Open it
                  </a>
                )}
                <button
                  className="button"
                  type="button"
                  onClick={originNotice.dismiss}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <ConnectionDrawer
        open={connectionDrawerOpen}
        onClose={() => setConnectionDrawerOpen(false)}
        profiles={profiles}
        activeProfile={activeProfile}
        capabilities={activeCapabilities}
        credential={credential}
        serverDefault={serverDefault}
        isDesktopRuntime={isDesktopRuntime}
        onSelectProfile={chooseProfile}
        onAddProfile={() => {
          const profile = addProfile();
          project.mapProfile(profile);
        }}
        onDeleteProfile={confirmDeleteActiveProfile}
        deleteProfileRefusal={activeProfileDeletionRefusal}
        onUpdateProfile={updateActiveProfile}
        onCapabilityChange={changeCapability}
        connectionRequirement={projectTemplates.activeConnectionRequirement}
        mappedProfileId={mappedProfileId}
        onMapProfile={() => {
          project.mapActiveProfile();
        }}
        onUpdateProjectEndpoint={confirmUpdateProjectEndpoint}
        pendingDestination={pendingReadinessDestination}
        onDestinationHandled={() => setPendingReadinessDestination(undefined)}
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

      <WorkbenchShell
        view={workbenchView}
        onViewChange={setWorkbenchView}
        inspectAvailable={Boolean(runState && runState.status.kind !== "not_started")}
        responseStatus={repeatedExperiment.isRunning || evaluationExecution.isRunning ? "running" : status}
        requestLabel={evaluationExecution.execution?.selectedRunId ? "Evaluation" : repeatedExperiment.execution?.selectedRunId ? "Experiment" : "Request"}
        request={
        evaluationExecution.execution?.selectedRunId ? <EvaluationResultsWorkspace
          execution={evaluationExecution.execution}
          placement="request"
          onStop={evaluationExecution.cancel}
          onOpenTrace={evaluationExecution.openTrace}
          onReturnToEvaluation={() => {
            evaluationExecution.returnToEvaluation();
            setWorkbenchView("request");
          }}
        /> : repeatedExperiment.execution?.selectedRunId ? <RepeatedExperimentWorkspace
          execution={repeatedExperiment.execution}
          placement="request"
          onStop={repeatedExperiment.cancel}
          onOpenTrace={repeatedExperiment.openTrace}
          onReturnToRequest={() => {
            repeatedExperiment.returnToRequest();
            setWorkbenchView("request");
          }}
        /> : <RequestComposer
          requestDraft={{
            messages, tools, requestTools, enabledToolIds, addTool, removeTool, updateTool,
            setToolEnabled, mockForTool, updateToolMock, removeRequestTool,
          }}
          templates={projectTemplates}
          evaluations={evaluationAuthoring}
          evaluationExecution={{
            storage: projectWorkspace ? "durable" : "unsaved",
            running: evaluationExecution.isRunning,
            preview: {
              targetName: activeProfile.name || "Untitled profile",
              endpoint: activeProfile.endpoint,
              protocol: "openai-compatible-chat-completions",
              model: activeModel,
              responseMode: activeResponseMode,
              options: { temperature: activeTemperature },
            },
            ...(evaluationStartDisabledReason ? { disabledReason: evaluationStartDisabledReason } : {}),
            onStart: startEvaluation,
          }}
          project={projectFile}
          settings={{
            model: activeModel,
            temperature: activeTemperature,
            responseMode: activeResponseMode,
            streamingAvailable: activeCapabilities.streaming,
            toolsEnabled: activeCapabilities.tools,
            modelDiscovery: activeModelDiscovery,
            favoriteModels: activeProfile.favoriteModels ?? [],
            onModelChange: setEditorModel,
            onTemperatureChange: setEditorTemperature,
            onStreamingPreferenceChange: setStreamingPreferred,
            onLoadModels: (force) => void loadModels(force),
            onToggleFavoriteModel: (model) =>
              updateActiveProfile({
                favoriteModels: toggleFavoriteModel(
                  activeProfile.favoriteModels,
                  model,
                ),
              }),
          }}
          {...(readiness ? { readiness } : {})}
          pendingDestination={pendingReadinessDestination}
          onReadinessAction={resolveReadiness}
          onDestinationHandled={() => setPendingReadinessDestination(undefined)}
          activeProfile={activeProfile}
          {...(branchContext ? { pendingBranch: branchContext } : {})}
          {...(requestPreview ? { requestPreview } : {})}
          n8nImportDisabledReason={
            branchContext
              ? "Finish or discard the pending branch before importing a prompt."
              : Boolean(runState) && !runReachedTerminalStatus
                ? "Finish or stop the current run before importing a prompt."
                : undefined
          }
          onOpenConnectionSettings={() => setConnectionDrawerOpen(true)}
          onOpenN8nImport={() => setN8nImportOpen(true)}
          onOpenToolLibrary={() => setToolRegistryOpen(true)}
          onSaveParentTrace={() => void runSession.exportTrace()}
          onDiscardPendingBranch={() => setBranchContext(null)}
          onActionContextChange={setRequestActionContext}
        />
        }
        response={
        <section className="result">
          {evaluationExecution.execution && !evaluationExecution.execution.selectedRunId ? <EvaluationResultsWorkspace
            execution={evaluationExecution.execution}
            onStop={evaluationExecution.cancel}
            onOpenTrace={evaluationExecution.openTrace}
          /> : repeatedExperiment.execution && !repeatedExperiment.execution.selectedRunId ? <RepeatedExperimentWorkspace
            execution={repeatedExperiment.execution}
            onStop={repeatedExperiment.cancel}
            onOpenTrace={repeatedExperiment.openTrace}
          /> : <ResponseOutput
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
            branchedFrom={visibleBranchProvenance}
            emptyState={responseEmptyState}
            onMarkdownPreviewChange={setMarkdownPreview}
            onOutputScroll={updateOutputFollowState}
            onJumpToLatest={jumpToLatestOutput}
            onToolResultDraftChange={runSession.updateToolResultDraft}
            onContinue={() => void continueRun()}
            onRetry={() => void retryRun()}
            onSaveTrace={() => void runSession.exportTrace()}
            onEditFromHere={editFromHere}
            onEmptyStateAction={() => {
              if (responseEmptyState.action) {
                resolveReadiness(responseEmptyState.action.destination);
              }
            }}
          />}

        </section>
        }
        inspect={
          <RunTracePanel
            open={traceOpen}
            runState={runState}
            branchedFrom={visibleBranchProvenance}
            parentTrace={parentTrace}
            onLoadParentTrace={() => void runSession.loadParentTrace()}
            onOpenChange={setTraceOpen}
          />
        }
      />
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
            projectModel: activeModel,
          }}
          onImport={projectTemplates.importN8nPrompt}
        />
      )}
      {projectCreationMode && (
        <ProjectCreationDialog
          initialName={projectFile?.name ?? "Untitled Inference Lens project"}
          onClose={() => setProjectCreationMode(undefined)}
          onCreate={(options) => {
            if (projectCreationMode === "new") {
              void project.newProjectFolder(options);
            } else {
              void project.saveProject(options);
            }
          }}
        />
      )}
      {repeatedExperiment.draft && (
        <RepeatedExperimentDialog
          draft={repeatedExperiment.draft}
          onCountChange={repeatedExperiment.setRepetitionCount}
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
      {confirmation && (
        <ConfirmationDialog
          request={confirmation}
          onClose={() => setConfirmation(undefined)}
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
