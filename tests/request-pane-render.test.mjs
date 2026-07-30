import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

async function render(modulePath, component, props) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    logLevel: "warn",
  });
  try {
    const [module, { renderToStaticMarkup }, { createElement }] =
      await Promise.all([
        server.ssrLoadModule(modulePath),
        import("react-dom/server"),
        import("react"),
      ]);
    return renderToStaticMarkup(createElement(module[component], props));
  } finally {
    await server.close();
  }
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
      onModelChange: noop,
      onTemperatureChange: noop,
      onStreamingPreferenceChange: noop,
      onLoadModels: noop,
    },
    onReadinessAction: noop,
    activeProfile: { name: "Fixture profile" },
    onOpenConnectionSettings: noop,
    onOpenToolLibrary: noop,
    onSaveParentTrace: noop,
    onDiscardPendingBranch: noop,
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
  assert.match(html, /Profile default/);
  assert.match(html, /Composer fixture message/);
  assert.match(html, /Stream response/);
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

test("the tool manifest lists both routes to a request in one place", async () => {
  const html = await render("/app/tools-pane.client.tsx", "ToolsPane", toolsPane({
    tools: [projectTool],
    enabledToolIds: ["tool_lookup"],
    requestTools: [oneShotTool],
  }));

  assert.match(html, /2 tools will be sent/);
  assert.match(html, /lookup_order/);
  assert.match(html, /scratch_pad/);
  assert.match(html, /tool-origin project/);
  assert.match(html, /tool-origin once/);
});

test("an unselected project tool is counted out of the manifest", async () => {
  const html = await render("/app/tools-pane.client.tsx", "ToolsPane", toolsPane({
    tools: [projectTool],
    enabledToolIds: [],
  }));

  assert.match(html, /No tools will be sent/);
  assert.doesNotMatch(html, /tool-origin project/);
  // The definition itself is still editable below the manifest.
  assert.match(html, /Send with requests/);
});

test("a profile that cannot call tools says so where the tools are listed", async () => {
  const html = await render("/app/tools-pane.client.tsx", "ToolsPane", toolsPane({
    tools: [projectTool],
    enabledToolIds: ["tool_lookup"],
    toolsEnabled: false,
  }));

  assert.match(html, /tool-manifest blocked/);
  assert.match(html, /1 tool is selected/);
  assert.doesNotMatch(html, /1 tool will be sent/);
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
  assert.match(html, /not connected to a local profile/);
  assert.match(html, /https:\/\/api\.openai\.com\/v1/);
  assert.match(html, /http:\/\/127\.0\.0\.1:8080\/v1/);
  assert.match(html, /Use &quot;Local llama&quot;/);
  // The rule behind the block is held in a disclosure, not in the first line.
  assert.match(html, /<details class="run-readiness-why"/);
  assert.match(html, /A project never carries a credential\./);
});

test("a notice without an explanation renders no disclosure", async () => {
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

  assert.doesNotMatch(html, /run-readiness-why/);
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
