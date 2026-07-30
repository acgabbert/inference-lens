"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  ProviderCapabilities,
  RichInferenceRequest,
} from "../packages/core/src/types";
import {
  createProjectFile,
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
import type { RunReadinessActionKind } from "./run-readiness.client";
import type {
  ConfirmationDialogRequest,
} from "./confirmation-dialog.client";
import {
  prepareWorkbenchRun,
  type WorkbenchBranchContext,
} from "./run/prepare-workbench-run.client";
import { useRunSession } from "./run/use-run-session.client";
import { useProjectTemplates } from "./templates/use-project-templates.client";
import { RequestComposer } from "./request/request-composer.client";

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
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  const [savedRunVersion, setSavedRunVersion] = useState(0);
  const clearTemplateOverridesRef = useRef<() => void>(() => {});
  const [workbenchView, setWorkbenchView] =
    useState<WorkbenchView>("request");
  const [traceOpen, setTraceOpen] = useState(true);
  const [outputFollowing, setOutputFollowing] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [markdownPreviewLoaded, setMarkdownPreviewLoaded] = useState(false);
  const [streamingPreferred, setStreamingPreferred] = useState(true);
  const [streamingPreferenceLoaded, setStreamingPreferenceLoaded] =
    useState(false);
  const project = useProjectWorkspace({
    activeProfileId: activeProfile.id,
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
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
    onResetBranch() { setBranchContext(null); },
    onError(message) { project.setError(message, { clearKind: true }); },
    onClearError() { project.setError(undefined, { clearKind: true }); },
  });
  const { runState, isRequestActive, toolResultDrafts, traceStorage,
    hasDiagnosticCapture, visibleBranchProvenance, parentTrace, transcript } = runSession;
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
  const activeTemperature =
    sessionTemperature ?? activeProfile.temperature ?? 0.7;
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
    if (projectFile && !mappedProfileId) {
      project.setError(
        "Map this project's connection to a local profile before running.",
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
    return;
    /* Legacy implementation retained in git history during extraction.
    const coordinator = new RunCoordinator(input);
    parentTraceGenerationRef.current += 1;
    setParentTrace({ status: "idle" });
    if (prepared.branchedFrom) runBranchProvenanceRef.current.set(input.runId, prepared.branchedFrom);
    setVisibleBranchProvenance(prepared.branchedFrom);
    const requestGeneration = ++requestGenerationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setWorkbenchView("response");
    setOutputFollowing(true);
    setIsRequestActive(true);
    runTraceWorkspaceRef.current = projectWorkspace;
    setTraceStorage(null);
    coordinatorRef.current = coordinator;
    const command = coordinator.start();
    replaceRunState(coordinator.state);
    clearRequestTools();
    setToolResultDrafts({});
    const diagnosticCapture = startDiagnosticCapture(request);
    diagnosticCaptureRef.current = diagnosticCapture;
    setHasDiagnosticCapture(true);
    recordDiagnostic(diagnosticCapture, "client.request_started", { request });

    try {
      const selection = await credential.prepare();
      await executeProviderTurn(
        command.execution,
        selection,
        controller,
        requestGeneration,
        diagnosticCapture,
      );
    } catch (error) {
      if (
        controller.signal.aborted ||
        requestGenerationRef.current !== requestGeneration
      ) {
        recordDiagnostic(diagnosticCapture, "client.request_aborted");
        return;
      }
      recordDiagnostic(diagnosticCapture, "client.request_failed", {
        message: error instanceof Error ? error.message : "Request failed.",
      });
      const activeCoordinator = coordinatorRef.current;
      if (
        activeCoordinator &&
        !["completed", "cancelled", "failed"].includes(
          activeCoordinator.state.status.kind,
        )
      ) {
        activeCoordinator.fail({
          code: "internal_error",
          message: error instanceof Error ? error.message : "Request failed.",
        });
        replaceRunState(activeCoordinator.state);
      } else {
        replaceRunState(
          preserveRunFailure(
            runStateRef.current,
            request,
            identity,
            error instanceof Error ? error.message : "Request failed.",
          ),
        );
      }
    } finally {
      recordDiagnostic(diagnosticCapture, "client.stream_finished");
      if (requestGenerationRef.current === requestGeneration) {
        abortRef.current = null;
        setIsRequestActive(false);
      }
    }
  */
  }

  async function continueRun(): Promise<void> {
    return runSession.continueRun();
    /*
    const coordinator = coordinatorRef.current;
    if (
      !coordinator ||
      coordinator.state.status.kind !== "awaiting_tool_results"
    ) {
      return;
    }
    const waiting = coordinator.state.status;
    const calls =
      coordinator.state.turns
        .find(({ turnId }) => turnId === waiting.turnId)
        ?.attempts.at(-1)?.completedToolCalls ?? [];
    const byId = new Map(calls.map((call) => [call.id, call]));
    const results: ToolResult[] = waiting.pendingToolCallIds.map((toolCallId) => {
      const draft = toolResultDrafts[toolCallId];
      if (!draft) throw new Error(`Tool call ${toolCallId} has no result.`);
      return {
        id: createEntityId("tool-result", randomUUID()),
        toolCallId,
        content: [{ type: "text", text: draft.text }],
        resolution: draft.resolution,
        ...(byId.has(toolCallId) ? {} : { isError: true }),
      };
    });

    let controller: AbortController | undefined;
    try {
      coordinator.supplyToolResults(results);
      const command = coordinator.continue();
      replaceRunState(coordinator.state);
      setToolResultDrafts({});
      const requestGeneration = ++requestGenerationRef.current;
      controller = new AbortController();
      abortRef.current = controller;
      setWorkbenchView("response");
      setOutputFollowing(true);
      setIsRequestActive(true);
      const selection = await credential.prepare();
      const diagnosticCapture =
        diagnosticCaptureRef.current ?? startDiagnosticCapture(currentRequest());
      diagnosticCaptureRef.current = diagnosticCapture;
      await executeProviderTurn(
        command.execution,
        selection,
        controller,
        requestGeneration,
        diagnosticCapture,
      );
    } catch (error) {
      if (!controller?.signal.aborted) {
        const active = coordinatorRef.current;
        if (
          active &&
          !["completed", "cancelled", "failed"].includes(active.state.status.kind)
        ) {
          active.fail({
            code: "internal_error",
            message: error instanceof Error ? error.message : "Request failed.",
          });
          replaceRunState(active.state);
        }
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsRequestActive(false);
    }
  */
  }

  async function retryRun(): Promise<void> {
    return runSession.retry();
    /*
    const coordinator = coordinatorRef.current;
    if (
      !coordinator ||
      coordinator.state.status.kind !== "paused" ||
      coordinator.state.status.reason !== "attempt_failed"
    ) {
      return;
    }

    const requestGeneration = ++requestGenerationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setWorkbenchView("response");
    setOutputFollowing(true);
    setIsRequestActive(true);
    setToolResultDrafts({});
    const command = coordinator.retry();
    replaceRunState(coordinator.state);
    const diagnosticCapture =
      diagnosticCaptureRef.current ?? startDiagnosticCapture(currentRequest());
    diagnosticCaptureRef.current = diagnosticCapture;
    setHasDiagnosticCapture(true);
    recordDiagnostic(diagnosticCapture, "client.retry_started", {
      turnId: command.execution.turnId,
      attempt: command.execution.attempt,
      exchangeId: command.execution.exchangeId,
    });

    try {
      const selection = await credential.prepare();
      await executeProviderTurn(
        command.execution,
        selection,
        controller,
        requestGeneration,
        diagnosticCapture,
      );
    } catch (error) {
      if (
        !controller.signal.aborted &&
        !["completed", "cancelled", "failed"].includes(
          coordinator.state.status.kind,
        )
      ) {
        coordinator.fail({
          code: "internal_error",
          message: error instanceof Error ? error.message : "Request failed.",
        });
        replaceRunState(coordinator.state);
      }
    } finally {
      recordDiagnostic(diagnosticCapture, "client.stream_finished");
      if (requestGenerationRef.current === requestGeneration) {
        abortRef.current = null;
        setIsRequestActive(false);
      }
    }
  */
  }

  function stop() {
    runSession.stop();
    return;
    /*
    const controller = abortRef.current;
    requestGenerationRef.current += 1;
    if (diagnosticCaptureRef.current) {
      recordDiagnostic(diagnosticCaptureRef.current, "client.stop_requested");
    }
    abortRef.current = null;
    controller?.abort();
    setIsRequestActive(false);
    const coordinator = coordinatorRef.current;
    if (
      coordinator &&
      !["completed", "cancelled", "failed"].includes(
        coordinator.state.status.kind,
      )
    ) {
      const status = coordinator.state.status;
      if (status.kind === "paused" && status.reason === "attempt_failed") {
        coordinator.fail(status.error);
      } else {
        coordinator.cancel("Stopped by user.");
      }
      replaceRunState(coordinator.state);
    }
  */
  }

  function downloadDiagnostics() {
    runSession.downloadDiagnostics();
    return;
    /*
    const capture = diagnosticCaptureRef.current;
    if (!capture) return;
    const bundle = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      privacy: {
        credentials: "redacted",
        messageBodies: "included",
      },
      capture,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `inference-lens-diagnostics-${bundle.exportedAt.replaceAll(":", "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function runTraceForState(state: RunState | null): RunTrace | undefined {
    if (
      !state ||
      !["completed", "cancelled", "failed"].includes(state.status.kind)
    ) {
      return undefined;
    }
    try {
      return createRunTrace(state, {
        branchedFrom: runBranchProvenanceRef.current.get(state.runId),
      });
    } catch {
      return undefined;
    }
  }

  async function exportRunTrace(): Promise<void> {
    const trace = runTraceForState(runStateRef.current);
    if (!trace) return;
    const previous = traceStorage;
    const preserveProjectLocation =
      previous?.kind === "saved" && Boolean(runTraceWorkspaceRef.current);
    setTraceStorage({ kind: "saving" });
    try {
      const result = await exportRunTraceFile(trace);
      if (result.kind === "saved") {
        setTraceStorage(
          preserveProjectLocation
            ? previous
            : { kind: "saved", location: result.location },
        );
      } else if (result.kind === "downloaded") {
        setTraceStorage(
          preserveProjectLocation
            ? previous
            : {
                kind: "downloaded",
                fileName: result.fileName,
              },
        );
      } else {
        setTraceStorage(previous ?? { kind: "unsaved" });
      }
    } catch (error) {
      setTraceStorage({
        kind: "error",
        message:
          error instanceof Error ? error.message : "The trace could not be saved.",
      });
    }
  }

  // Legacy trace adoption implementation.
   * Replaces the workbench with a trace the user is inspecting rather than
   * running. Importing a file and opening a project's saved run differ only in
   * where the trace came from and how it is stored, so both go through here:
   * the live coordinator is dropped, drafts and diagnostics from the previous
   * run are cleared, and the response view is brought forward.
   *
   * `origin.workspace` is the folder the trace already lives in, or null for a
   * trace that has no home on disk. Naming it here is what keeps the autosave
   * effect from writing an artifact back over the file it was just read from.
  function adoptRunTrace(
    trace: RunTrace,
    origin:
      | { workspace: ProjectWorkspaceHandle; fileName: string }
      | { workspace: null; fileName: string },
  ): void {
    if (trace.branchedFrom) {
      runBranchProvenanceRef.current.set(trace.runId, trace.branchedFrom);
    }
    if (origin.workspace) persistedTraceRunIdsRef.current.add(trace.runId);
    coordinatorRef.current = null;
    runTraceWorkspaceRef.current = origin.workspace;
    diagnosticCaptureRef.current = null;
    setHasDiagnosticCapture(false);
    setToolResultDrafts({});
    setBranchContext(null);
    parentTraceGenerationRef.current += 1;
    setParentTrace({ status: "idle" });
    setVisibleBranchProvenance(trace.branchedFrom);
    setWorkbenchView("response");
    setTraceOpen(true);
    replaceRunState(runStateFromTrace(trace));
    setTraceStorage(
      origin.workspace
        ? {
            kind: "saved",
            location: runTraceWorkspacePath(origin.workspace, origin.fileName),
          }
        : { kind: "loaded", fileName: origin.fileName },
    );
    project.setError(undefined, { clearKind: true });
  }

  async function importRunTrace(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      adoptRunTrace(parseRunTraceJson(await file.text()), {
        workspace: null,
        fileName: file.name,
      });
    } catch (error) {
      project.setError(
        error instanceof Error ? error.message : "Could not import the run trace.",
        { clearKind: true },
      );
    } finally {
      event.target.value = "";
    }
  }

  // Legacy history trace opener.
   * Reads the selected artifact again instead of trusting a copy held from
   * when the list was built. Errors propagate to the drawer, which keeps the
   * list on screen so another run can be chosen.
  async function openHistoryTrace(item: ProjectRunHistoryItem): Promise<void> {
    const workspace = projectWorkspace;
    if (!workspace) throw new Error("The project folder is no longer open.");
    const trace = await runHistory.readTrace(item.fileName);
    runSession.adoptTrace(trace, { workspace, fileName: item.fileName });
    setRunHistoryOpen(false);
    return;
    adoptRunTrace(trace, { workspace, fileName: item.fileName });
    setRunHistoryOpen(false);
  }

  async function loadParentTrace(): Promise<void> {
    const provenance = visibleBranchProvenance;
    const generation = ++parentTraceGenerationRef.current;
    if (!provenance) return;
    if (!projectWorkspace) {
      setParentTrace({
        status: "error",
        error:
          "Open the project folder that contains the parent run, then load it again. If the parent was never saved, save that run first.",
      });
      return;
    }

    setParentTrace({ status: "loading" });
    try {
      const trace = await runHistory.readTrace(traceFileName(provenance.runId));
      if (generation !== parentTraceGenerationRef.current) return;
      if (trace.runId !== provenance.runId) {
        throw new Error("The parent trace file contains a different run.");
      }
      setParentTrace({ status: "ready", trace });
    } catch (error) {
      if (generation !== parentTraceGenerationRef.current) return;
      setParentTrace({
        status: "error",
        error: `The parent run could not be loaded. Save run ${provenance.runId} in this project folder, then try again. ${
          error instanceof Error ? error.message : "The trace could not be read."
        }`,
      });
    }
  }

  */
  }
  async function openHistoryTrace(item: ProjectRunHistoryItem): Promise<void> {
    const workspace = projectWorkspace;
    if (!workspace) throw new Error("The project folder is no longer open.");
    runSession.adoptTrace(await runHistory.readTrace(item.fileName), {
      workspace,
      fileName: item.fileName,
    });
    setTraceOpen(true);
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
    connectionMapped: Boolean(mappedProfileId),
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

  function resolveReadiness(kind: RunReadinessActionKind): void {
    if (kind === "map-profile") project.mapActiveProfile();
    else if (kind === "open-connections") setConnectionDrawerOpen(true);
  }

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
        n8nImportDisabledReason={
          branchContext
            ? "Finish or discard the pending branch before importing a prompt."
            : Boolean(runState) && !runReachedTerminalStatus
              ? "Finish or stop the current run before importing a prompt."
              : undefined
        }
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
        onNewProject={() => setProjectCreationMode("new")}
        onOpenProject={() => void project.openProjectWorkspace()}
        onSaveProject={saveOrChooseProjectLocation}
        onImportProject={(event) => void project.importProject(event)}
        onOpenN8nImport={() => setN8nImportOpen(true)}
        onExportProject={project.exportProject}
        onOpenToolLibrary={() => setToolRegistryOpen(true)}
        onDownloadDiagnostics={downloadDiagnostics}
        onDownloadRunTrace={() => void runSession.exportTrace()}
        onImportRunTrace={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            setTraceOpen(true);
            void runSession.importTrace(file);
          }
          event.target.value = "";
        }}
        onOpenRunHistory={() => setRunHistoryOpen(true)}
        onStop={stop}
        onRun={() => void run()}
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
          const profileId = addProfile();
          project.mapProfile(profileId);
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
          requestDraft={{
            messages, tools, requestTools, enabledToolIds, addTool, removeTool, updateTool,
            setToolEnabled, mockForTool, updateToolMock, removeRequestTool,
          }}
          templates={projectTemplates}
          project={projectFile}
          settings={{
            model: activeModel,
            temperature: activeTemperature,
            responseMode: activeResponseMode,
            streamingAvailable: activeCapabilities.streaming,
            toolsEnabled: activeCapabilities.tools,
            modelDiscovery: activeModelDiscovery,
            onModelChange: setEditorModel,
            onTemperatureChange: setEditorTemperature,
            onStreamingPreferenceChange: setStreamingPreferred,
            onLoadModels: (force) => void loadModels(force),
          }}
          {...(readiness ? { readiness } : {})}
          onReadinessAction={resolveReadiness}
          activeProfile={activeProfile}
          {...(branchContext ? { pendingBranch: branchContext } : {})}
          {...(requestPreview ? { requestPreview } : {})}
          onOpenConnectionSettings={() => setConnectionDrawerOpen(true)}
          onOpenToolLibrary={() => setToolRegistryOpen(true)}
          onSaveParentTrace={() => void runSession.exportTrace()}
          onDiscardPendingBranch={() => setBranchContext(null)}
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
            branchedFrom={visibleBranchProvenance}
            onMarkdownPreviewChange={setMarkdownPreview}
            onOutputScroll={updateOutputFollowState}
            onJumpToLatest={jumpToLatestOutput}
            onToolResultDraftChange={runSession.updateToolResultDraft}
            onContinue={() => void continueRun()}
            onRetry={() => void retryRun()}
            onSaveTrace={() => void runSession.exportTrace()}
            onEditFromHere={editFromHere}
          />

          <RunTracePanel
            open={traceOpen}
            runState={runState}
            branchedFrom={visibleBranchProvenance}
            parentTrace={parentTrace}
            onLoadParentTrace={() => void runSession.loadParentTrace()}
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
