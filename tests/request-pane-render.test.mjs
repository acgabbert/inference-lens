import assert from "node:assert/strict";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

async function render(modulePath, component, props) {
  const [module, { renderToStaticMarkup }, { createElement }] =
    await Promise.all([
      ssrLoadModule(modulePath),
      import("react-dom/server"),
      import("react"),
    ]);
  return renderToStaticMarkup(createElement(module[component], props));
}

function toolsPane(overrides) {
  return {
    tools: [],
    requestTools: [],
    enabledToolIds: [],
    activeProfileName: "Local llama",
    toolsEnabled: true,
    onOpenLibrary: () => {},
    onOpenConnectionSettings: () => {},
    onAddTool: () => {},
    onRemoveTool: () => {},
    onUpdateTool: () => {},
    onSetToolEnabled: () => {},
    mockForTool: () => undefined,
    onUpdateToolMock: () => {},
    onRemoveRequestTool: () => {},
    commandTools: {
      availability: { kind: "unconfigured", variable: "INFERENCE_LENS_COMMAND_TOOLS" },
      commands: [],
      grantFor: () => undefined,
      bindingFor: () => undefined,
      grant() {},
      revoke() {},
    },
    ...overrides,
  };
}

const projectTool = {
  id: "tool_lookup",
  name: "lookup_order",
  description: "Find an order by id",
  inputSchema: { type: "object", properties: {} },
};

const oneShotTool = {
  id: "tool_scratch",
  name: "scratch_pad",
  description: "",
  inputSchema: { type: "object", properties: {} },
};

function requestComposer(overrides = {}) {
  const noop = () => {};
  return {
    requestDraft: {
      messages: [{
        id: "message_1",
        role: "user",
        content: [{ type: "text", text: "Composer fixture message" }],
      }],
      tools: [],
      requestTools: [],
      enabledToolIds: [],
      addTool: noop,
      removeTool: noop,
      updateTool: noop,
      setToolEnabled: noop,
      mockForTool: () => undefined,
      updateToolMock: noop,
      removeRequestTool: noop,
    },
    commandTools: {
      availability: { kind: "unconfigured", variable: "INFERENCE_LENS_COMMAND_TOOLS" },
      commands: [],
      grantFor: () => undefined,
      bindingFor: () => undefined,
      grant() {},
      revoke() {},
    },
    templates: {
      templateWorkbench: { composerItems: [{ kind: "message", message: {
        id: "message_1", role: "user", content: [{ type: "text", text: "Composer fixture message" }],
      } }] },
      templateRunOverrides: {},
      templateUsageCounts: new Map(),
      activeProjectRevision: undefined,
      addComposerMessage: noop,
      updateComposerMessage: noop,
      removeComposerMessage: noop,
      updateTemplateUseValues: noop,
      saveTemplateUseRunValue: noop,
      updateTemplateUseOverride: noop,
      updateTemplateUseToLatestRevision: noop,
      detachTemplateUse: noop,
      removeTemplateUse: noop,
      createProjectTemplate: noop,
      saveProjectTemplate: noop,
      insertProjectTemplate: noop,
      clearImportNotice: noop,
    },
    project: null,
    settings: {
      model: "fixture-model",
      temperature: 0.7,
      responseMode: "buffered",
      streamingAvailable: true,
      toolsEnabled: true,
      modelDiscovery: null,
      favoriteModels: [],
      onModelChange: noop,
      onTemperatureChange: noop,
      onStreamingPreferenceChange: noop,
      onLoadModels: noop,
      onToggleFavoriteModel: noop,
    },
    onReadinessAction: noop,
    repeat: { disabled: false, onRepeat: noop },
    activeProfile: { name: "Fixture profile" },
    onOpenConnectionSettings: noop,
    onOpenToolLibrary: noop,
    onSaveParentTrace: noop,
    onDiscardPendingBranch: noop,
    onDestinationHandled: noop,
    ...overrides,
  };
}

test("the extracted composer renders request snapshots without a project", async () => {
  const html = await render(
    "/app/request/request-composer.client.tsx",
    "RequestComposer",
    requestComposer(),
  );

  assert.match(html, /Request editor/);
  // Evaluations are a mode, not a tab of the composer.
  assert.doesNotMatch(html, /Evaluations/);
  assert.match(html, /Profile default/);
  assert.match(html, /Composer fixture message/);
  assert.match(html, /Open request composer in focus mode/);
  // The settings panel starts collapsed: every value it will send is named,
  // delivery included, and none of the controls are rendered.
  assert.match(html, /fixture-model/);
  assert.match(html, /Temp 0\.7/);
  assert.match(html, /Buffered/);
  assert.doesNotMatch(html, /Stream response/);
  assert.match(html, /class="request-settings-card"/);
  assert.doesNotMatch(html, /Override temperature/);
  // The tool line stays outside the panel, so a blocked tool selection cannot
  // be hidden by collapsing it.
  assert.match(html, /No tools attached to this request/);
});

