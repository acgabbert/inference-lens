"use client";

import {
  type ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ProviderCapabilities,
  RichInferenceRequest,
} from "../packages/core/src/types";
import {
  appendPromptTemplateRevision,
  createBranchRevision,
  createProjectFile,
  createPromptTemplate,
  detachPromptTemplateUse,
  findPromptTemplateUsages,
  insertPromptTemplateUse,
  prepareProjectRevisionRun,
  projectDraft,
  removePromptTemplateUse,
  renamePromptTemplate,
  resolveProjectRevision,
  sameConversationMessages,
  setPromptTemplateRecommendedTarget,
  updateProjectDraft,
  updatePromptTemplateUseToLatest,
  updatePromptTemplateUseValues,
} from "../packages/core/src/project";
import type {
  ProjectConversationItem,
  ProjectTemplateDiagnostic,
  PromptTemplateContent,
  PromptTemplateRecommendedTarget,
  TemplateRunOverrides,
} from "../packages/core/src/project";
import {
  createEntityId,
  createResolvedRunInput,
  createSingleTurnRunExecution,
  createRunTrace,
  RunCoordinator,
  transcriptFromRunState,
} from "../packages/core/src/run-kernel";
import {
  parseRunTraceJson,
  runStateFromTrace,
  traceFileName,
} from "../packages/core/src/run-trace";
import {
  importExternalPromptCandidate,
  importExternalPromptTemplateCandidate,
} from "../packages/core/src/external-prompt-project.ts";
import type {
  ExternalPromptCandidate,
} from "../packages/core/src/external-prompt-import.ts";
import type {
  ProviderExecution,
  RunState,
  RunTrace,
  ConversationMessage,
  ConversationId,
  ConversationRevisionId,
  MessageId,
  RunId,
  RunConversationIdentity,
  PromptTemplateId,
  PromptTemplateUseId,
  ResolvedTemplateUse,
  ToolDefinition,
  ToolResult,
} from "../packages/core/src/run-kernel";
import { buildChatCompletionsRequest } from "../packages/core/src/openai-compatible";
import { discoverTemplateVariables } from "../packages/core/src/template-engine";
import { conversationMessageText } from "./conversation-display";
import type { CredentialSelection } from "../packages/contracts/src";
import {
  createInferenceTransport,
  isTauriRuntime,
} from "./tauri-inference-transport.client";
import {
  InferenceTransportError,
} from "./http-inference-transport.client";
import { AppErrorBoundary } from "./app-error-boundary.client";
import { useInsecureOriginNotice } from "./use-insecure-origin.client";
import { randomUUID } from "../packages/core/src/random-id.ts";
import {
  recordDiagnostic,
  redactDiagnosticValue,
  startDiagnosticCapture,
} from "./diagnostics.client";
import type { DiagnosticCapture } from "./diagnostics.client";
import { preserveRunFailure } from "./run-failure.client";
import {
  exportRunTraceFile,
  projectFolderAccessAvailable,
  runTraceWorkspaceLocation,
  runTraceWorkspacePath,
  saveRunTraceWorkspace,
} from "./project-workspace.client";
import type { ProjectWorkspaceHandle } from "./project-workspace.client";
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
import { ModelCombobox } from "./model-combobox.client";
import { useModelDiscovery } from "./use-model-discovery.client";
import { useConnectionProfiles } from "./use-connection-profiles.client";
import {
  removeDraftMessage,
  useRequestDraft,
} from "./use-request-draft.client";
import { useProjectWorkspace } from "./use-project-workspace.client";
import { ConnectionDrawer } from "./connection-drawer.client";
import { Topbar } from "./topbar.client";
import { ToolsPane } from "./tools-pane.client";
import { ResponseOutput } from "./response-output.client";
import type { TraceStorageStatus } from "./response-output.client";
import type { ToolResultDraft } from "./tool-call-list.client";
import {
  PaneTabs,
  WorkbenchShell,
} from "./workbench-shell.client";
import type { WorkbenchView } from "./workbench-shell.client";
import {
  RunTracePanel,
  type ParentTraceState,
} from "./run-trace-panel.client";
import { RunHistoryDrawer } from "./run-history-drawer.client";
import type { ProjectRunHistoryItem } from "./use-project-run-history.client";
import { useProjectRunHistory } from "./use-project-run-history.client";
import {
  ProjectTemplatesPane,
  TemplateUseCard,
} from "./project-templates-pane.client";
import {
  pendingBranchMessagesAfterItemUpdate,
  projectTemplateWorkbenchView,
} from "./project-template-workbench.client";
import {
  ConfirmationDialog,
} from "./confirmation-dialog.client";
import { runReadiness } from "./run-readiness.client";
import type { RunReadinessActionKind } from "./run-readiness.client";
import { RunReadinessNotice } from "./run-readiness-notice.client";
import type {
  ConfirmationDialogRequest,
} from "./confirmation-dialog.client";

const inferenceTransport = createInferenceTransport();

const MARKDOWN_PREVIEW_STORAGE_KEY = "inference-lens:markdown-preview:v1";
const STREAMING_PREFERENCE_STORAGE_KEY =
  "inference-lens:streaming-preference:v1";

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