test("the topbar hides ordinary run actions outside the Compose mode", async () => {
  const noop = () => {};
  const profile = { id: "fixture", name: "Fixture", endpoint: "https://example.test/v1", model: "fixture-model" };
  const html = await render("/app/topbar.client.tsx", "Topbar", {
    profiles: [profile], activeProfile: profile,
    hasCredential: false, projectDirty: false, folderAccessAvailable: false,
    hasDiagnosticCapture: false, hasRunTrace: false, hasProjectWorkspace: false,
    runHistoryBlocked: false, isRequestActive: false, isExperimentActive: false,
    mode: "evaluations", onModeChange: noop,
    awaitingToolResults: false, retryableFailure: false,
    runDisabled: false, evaluationStartDisabled: false,
    onChooseProfile: noop, onOpenConnections: noop, onNewProject: noop,
    onOpenProject: noop, onSaveProject: noop, onImportProject: noop,
    onExportProject: noop, onOpenN8nImport: noop, onDownloadDiagnostics: noop, onDownloadRunTrace: noop,
    onImportRunTrace: noop, onOpenRunHistory: noop, onStop: noop,
    onStopExperiment: noop, onRun: noop, onStartEvaluation: noop,
  });
  // One primary action, and it is this mode's own. Compose's run controls and
  // the lifecycle actions that used to crowd beside them are all gone.
  assert.match(html, /Start evaluation…/);
  assert.doesNotMatch(html, /Run request|Repeat…|Run new request|Continue run|Retry|Discard failed run/);
});

test("the topbar target control names the connection and states no model", async () => {
  const noop = () => {};
  const profile = { id: "fixture", name: "Server default", endpoint: "https://example.test/v1", model: "google/gemma-4-26b" };
  const html = await render("/app/topbar.client.tsx", "Topbar", {
    profiles: [profile], activeProfile: profile,
    hasCredential: true, projectDirty: false, folderAccessAvailable: false,
    hasDiagnosticCapture: false, hasRunTrace: false, hasProjectWorkspace: false,
    runHistoryBlocked: false, isRequestActive: false, isExperimentActive: false,
    mode: "evaluations", onModeChange: noop,
    awaitingToolResults: false, retryableFailure: false,
    runDisabled: false, evaluationStartDisabled: false,
    onChooseProfile: noop, onOpenConnections: noop, onNewProject: noop,
    onOpenProject: noop, onSaveProject: noop, onImportProject: noop,
    onExportProject: noop, onOpenN8nImport: noop, onDownloadDiagnostics: noop, onDownloadRunTrace: noop,
    onImportRunTrace: noop, onOpenRunHistory: noop, onStop: noop,
    onStopExperiment: noop, onRun: noop, onStartEvaluation: noop,
  });
  // The caption is what makes the profile name read as a chosen value, and the
  // credential dot's meaning is stated rather than left to colour alone.
  assert.match(html, /class="target-caption"[^>]*>Connection</);
  assert.match(html, /aria-label="Run target: Server default, credential set"/);
  // A model in the topbar would contradict the run this mode's primary action
  // starts: Evaluations resolves its model per configuration, never from here.
  assert.doesNotMatch(html, /gemma/);
});

test("the extracted composer keeps pending-branch and template-error text in the request pane", async () => {
  const html = await render(
    "/app/request/request-composer.client.tsx",
    "RequestComposer",
    requestComposer({
      readiness: {
        blocked: true,
        headline: "Template needs a value",
        detail: "Enter topic before running.",
        summary: "Enter topic.",
        facts: [],
        actions: [{ kind: "edit-template", label: "Edit template", primary: true }],
      },
      pendingBranch: {
        parentRunId: "run_parent",
        branchMessageId: "message_1",
        parentTraceNeedsSaving: true,
      },
      requestPreview: { error: "The template variable topic is missing." },
    }),
  );

  assert.match(html, /Template needs a value/);
  assert.match(html, /Branching from run/);
  assert.match(html, /Save trace/);
  assert.match(html, /The template variable topic is missing/);
});

test("the resolved request preview uses one disclosure without nesting details", async () => {
  const html = await render(
    "/app/request/request-composer.client.tsx",
    "RequestComposer",
    requestComposer({
      requestPreview: {
        messages: [{ role: "user", content: [{ type: "text", text: "Resolved fixture" }] }],
        body: { model: "fixture-model", messages: [{ role: "user", content: "Resolved fixture" }] },
      },
    }),
  );

  assert.match(html, /Resolved request preview/);
  assert.match(html, /role="tab"/);
  assert.match(html, />Raw</);
  assert.equal((html.match(/class="pane-tabs"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Raw OpenAI-compatible request body/);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
});

test("the tool manifest lists both routes to a request in one place", async () => {
  const html = await render("/app/tools-pane.client.tsx", "ToolsPane", toolsPane({
    tools: [projectTool],
    enabledToolIds: ["tool_lookup"],
    requestTools: [oneShotTool],
  }));

  assert.match(html, /2 tools attached/);
  assert.match(html, /lookup_order/);
  assert.match(html, /scratch_pad/);
  assert.match(html, /tool-origin project/);
  assert.match(html, /tool-origin once/);
  assert.equal((html.match(/>Detach</g) ?? []).length, 2);
  assert.match(html, /aria-label="Detach scratch_pad from the next request"/);
});

test("an unselected project tool is counted out of the manifest", async () => {
  const html = await render("/app/tools-pane.client.tsx", "ToolsPane", toolsPane({
    tools: [projectTool],
    enabledToolIds: [],
  }));

  assert.match(html, /No tools attached/);
  assert.doesNotMatch(html, /tool-origin project/);
  // The definition itself is still editable below the manifest.
  assert.match(html, /Attach to requests/);
});

test("a profile that cannot call tools says so where the tools are listed", async () => {
  const html = await render("/app/tools-pane.client.tsx", "ToolsPane", toolsPane({
    tools: [projectTool],
    enabledToolIds: ["tool_lookup"],
    toolsEnabled: false,
  }));

  assert.match(html, /tool-manifest blocked/);
  assert.match(html, /1 tool is attached/);
  assert.match(html, /does not allow tool calling/);
  assert.match(html, /Allow tool calling/);
});

test("a blocked run states its reason and its fix in the request pane", async () => {
  const html = await render(
    "/app/run-readiness-notice.client.tsx",
    "RunReadinessNotice",
    {
      readiness: {
        blocked: true,
        headline: "This project is not connected to a local profile yet",
        detail: "Choose the local profile it should run against.",
        explanation: "A project never carries a credential.",
        summary: "Map this project's connection to a local profile before running.",
        facts: [
          { label: "Project expects", value: "https://api.openai.com/v1" },
          { label: 'Profile "Local llama"', value: "http://127.0.0.1:8080/v1" },
        ],
        actions: [
          { kind: "map-profile", label: 'Use "Local llama"', primary: true },
          { kind: "open-connections", label: "Choose another profile" },
        ],
      },
      onAction: () => {},
    },
  );

  assert.match(html, /role="alert"/);
  // The reason is visible text and the fix is the inline action's own label.
  // Between them a blocked run is fully stated without hover, without a
  // keyboard trip into a disclosure, and without a pointer at all.
  assert.match(html, /1 blocker/);
  assert.match(html, /not connected to a local profile/);
  assert.match(html, /Use &quot;Local llama&quot;/);
  // Everything that explains rather than resolves is behind the disclosure,
  // which is what makes this a chip instead of the banner it replaced.
  assert.match(html, /aria-expanded="false"[^>]*>Details</);
  assert.doesNotMatch(html, /A project never carries a credential/);
  assert.doesNotMatch(html, /https:\/\/api\.openai\.com\/v1/);
  assert.doesNotMatch(html, /Choose another profile/);
});

test("an advisory reads as a note rather than a blocker", async () => {
  const html = await render(
    "/app/run-readiness-notice.client.tsx",
    "RunReadinessNotice",
    {
      readiness: {
        blocked: false,
        headline: "Running against a different endpoint",
        detail: "Requests go elsewhere.",
        summary: "",
        facts: [],
        actions: [],
      },
      onAction: () => {},
    },
  );

  // Not an alert, and counted in the word for something the user may ignore.
  assert.match(html, /role="status"/);
  assert.match(html, /1 note/);
  assert.match(html, /Running against a different endpoint/);
  assert.doesNotMatch(html, /blocker/);
});

test("nothing renders when the run is ready", async () => {
  const html = await render(
    "/app/run-readiness-notice.client.tsx",
    "RunReadinessNotice",
    { onAction: () => {} },
  );

  assert.equal(html, "");
});

function responseOutput(overrides) {
  return {
    output: "",
    reasoning: "",
    status: "complete",
    runState: { status: { kind: "completed" }, turns: [], toolResults: [] },
    isRequestActive: false,
    markdownPreview: true,
    outputFollowing: true,
    outputScrollRef: { current: null },
    completedToolCalls: [],
    toolResultDrafts: {},
    traceStorage: null,
    transcript: [],
    nonBranchableMessageIds: new Set(),
    onMarkdownPreviewChange: () => {},
    onOutputScroll: () => {},
    onJumpToLatest: () => {},
    onToolResultDraftChange: () => {},
    onContinue: () => {},
    onRetry: () => {},
    onSaveTrace: () => {},
    onEditFromHere: () => {},
    ...overrides,
  };
}

const finishedTranscript = [
  {
    message: {
      id: "message_system",
      role: "system",
      content: [{ type: "text", text: "You are a terse assistant." }],
    },
  },
  {
    message: {
      id: "message_user",
      role: "user",
      content: [{ type: "text", text: "Explain **caching**." }],
    },
  },
  {
    message: {
      id: "message_answer",
      role: "assistant",
      content: [
        { type: "text", text: "## Caching\n\nIt stores a `value` for reuse." },
      ],
    },
    reasoning: "The user wants a **short** definition of caching.",
  },
];

test("a finished turn keeps the rendering the streamed answer had", async () => {
  const html = await render(
    "/app/response-output.client.tsx",
    "ResponseOutput",
    responseOutput({ transcript: finishedTranscript }),
  );

  assert.match(html, /<h2>Caching<\/h2>/);
  assert.match(html, /<code class="markdown-inline-code">value<\/code>/);
  // Authored text is what was sent, so it is shown verbatim.
  assert.match(html, /Explain \*\*caching\*\*\./);
});

test("raw rendering leaves the finished answer verbatim", async () => {
  const html = await render(
    "/app/response-output.client.tsx",
    "ResponseOutput",
    responseOutput({ transcript: finishedTranscript, markdownPreview: false }),
  );

  assert.doesNotMatch(html, /<h2>Caching<\/h2>/);
  assert.match(html, /## Caching/);
});

test("system and user messages collapse by default, the answer stays open", async () => {
  const html = await render(
    "/app/response-output.client.tsx",
    "ResponseOutput",
    responseOutput({ transcript: finishedTranscript }),
  );

  // Collapsed messages show only a one-line preview, not their full body wrapper.
  assert.match(html, /class="transcript-preview"[^>]*>You are a terse assistant\./);
  assert.match(html, /class="transcript-preview"[^>]*>Explain \*\*caching\*\*\./);
  assert.doesNotMatch(html, /class="transcript-body" id="message_system-body"/);
  assert.doesNotMatch(html, /class="transcript-body" id="message_user-body"/);
  // The assistant answer starts expanded.
  assert.match(html, /<h2>Caching<\/h2>/);
  assert.match(html, /class="transcript-body" id="message_answer-body"/);

  // The whole header row is the disclosure control (role="button"), with its
  // accessible name and expanded state on the same element. Collapsed rows
  // control nothing that exists in the DOM, so aria-controls is only present
  // once a message is open (see message_answer below).
  function headerTag(label) {
    const labelIndex = html.indexOf(`aria-label="${label}"`);
    const tagStart = html.lastIndexOf('<div class="transcript-message-header"', labelIndex);
    return html.slice(tagStart, html.indexOf(">", labelIndex));
  }
  assert.match(headerTag("Expand system message"), /aria-expanded="false"/);
  assert.match(headerTag("Expand user message"), /aria-expanded="false"/);
  assert.match(headerTag("Collapse assistant message"), /aria-expanded="true"/);
  assert.match(headerTag("Collapse assistant message"), /aria-controls="message_answer-body"/);
  assert.doesNotMatch(headerTag("Expand system message"), /aria-controls=/);
  assert.doesNotMatch(headerTag("Expand user message"), /aria-controls=/);
});

test("a finished assistant message carries its turn's reasoning in a closed disclosure", async () => {
  const html = await render(
    "/app/response-output.client.tsx",
    "ResponseOutput",
    responseOutput({ transcript: finishedTranscript }),
  );

  assert.match(html, /<details class="reasoning-stream transcript-reasoning">/);
  // Reasoning renders as markdown under the Markdown tab, same as the answer.
  assert.match(html, /reasoning-stream transcript-reasoning">[\s\S]*?<strong>short<\/strong>/);
});

test("raw rendering shows the finished reasoning verbatim", async () => {
  const html = await render(
    "/app/response-output.client.tsx",
    "ResponseOutput",
    responseOutput({ transcript: finishedTranscript, markdownPreview: false }),
  );

  assert.match(html, /The user wants a \*\*short\*\* definition of caching\./);
});