function templateRunErrorMessage(
  diagnostics: ProjectTemplateDiagnostic[],
): string {
  const first = diagnostics[0];
  if (!first) return "Resolve the template diagnostics before running.";
  const remaining = diagnostics.length - 1;
  return `Cannot run template use "${first.templateUseId}": ${first.diagnostic.message}${
    remaining > 0 ? ` (${remaining} more ${remaining === 1 ? "issue" : "issues"})` : ""
  }`;
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
  const [requestTab, setRequestTab] =
    useState<"messages" | "templates" | "tools">("messages");
  const [importNotice, setImportNotice] = useState<{
    name: string;
    variableCount: number;
    template: boolean;
  }>();
  const [templateRunOverrides, setTemplateRunOverrides] =
    useState<TemplateRunOverrides>({});
  const [workbenchView, setWorkbenchView] =
    useState<WorkbenchView>("request");
  const [traceOpen, setTraceOpen] = useState(true);
  const [outputFollowing, setOutputFollowing] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [markdownPreviewLoaded, setMarkdownPreviewLoaded] = useState(false);
  const [streamingPreferred, setStreamingPreferred] = useState(true);
  const [streamingPreferenceLoaded, setStreamingPreferenceLoaded] =
    useState(false);
  const [toolResultDrafts, setToolResultDrafts] = useState<
    Record<string, ToolResultDraft>
  >({});
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
      setTemplateRunOverrides({});
      setBranchContext(null);
      setSessionModel(draft.model);
      setSessionTemperature(draft.temperature ?? 0.7);
      coordinatorRef.current = null;
      setToolResultDrafts({});
      replaceRunState(null);
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
  const [runState, setRunState] = useState<RunState | null>(null);
  const [isRequestActive, setIsRequestActive] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const coordinatorRef = useRef<RunCoordinator | null>(null);
  const runStateRef = useRef<RunState | null>(null);
  const requestGenerationRef = useRef(0);
  const adHocConversationIdRef = useRef<ConversationId | null>(null);
  const runTraceWorkspaceRef = useRef<ProjectWorkspaceHandle | null>(null);
  const persistedTraceRunIdsRef = useRef(new Set<string>());
  const diagnosticCaptureRef = useRef<DiagnosticCapture | null>(null);
  const outputScrollRef = useRef<HTMLDivElement | null>(null);
  const [hasDiagnosticCapture, setHasDiagnosticCapture] = useState(false);
  const [traceStorage, setTraceStorage] =
    useState<TraceStorageStatus | null>(null);
  const [branchContext, setBranchContext] = useState<BranchContext | null>(null);
  const [visibleBranchProvenance, setVisibleBranchProvenance] =
    useState<RunTrace["branchedFrom"]>();
  const [parentTrace, setParentTrace] = useState<ParentTraceState>({
    status: "idle",
  });
  const parentTraceGenerationRef = useRef(0);
  const runBranchProvenanceRef = useRef(
    new Map<RunId, RunTrace["branchedFrom"]>(),
  );
  const executedRevisionIdsRef = useRef(new Set<ConversationRevisionId>());
  useEffect(() => {
    if (projectFile && !projectDirty) {
      executedRevisionIdsRef.current.add(
        projectFile.defaults.conversationRevisionId,
      );
    }
  }, [projectDirty, projectFile]);
  const nonBranchableMessageIds = useMemo(
    () =>
      new Set(
        runState?.input?.templateResolutions.flatMap((resolution) =>
          resolution.outputMessageIds.slice(0, -1),
        ) ?? [],
      ),
    [runState],
  );
  const transcript = useMemo(
    () => (runState ? transcriptFromRunState(runState) : []),
    [runState],
  );

  function replaceRunState(next: RunState | null): void {
    runStateRef.current = next;
    setRunState(next);
    if (!next) {
      setTraceStorage(null);
      return;
    }
    if (
      !["completed", "cancelled", "failed"].includes(next.status.kind)
    ) {
      return;
    }
    const workspace = runTraceWorkspaceRef.current;
    if (!workspace) {
      setTraceStorage({ kind: "unsaved" });
      return;
    }
    if (persistedTraceRunIdsRef.current.has(next.runId)) return;
    let trace: RunTrace;
    try {
      trace = createRunTrace(next, {
        branchedFrom: runBranchProvenanceRef.current.get(next.runId),
      });
    } catch {
      return;
    }
    const location = runTraceWorkspaceLocation(workspace, trace);
    setTraceStorage({ kind: "saving", location });
    persistedTraceRunIdsRef.current.add(next.runId);
    void saveRunTraceWorkspace(workspace, trace)
      .then(() => {
        if (runStateRef.current?.runId === next.runId) {
          setTraceStorage({ kind: "saved", location });
        }
        // Marks the history stale; the folder is re-read next time it is opened.
        setSavedRunVersion((current) => current + 1);
      })
      .catch((error) => {
        persistedTraceRunIdsRef.current.delete(next.runId);
        if (runStateRef.current?.runId === next.runId) {
          setTraceStorage({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "The project trace could not be saved.",
          });
        }
      });
  }

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
  const activeProjectRevision = projectFile?.conversationRevisions.find(
    ({ id }) => id === projectFile.defaults.conversationRevisionId,
  );
  const templateWorkbench = projectTemplateWorkbenchView({
    project: projectFile,
    messages,
    runOverrides: templateRunOverrides,
    branchParentRevisionId: branchContext?.parentConversationRevisionId,
  });
  const activeProjectResolution = templateWorkbench.resolution;
  const templateUsageCounts = (() => {
    const counts = new Map<PromptTemplateId, number>();
    projectFile?.promptTemplates.forEach((template) => {
      counts.set(
        template.id,
        findPromptTemplateUsages(projectFile, template.id).length,
      );
    });
    return counts;
  })();
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

  function ensureProjectDocument() {
    return projectFile
      ? project.currentProjectDocument()
      : project.materializeProject();
  }

  function adoptAuthoredProject(
    next: ReturnType<typeof ensureProjectDocument>,
    overrides: TemplateRunOverrides = templateRunOverrides,
  ): void {
    project.adoptProjectMutation(next);
    replaceProjectDraft(projectDraft(next, overrides));
  }

  async function importN8nPrompt(
    candidate: ExternalPromptCandidate,
    mode: "resolved-snapshot" | "reusable-template",
    { recommendModel }: { recommendModel: boolean },
  ): Promise<void> {
    const imported =
      mode === "reusable-template"
        ? await importExternalPromptTemplateCandidate(
            ensureProjectDocument(),
            candidate,
            { recommendModel },
          )
        : await importExternalPromptCandidate(
            ensureProjectDocument(),
            candidate,
          );
    project.adoptProjectMutation(imported.project);
    replaceProjectDraft(projectDraft(imported.project));
    setTemplateRunOverrides({});
    setBranchContext(null);
    setToolResultDrafts({});
    setRequestTab("messages");
    setWorkbenchView("request");
    const receipt = imported.project.externalImports.find(
      ({ id }) => id === imported.externalImportId,
    );
    const variableCount =
      receipt?.projection.kind === "prompt-template"
        ? receipt.projection.variables.length
        : 0;
    setImportNotice({
      name: candidate.invocation.name,
      variableCount,
      template: mode === "reusable-template",
    });
    setN8nImportOpen(false);
  }

  function projectForUseMutation(): {
    project: ReturnType<typeof ensureProjectDocument>;
    revisionId: ConversationRevisionId;
  } {
    let base = ensureProjectDocument();
    let revision = base.conversationRevisions.find(
      ({ id }) => id === base.defaults.conversationRevisionId,
    )!;
    if (executedRevisionIdsRef.current.has(revision.id)) {
      base = createBranchRevision(base, {
        conversationId: revision.conversationId,
        parentRevisionId: revision.id,
        messages: resolveProjectRevision(
          base,
          revision,
          templateRunOverrides,
        ).messages,
        items: structuredClone(revision.items),
      });
      revision = base.conversationRevisions.find(
        ({ id }) => id === base.defaults.conversationRevisionId,
      )!;
    }
    return { project: base, revisionId: revision.id };
  }

  function createProjectTemplate(
    name: string,
    content: PromptTemplateContent,
  ): PromptTemplateId {
    const suffix = randomUUID();
    const next = createPromptTemplate(ensureProjectDocument(), {
      name,
      content,
      idSuffix: suffix,
      revisionIdSuffix: `${suffix}-1`,
    });
    adoptAuthoredProject(next);
    return createEntityId("template", suffix);
  }

  function saveProjectTemplate(
    templateId: PromptTemplateId,
    name: string,
    content: PromptTemplateContent,
    defaults: Record<string, string>,
    recommendedTarget?: PromptTemplateRecommendedTarget,
  ) {
    let next = renamePromptTemplate(ensureProjectDocument(), templateId, name);
    // Template metadata first, then authored content: only the latter can
    // append a revision, so a recommendation-only edit keeps uses pinned.
    next = setPromptTemplateRecommendedTarget(next, templateId, recommendedTarget);
    next = appendPromptTemplateRevision(next, {
      templateId,
      content,
      variableDefaults: defaults,
    });
    adoptAuthoredProject(next);
    return next.promptTemplates.find(({ id }) => id === templateId)!
      .currentRevisionId;
  }

  function insertProjectTemplate(
    templateId: PromptTemplateId,
    role: "system" | "user" | "assistant",
    itemIndex: number,
  ): void {
    const { project: base, revisionId } = projectForUseMutation();
    const next = insertPromptTemplateUse(base, {
      conversationRevisionId: revisionId,
      templateId,
      fragmentRole: role,
      itemIndex,
    });
    adoptAuthoredProject(next);
    setRequestTab("messages");
  }

  function updateTemplateUseValues(
    templateUseId: PromptTemplateUseId,
    values: Record<string, string>,
  ): void {
    const { project: base, revisionId } = projectForUseMutation();
    const next = updatePromptTemplateUseValues(base, {
      conversationRevisionId: revisionId,
      templateUseId,
      values,
    });
    adoptAuthoredProject(next);
  }

  function updateTemplateUseOverride(
    templateUseId: PromptTemplateUseId,
    values: Record<string, string>,
  ): void {
    const next = { ...templateRunOverrides, [templateUseId]: values };
    setTemplateRunOverrides(next);
    if (projectFile) replaceProjectDraft(projectDraft(projectFile, next));
  }

  function saveTemplateUseRunValue(
    templateUseId: PromptTemplateUseId,
    values: Record<string, string>,
    useOverrides: Record<string, string>,
  ): void {
    const { project: base, revisionId } = projectForUseMutation();
    const nextProject = updatePromptTemplateUseValues(base, {
      conversationRevisionId: revisionId,
      templateUseId,
      values,
    });
    const nextOverrides = { ...templateRunOverrides };
    if (Object.keys(useOverrides).length > 0) {
      nextOverrides[templateUseId] = useOverrides;
    } else {
      delete nextOverrides[templateUseId];
    }
    setTemplateRunOverrides(nextOverrides);
    adoptAuthoredProject(nextProject, nextOverrides);
  }

  function updateTemplateUseToLatestRevision(
    templateUseId: PromptTemplateUseId,
  ): void {
    const currentProject = ensureProjectDocument();
    const currentRevision = currentProject.conversationRevisions.find(
      ({ id }) => id === currentProject.defaults.conversationRevisionId,
    )!;
    const item = currentRevision.items.find(
      (candidate) =>
        candidate.kind === "template-use" &&
        candidate.use.id === templateUseId,
    );
    if (!item || item.kind !== "template-use") return;
    const template = currentProject.promptTemplates.find(
      ({ id }) => id === item.use.templateId,
    )!;
    const pinned = template.revisions.find(
      ({ id }) => id === item.use.templateRevisionId,
    )!;
    const latest = template.revisions.find(
      ({ id }) => id === template.currentRevisionId,
    )!;
    const pinnedVariables = discoverTemplateVariables(pinned.content).variables.map(
      ({ name }) => name,
    );
    const latestVariables = discoverTemplateVariables(latest.content).variables.map(
      ({ name }) => name,
    );
    const describeContent = (content: PromptTemplateContent): string =>
      content.kind === "fragment"
        ? content.text
        : content.messages
            .map(({ role, content: text }) => `${role}: ${text}`)
            .join("\n");
    setConfirmation({
      title: `Update "${template.name}"?`,
      description:
        "The use will pin the latest immutable revision. Assignments for removed variables and its run-only overrides will be cleared.",
      confirmLabel: "Update to latest",
      details: [
        { label: "From", value: pinned.id },
        { label: "To", value: latest.id },
        {
          label: "Variables",
          value: `${pinnedVariables.join(", ") || "none"} → ${latestVariables.join(", ") || "none"}`,
        },
        { label: "Current content", value: describeContent(pinned.content) },
        { label: "Latest content", value: describeContent(latest.content) },
      ],
      onConfirm() {
        const { project: base, revisionId } = projectForUseMutation();
        const latestCount =
          latest.content.kind === "fragment" ? 1 : latest.content.messages.length;
        const extraIds = Array.from(
          {
            length: Math.max(0, latestCount - item.use.outputMessageIds.length),
          },
          () => randomUUID(),
        );
        const next = updatePromptTemplateUseToLatest(base, {
          conversationRevisionId: revisionId,
          templateUseId,
          newOutputMessageIdSuffixes: extraIds,
          ...(latest.content.kind === "fragment"
            ? { fragmentRole: item.use.fragmentRole ?? "user" }
            : {}),
        });
        const overrides = { ...templateRunOverrides };
        delete overrides[templateUseId];
        setTemplateRunOverrides(overrides);
        adoptAuthoredProject(next, overrides);
      },
    });
  }

  function detachTemplateUseFromProject(
    templateUseId: PromptTemplateUseId,
  ): void {
    setConfirmation({
      title: "Detach this template use?",
      description:
        "Its currently resolved values, including run-only overrides, will become ordinary literal messages with the same message IDs.",
      confirmLabel: "Detach",
      onConfirm() {
        const { project: base, revisionId } = projectForUseMutation();
        const next = detachPromptTemplateUse(base, {
          conversationRevisionId: revisionId,
          templateUseId,
          runOverrides: templateRunOverrides,
        });
        const overrides = { ...templateRunOverrides };
        delete overrides[templateUseId];
        setTemplateRunOverrides(overrides);
        adoptAuthoredProject(next, overrides);
      },
    });
  }

  function removeTemplateUseFromProject(
    templateUseId: PromptTemplateUseId,
  ): void {
    setConfirmation({
      title: "Remove this template use?",
      description:
        "The pinned use and all messages it generates will be removed from this conversation revision.",
      confirmLabel: "Remove use",
      destructive: true,
      onConfirm() {
        const { project: base, revisionId } = projectForUseMutation();
        const next = removePromptTemplateUse(base, revisionId, templateUseId);
        const overrides = { ...templateRunOverrides };
        delete overrides[templateUseId];
        setTemplateRunOverrides(overrides);
        adoptAuthoredProject(next, overrides);
      },
    });
  }

  function mutateAuthoredItems(
    update: (items: ProjectConversationItem[]) => ProjectConversationItem[],
  ): void {
    if (branchContext) {
      if (!projectFile || !branchContext.parentConversationRevisionId) {
        project.setError(
          "This branch context is missing its parent revision. Start the branch again from its source run.",
        );
        return;
      }
      try {
        resetMessages(
          pendingBranchMessagesAfterItemUpdate({
            project: projectFile,
            messages,
            runOverrides: templateRunOverrides,
            parentRevisionId: branchContext.parentConversationRevisionId,
            update,
          }),
        );
        project.setError(undefined);
      } catch (error) {
        project.setError(
          error instanceof Error
            ? error.message
            : "Could not update the pending branch.",
        );
      }
      return;
    }
    const { project: base, revisionId } = projectForUseMutation();
    const revision = base.conversationRevisions.find(
      ({ id }) => id === revisionId,
    )!;
    const next = updateProjectDraft(base, {
      messages,
      items: update(structuredClone(revision.items)),
      model: activeModel,
      temperature: activeTemperature,
      tools: serializedTools(),
      toolMocks,
      enabledToolIds,
    });
    adoptAuthoredProject(next);
  }

  function addComposerMessage(): void {
    if (!projectFile) {
      addMessage();
      return;
    }
    mutateAuthoredItems((items) => [
      ...items,
      {
        kind: "message",
        message: {
          id: createEntityId("message", randomUUID()),
          role: "user",
          content: [{ type: "text", text: "" }],
        },
      },
    ]);
  }

  function updateComposerMessage(
    id: MessageId,
    patch: {
      content?: ConversationMessage["content"];
      role?: ConversationMessage["role"];
    },
  ): void {
    if (!projectFile) {
      updateMessage(id, patch);
      return;
    }
    mutateAuthoredItems((items) =>
      items.map((item) => {
        if (item.kind !== "message" || item.message.id !== id) return item;
        const message = item.message;
        const content = patch.content ?? message.content;
        if (
          message.role === "tool" ||
          (message.role === "assistant" && message.toolCalls?.length)
        ) {
          return { ...item, message: { ...message, content } };
        }
        return {
          ...item,
          message: {
            id: message.id,
            role: patch.role ?? message.role,
            content,
          } as ConversationMessage,
        };
      }),
    );
  }

  function removeComposerMessage(id: MessageId): void {
    if (!projectFile) {
      removeMessage(id);
      return;
    }
    const remainingIds = new Set(
      removeDraftMessage(messages, id).map((message) => message.id),
    );
    mutateAuthoredItems((items) =>
      items.filter(
        (item) =>
          item.kind === "template-use" || remainingIds.has(item.message.id),
      ),
    );
  }

  const { output, reasoning, status } = useMemo(() => {
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
  }, [runState]);

  const completedToolCalls = useMemo(
    () =>
      runState?.turns.flatMap(
        (turn) => turn.attempts.at(-1)?.completedToolCalls ?? [],
      ) ?? [],
    [runState],
  );

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

  function currentRunIdentity(): RunConversationIdentity {
    const revision = projectFile?.conversationRevisions.find(
      ({ id }) => id === projectFile.defaults.conversationRevisionId,
    );
    if (revision) {
      return {
        conversationId: revision.conversationId,
        conversationRevisionId: revision.id,
      };
    }
    const conversationId =
      adHocConversationIdRef.current ??
      createEntityId("conversation", randomUUID());
    adHocConversationIdRef.current = conversationId;
    return {
      conversationId,
      conversationRevisionId: createEntityId("revision", randomUUID()),
    };
  }

  function templateRequestPreview():
    | { body: unknown; messages: ConversationMessage[] }
    | { error: string }
    | undefined {
    if (!projectFile || !activeProjectRevision) {
      return undefined;
    }
    if (templateWorkbench.resolutionError) {
      return { error: templateWorkbench.resolutionError };
    }
    if (!activeProjectResolution) return undefined;
    try {
      const request = {
        ...currentRequest(),
        messages: activeProjectResolution.messages,
      };
      const execution = createSingleTurnRunExecution(
        request,
        {
          conversationId: activeProjectRevision.conversationId,
          conversationRevisionId: activeProjectRevision.id,
        },
        "template-preview",
        "1970-01-01T00:00:00.000Z",
        [...resolvedTools(), ...requestTools],
        activeProjectResolution.templateResolutions,
      );
      return {
        messages: activeProjectResolution.messages,
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

  function prepareToolResultDrafts(state: RunState): void {
    if (state.status.kind !== "awaiting_tool_results") {
      setToolResultDrafts({});
      return;
    }
    const status = state.status;
    const pending = new Set(status.pendingToolCallIds);
    const calls =
      state.turns
        .find(({ turnId }) => turnId === status.turnId)
        ?.attempts.at(-1)?.completedToolCalls ?? [];
    const drafts: Record<string, ToolResultDraft> = {};
    for (const call of calls) {
      if (!pending.has(call.id)) continue;
      const definition = tools.find((tool) => tool.name === call.name);
      const mock = definition ? mockForTool(definition.id) : undefined;
      drafts[call.id] = mock?.enabled
        ? {
            text: mock.result.content.map(({ text }) => text).join(""),
            resolution: { kind: "mock", ruleId: mock.id },
          }
        : { text: "", resolution: { kind: "manual" } };
    }
    setToolResultDrafts(drafts);
  }

  async function executeProviderTurn(
    execution: ProviderExecution,
    credential: CredentialSelection,
    controller: AbortController,
    requestGeneration: number,
    diagnosticCapture: DiagnosticCapture,
  ): Promise<void> {
    const coordinator = coordinatorRef.current;
    if (!coordinator) throw new Error("Run coordinator is unavailable.");
    try {
      const stream = await inferenceTransport.executeTurn(
        { execution, credential },
        controller.signal,
      );
      recordDiagnostic(diagnosticCapture, "client.response_received", {
        status: stream.status,
        headers: Object.fromEntries(stream.headers),
      });
      for await (const event of stream.events) {
        recordDiagnostic(diagnosticCapture, "client.ndjson_record_received", {
          raw: JSON.stringify(redactDiagnosticValue(event)),
          event,
        });
        if (requestGenerationRef.current !== requestGeneration) continue;
        coordinator.accept(event);
        replaceRunState(coordinator.state);
      }
      if (requestGenerationRef.current !== requestGeneration) return;
      coordinator.finishTurnStream();
      replaceRunState(coordinator.state);
      prepareToolResultDrafts(coordinator.state);
    } catch (error) {
      if (
        controller.signal.aborted ||
        requestGenerationRef.current !== requestGeneration
      ) {
        throw error;
      }
      const status =
        error instanceof InferenceTransportError ? error.status : undefined;
      const retryable =
        !(error instanceof SyntaxError) &&
        (status === undefined ||
          status === 408 ||
          status === 429 ||
          (status >= 500 && status <= 599));
      coordinator.accept({
        type: "failed",
        error: {
          code: error instanceof SyntaxError ? "protocol_error" : "transport_error",
          message: error instanceof Error ? error.message : "Request failed.",
          retryable,
        },
      });
      replaceRunState(coordinator.state);
    }
  }

  async function run() {
    project.clearErrorKind();
    if (projectFile && !mappedProfileId) {
      project.setError(
        "Map this project's connection to a local profile before running.",
      );
      return;
    }
    let selectedTools: ToolDefinition[];
    try {
      selectedTools = [...resolvedTools(), ...requestTools];
      const names = new Set<string>();
      selectedTools.forEach((tool) => {
        if (!tool.name.trim()) {
          throw new Error("Every attached tool needs a name.");
        }
        if (names.has(tool.name)) {
          throw new Error(`More than one attached tool is named "${tool.name}".`);
        }
        names.add(tool.name);
      });
      if (selectedTools.length > 0 && !activeCapabilities.tools) {
        project.setToolsDisabledError(
          `This request includes ${selectedTools.length} selected ${
            selectedTools.length === 1 ? "tool" : "tools"
          }, but profile "${activeProfile.name || "Untitled profile"}" does not allow tool calling.`,
        );
        return;
      }
    } catch (error) {
      project.setError(error instanceof Error ? error.message : "Tools are invalid.");
      return;
    }
    let request = currentRequest();
    let projectForRun = projectFile;
    let identity: RunConversationIdentity;
    let branchedFrom: RunTrace["branchedFrom"];
    if (branchContext) {
      if (projectFile) {
        if (!branchContext.parentConversationRevisionId) {
          project.setError("This branch context is missing its parent revision. Start the branch again from its source run.");
          return;
        }
        try {
          const parent = projectFile.conversationRevisions.find(
            ({ id }) => id === branchContext.parentConversationRevisionId,
          );
          if (!parent) throw new Error("The parent revision is no longer in this project.");
          const branchedProject = createBranchRevision(projectFile, {
            conversationId: parent.conversationId,
            parentRevisionId: parent.id,
            messages: request.messages,
            runOverrides: templateRunOverrides,
          });
          const revision = branchedProject.conversationRevisions.at(-1)!;
          project.adoptBranchRevision(branchedProject);
          projectForRun = branchedProject;
          identity = {
            conversationId: revision.conversationId,
            conversationRevisionId: revision.id,
          };
        } catch (error) {
          project.setError(error instanceof Error ? error.message : "Could not create the branch revision.");
          return;
        }
      } else {
        identity = currentRunIdentity();
      }
      branchedFrom = {
        runId: branchContext.parentRunId,
        parentConversationRevisionId: branchContext.parentConversationRevisionId,
        messageId: branchContext.branchMessageId,
      };
      setBranchContext(null);
    } else {
      identity = currentRunIdentity();
    }
    let templateResolutions: ResolvedTemplateUse[] = [];
    if (
      projectForRun &&
      identity.conversationRevisionId ===
        projectForRun.defaults.conversationRevisionId
    ) {
      const revision = projectForRun.conversationRevisions.find(
        ({ id }) => id === identity.conversationRevisionId,
      );
      if (!revision) {
        project.setError("The active project conversation revision no longer exists.");
        return;
      }
      const prepared = prepareProjectRevisionRun(
        projectForRun,
        revision,
        templateRunOverrides,
      );
      if (!prepared.ok) {
        project.setError(templateRunErrorMessage(prepared.diagnostics));
        return;
      }
      const hasTemplateUses = revision.items.some(
        (item) => item.kind === "template-use",
      );
      if (
        hasTemplateUses &&
        !sameConversationMessages(request.messages, prepared.messages)
      ) {
        project.setError(
          "This template-backed conversation differs from its generated messages. Detach the template use before editing generated text.",
        );
        return;
      }
      if (hasTemplateUses) {
        request = { ...request, messages: prepared.messages };
      }
      templateResolutions = prepared.templateResolutions;
    }
    const input = createResolvedRunInput(
      request,
      identity,
      selectedTools,
      templateResolutions,
    );
    if (projectForRun) {
      executedRevisionIdsRef.current.add(identity.conversationRevisionId);
    }
    input.target.profileId = createEntityId("profile", activeProfile.id);
    const coordinator = new RunCoordinator(input);
    parentTraceGenerationRef.current += 1;
    setParentTrace({ status: "idle" });
    if (branchedFrom) runBranchProvenanceRef.current.set(input.runId, branchedFrom);
    setVisibleBranchProvenance(branchedFrom);
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
  }

  async function continueRun(): Promise<void> {
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
  }

  async function retryRun(): Promise<void> {
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
  }

  function stop() {
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
  }

  function downloadDiagnostics() {
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

  /**
   * Replaces the workbench with a trace the user is inspecting rather than
   * running. Importing a file and opening a project's saved run differ only in
   * where the trace came from and how it is stored, so both go through here:
   * the live coordinator is dropped, drafts and diagnostics from the previous
   * run are cleared, and the response view is brought forward.
   *
   * `origin.workspace` is the folder the trace already lives in, or null for a
   * trace that has no home on disk. Naming it here is what keeps the autosave
   * effect from writing an artifact back over the file it was just read from.
   */
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

  /**
   * Reads the selected artifact again instead of trusting a copy held from
   * when the list was built. Errors propagate to the drawer, which keeps the
   * list on screen so another run can be chosen.
   */
  async function openHistoryTrace(item: ProjectRunHistoryItem): Promise<void> {
    const workspace = projectWorkspace;
    if (!workspace) throw new Error("The project folder is no longer open.");
    const trace = await runHistory.readTrace(item.fileName);
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

  const runReachedTerminalStatus = Boolean(
    runState &&
      ["completed", "cancelled", "failed"].includes(runState.status.kind),
  );
  const requestPreview = templateRequestPreview();
  const composerItems = templateWorkbench.composerItems;
  const readiness = runReadiness({
    projectOpen: Boolean(projectFile),
    connectionMapped: Boolean(mappedProfileId),
    activeProfileName: activeProfile.name,
    activeProfileEndpoint: activeProfile.endpoint,
    activeProfileModel: activeModel,
    selectedToolCount,
    toolsEnabled: activeCapabilities.tools,
    ...(activeConnectionRequirement
      ? {
          requiredEndpoint: activeConnectionRequirement.endpoint,
          activeConnectionRequirementId: activeConnectionRequirement.id,
        }
      : {}),
    ...(templateWorkbench.resolutionError
      ? { templateResolutionError: templateWorkbench.resolutionError }
      : {}),
    templateIssues:
      activeProjectResolution?.diagnostics.map(
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
    else if (kind === "review-tools") setRequestTab("tools");
    else if (kind === "edit-template") setRequestTab("templates");
    else setRequestTab("messages");
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
        onDownloadRunTrace={() => void exportRunTrace()}
        onImportRunTrace={(event) => void importRunTrace(event)}
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
      {(serverDefaultProfileNotice || originNotice.notice || importNotice) && (
        <div className="workbench-notices">
          {importNotice && (
            <div className="workbench-notice" role="status">
              <div className="workbench-notice-copy">
                <strong>
                  Imported &ldquo;{importNotice.name}&rdquo;{importNotice.template ? " as a reusable template" : ""}
                </strong>
                <span>
                  {importNotice.template
                    ? `${importNotice.variableCount} ${importNotice.variableCount === 1 ? "variable was" : "variables were"} carried over from the saved execution.`
                    : "The saved execution messages are now in the composer."}
                </span>
              </div>
              <div className="workbench-notice-actions">
                {importNotice.template && (
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => {
                      setRequestTab("templates");
                      setImportNotice(undefined);
                    }}
                  >
                    View template
                  </button>
                )}
                <button
                  className="button"
                  type="button"
                  onClick={() => setImportNotice(undefined)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
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
        <section className="composer">
          <div className="panel-header request-header">
            <div>
              <span className="eyebrow">Request</span>
              <h2>Composer</h2>
            </div>
            <PaneTabs
              label="Request editor"
              value={requestTab}
              onChange={(value) =>
                setRequestTab(value as "messages" | "templates" | "tools")
              }
              tabs={[
                { id: "messages", label: "Messages", count: messages.length },
                {
                  id: "templates",
                  label: "Templates",
                  count: projectFile?.promptTemplates.length ?? 0,
                },
                // The badge counts what will be sent, not what is defined, so
                // it agrees with the manifest inside the tab.
                { id: "tools", label: "Tools", count: selectedToolCount },
              ]}
            />
            {requestTab === "messages" ? (
              <button
                className="text-button header-text-action"
                onClick={addComposerMessage}
              >
                + Add message
              </button>
            ) : requestTab === "tools" ? (
              <button
                className="text-button header-text-action"
                type="button"
                onClick={addTool}
              >
                + Add tool
              </button>
            ) : null}
          </div>
          <RunReadinessNotice
            {...(readiness ? { readiness } : {})}
            onAction={resolveReadiness}
          />
          {branchContext && (
            <div className="branch-pending" role="status">
              Branching from run <code>{branchContext.parentRunId}</code> at message <code>{branchContext.branchMessageId}</code> — the original trace is untouched.
              {branchContext.parentTraceNeedsSaving && (
                <button className="button secondary" type="button" onClick={() => void exportRunTrace()}>Save trace…</button>
              )}
              <button className="button secondary" type="button" onClick={() => setBranchContext(null)}>Discard branch</button>
            </div>
          )}

          <div className="pane-scroll request-content">
          {requestTab === "messages" ? (
            <>
          <section className="run-settings" aria-label="Run settings">
            <div className="run-settings-heading">
              <span>
                <strong>Run settings</strong>
                <small>
                  {projectFile ? "Project override" : "Profile default"}
                </small>
              </span>
              <button
                className="text-button"
                type="button"
                onClick={() => setConnectionDrawerOpen(true)}
              >
                Connection settings
              </button>
            </div>
            {/* The Tools tab owns the full manifest; this line only says
                enough to notice that something needs attention there. */}
            <p
              className={
                selectedToolCount > 0 && !activeCapabilities.tools
                  ? "request-tool-line blocked"
                  : "request-tool-line"
              }
              role="status"
            >
              <span>
                {selectedToolCount === 0
                  ? "No tools sent with this request."
                  : !activeCapabilities.tools
                    ? `${selectedToolCount} ${
                        selectedToolCount === 1 ? "tool is" : "tools are"
                      } selected, but this profile does not allow tool calling.`
                    : requestTools.length > 0
                      ? `${selectedToolCount} ${
                          selectedToolCount === 1 ? "tool" : "tools"
                        } sent, ${requestTools.length} only once.`
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
                onChange={setEditorModel}
                discovery={activeModelDiscovery}
                onLoadModels={(force) => void loadModels(force)}
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
                    onChange={(event) =>
                      setEditorTemperature(Number(event.target.value))
                    }
                  />
                  <output>{activeTemperature.toFixed(1)}</output>
                </div>
              </label>
              <label
                className={
                  activeCapabilities.streaming
                    ? "streaming-control"
                    : "streaming-control disabled"
                }
                title={
                  activeCapabilities.streaming
                    ? undefined
                    : "This profile does not support streaming responses."
                }
              >
                <input
                  type="checkbox"
                  checked={activeResponseMode === "streaming"}
                  disabled={!activeCapabilities.streaming}
                  onChange={(event) =>
                    setStreamingPreferred(event.target.checked)
                  }
                />
                <span>
                  Stream response
                  <small>
                    {activeCapabilities.streaming
                      ? "Show output as the provider sends it."
                      : "Unavailable for this profile; responses are buffered."}
                  </small>
                </span>
              </label>
            </div>
          </section>
          <div className="message-list">
            {composerItems.map((item, index) => {
              if (item.kind === "template-use") {
                const template = projectFile?.promptTemplates.find(
                  ({ id }) => id === item.use.templateId,
                );
                if (!template) return null;
                return (
                  <TemplateUseCard
                    key={item.use.id}
                    use={item.use}
                    template={template}
                    diagnostics={
                      activeProjectResolution?.diagnostics.filter(
                        ({ templateUseId }) => templateUseId === item.use.id,
                      ) ?? []
                    }
                    runOverrides={templateRunOverrides[item.use.id] ?? {}}
                    importedFrom={projectFile?.externalImports.find(
                      (receipt) =>
                        receipt.projection.kind === "prompt-template" &&
                        receipt.projection.templateRevisionId === item.use.templateRevisionId,
                    )}
                    onSaveValues={(values) =>
                      updateTemplateUseValues(item.use.id, values)
                    }
                    onSaveRunValue={(values, runOverrides) =>
                      saveTemplateUseRunValue(
                        item.use.id,
                        values,
                        runOverrides,
                      )
                    }
                    onRunOverridesChange={(values) =>
                      updateTemplateUseOverride(item.use.id, values)
                    }
                    onUpdateLatest={() =>
                      updateTemplateUseToLatestRevision(item.use.id)
                    }
                    onDetach={() => detachTemplateUseFromProject(item.use.id)}
                    onRemove={() => removeTemplateUseFromProject(item.use.id)}
                  />
                );
              }
              const message = item.message;
              const importReceipt = item.externalImportId
                ? projectFile?.externalImports.find(
                    ({ id }) => id === item.externalImportId,
                  )
                : undefined;
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
                      updateComposerMessage(message.id, {
                        role: event.target.value as ConversationMessage["role"],
                      })
                    }
                  >
                    <option value="system">System</option>
                    <option value="user">User</option>
                    <option value="assistant">Assistant</option>
                    <option value="tool">Tool</option>
                  </select>
                  {importReceipt && (
                    <span
                      className="message-import-provenance"
                      title={`Imported from ${importReceipt.source.adapter} execution ${importReceipt.source.execution?.id ?? "unavailable"} with ${importReceipt.fidelity.replaceAll("-", " ")} fidelity.`}
                    >
                      Imported from {importReceipt.source.adapter}
                      {" · "}
                      {importReceipt.fidelity.replaceAll("-", " ")}
                    </span>
                  )}
                  <button
                    aria-label={`Remove message ${index + 1}`}
                    className="remove-button"
                    onClick={() => removeComposerMessage(message.id)}
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  aria-label={`Message ${index + 1} content`}
                  value={text}
                  onChange={(event) =>
                    updateComposerMessage(message.id, {
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
                {message.role === "assistant" && message.toolCalls?.map((call) => (
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
            <details className="request-preview">
              <summary>Resolved request preview</summary>
              {"error" in requestPreview ? (
                <div className="template-diagnostic">{requestPreview.error}</div>
              ) : (
                <>
                  {(activeProjectResolution?.diagnostics.length ?? 0) > 0 && (
                    <div className="template-warning" role="status">
                      Preview contains unresolved variables. Running is blocked until they have values.
                    </div>
                  )}
                  <h3>Resolved messages</h3>
                  <div className="request-preview-messages">
                    {requestPreview.messages.map((message, index) => (
                      <article className="request-preview-message" key={`${message.role}-${index}`}>
                        <span className="eyebrow">{message.role}</span>
                        <pre>{conversationMessageText(message)}</pre>
                      </article>
                    ))}
                  </div>
                  <details className="request-preview-raw">
                    <summary>Raw OpenAI-compatible request body</summary>
                    <pre>{JSON.stringify(requestPreview.body, null, 2)}</pre>
                  </details>
                </>
              )}
            </details>
          )}
            </>
          ) : requestTab === "templates" ? (
            <ProjectTemplatesPane
              key={projectFile?.projectId ?? "unsaved-project"}
              templates={projectFile?.promptTemplates ?? []}
              connectionRequirements={projectFile?.connectionRequirements ?? []}
              defaultConnectionRequirementId={
                projectFile?.defaults.target.connectionRequirementId
              }
              usageCounts={templateUsageCounts}
              itemCount={activeProjectRevision?.items.length ?? messages.length}
              onCreate={createProjectTemplate}
              onSave={saveProjectTemplate}
              onInsert={insertProjectTemplate}
            />
          ) : (
            <ToolsPane
              tools={tools}
              requestTools={requestTools}
              enabledToolIds={enabledToolIds}
              activeProfileName={activeProfile.name}
              toolsEnabled={activeCapabilities.tools}
              onOpenLibrary={() => setToolRegistryOpen(true)}
              onOpenConnectionSettings={() => setConnectionDrawerOpen(true)}
              onAddTool={addTool}
              onRemoveTool={removeTool}
              onUpdateTool={updateTool}
              onSetToolEnabled={setToolEnabled}
              mockForTool={mockForTool}
              onUpdateToolMock={updateToolMock}
              onRemoveRequestTool={removeRequestTool}
            />
          )}
          </div>
        </section>
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
            onToolResultDraftChange={(callId, text) =>
              setToolResultDrafts((current) => ({
                ...current,
                [callId]: { ...current[callId]!, text },
              }))
            }
            onContinue={() => void continueRun()}
            onRetry={() => void retryRun()}
            onSaveTrace={() => void exportRunTrace()}
            onEditFromHere={editFromHere}
          />

          <RunTracePanel
            open={traceOpen}
            runState={runState}
            branchedFrom={visibleBranchProvenance}
            parentTrace={parentTrace}
            onLoadParentTrace={() => void loadParentTrace()}
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
            ...(activeConnectionRequirement
              ? { connectionRequirementName: activeConnectionRequirement.name }
              : {}),
            projectModel: activeModel,
          }}
          onImport={importN8nPrompt}
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
