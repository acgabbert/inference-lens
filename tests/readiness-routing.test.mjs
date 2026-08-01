import assert from "node:assert/strict";
import test, { after } from "node:test";

import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});

after(() => dom.window.close());

async function render(modulePath, component, props) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  const [{ createElement }, { createRoot }, { act }, module] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("react"),
    server.ssrLoadModule(modulePath),
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(module[component], props)));
  return {
    container,
    async close() {
      await act(async () => root.unmount());
      container.remove();
      await server.close();
    },
  };
}

const capabilities = {
  chatCompletions: true, responsesApi: false, streaming: true,
  modelDiscovery: true, tools: false, parallelToolCalls: false,
  structuredOutput: false, vision: false, embeddings: false,
};

function drawerProps(onDestinationHandled) {
  const activeProfile = {
    id: "local", name: "Local", provider: "openai-compatible",
    endpoint: "", model: "fixture-model",
  };
  return {
    open: true, onClose() {}, profiles: [activeProfile], activeProfile,
    capabilities, credential: {
      draft: "", status: { canPersist: false, isApprovedForEndpoint: false },
      webMode: "none", setDraft() {}, setWebMode() {}, commit() {},
    },
    serverDefault: { loaded: true, containerized: false, configured: false },
    isDesktopRuntime: false, onSelectProfile() {}, onAddProfile() {},
    onDeleteProfile() {}, onUpdateProfile() {}, onCapabilityChange() {},
    onMapProfile() {}, onDestinationHandled,
  };
}

function composerProps(pendingDestination, onDestinationHandled) {
  const noop = () => {};
  return {
    requestDraft: {
      messages: [{ id: "message_1", role: "user", content: [{ type: "text", text: "Hi" }] }],
      tools: [], requestTools: [], enabledToolIds: [], addTool: noop, removeTool: noop,
      updateTool: noop, setToolEnabled: noop, mockForTool: () => undefined,
      updateToolMock: noop, removeRequestTool: noop,
    },
    templates: {
      templateWorkbench: { composerItems: [{ kind: "message", message: { id: "message_1", role: "user", content: [{ type: "text", text: "Hi" }] } }] },
      templateRunOverrides: {}, templateUsageCounts: new Map(), addComposerMessage: noop,
      updateComposerMessage: noop, removeComposerMessage: noop, updateTemplateUseValues: noop,
      saveTemplateUseRunValue: noop, updateTemplateUseOverride: noop,
      updateTemplateUseToLatestRevision: noop, detachTemplateUse: noop, removeTemplateUse: noop,
      createProjectTemplate: noop, saveProjectTemplate: noop, insertProjectTemplate: noop,
      clearImportNotice: noop,
    },
    project: null,
    settings: {
      model: "fixture-model", temperature: 0.7, responseMode: "buffered",
      streamingAvailable: true, toolsEnabled: true, modelDiscovery: null,
      onModelChange: noop, onTemperatureChange: noop,
      onStreamingPreferenceChange: noop, onLoadModels: noop,
    },
    activeProfile: { name: "Fixture" }, pendingDestination, onDestinationHandled,
    onReadinessAction: noop, onOpenConnectionSettings: noop, onOpenToolLibrary: noop,
    onSaveParentTrace: noop, onDiscardPendingBranch: noop,
  };
}

test("the connection owner focuses the requested endpoint", async () => {
  let acknowledgements = 0;
  const view = await render("/app/connection-drawer.client.tsx", "ConnectionDrawer", {
    ...drawerProps(() => { acknowledgements += 1; }),
    pendingDestination: { surface: "connections", control: "endpoint" },
  });
  try {
    assert.equal(document.activeElement?.getAttribute("data-readiness-control"), "endpoint");
    assert.equal(acknowledgements, 1);
  } finally {
    await view.close();
  }
});

test("the connection owner focuses the project mapping control", async () => {
  let acknowledgements = 0;
  const view = await render("/app/connection-drawer.client.tsx", "ConnectionDrawer", {
    ...drawerProps(() => { acknowledgements += 1; }),
    connectionRequirement: { id: "connection_1", name: "Fixture", endpoint: "http://localhost/v1" },
    pendingDestination: { surface: "connections", control: "project-mapping" },
  });
  try {
    assert.equal(document.activeElement?.getAttribute("data-readiness-control"), "project-mapping");
    assert.equal(acknowledgements, 1);
  } finally {
    await view.close();
  }
});

test("the connection owner focuses the tools capability control", async () => {
  let acknowledgements = 0;
  const view = await render("/app/connection-drawer.client.tsx", "ConnectionDrawer", {
    ...drawerProps(() => { acknowledgements += 1; }),
    pendingDestination: { surface: "connections", control: "tools-capability" },
  });
  try {
    const focusedControl = document.activeElement;
    assert.equal(focusedControl?.getAttribute("data-readiness-control"), "tools-capability");
    assert.match(focusedControl?.closest("label")?.textContent ?? "", /Allow tool calling/);
    assert.equal(acknowledgements, 1);
  } finally {
    await view.close();
  }
});

test("the request owner selects Messages and focuses the model picker", async () => {
  let acknowledgements = 0;
  const view = await render("/app/request/request-composer.client.tsx", "RequestComposer", composerProps(
    { surface: "request", tab: "messages", control: "model" },
    () => { acknowledgements += 1; },
  ));
  try {
    assert.equal(document.activeElement?.getAttribute("data-readiness-control"), "model");
    assert.equal(acknowledgements, 1);
  } finally {
    await view.close();
  }
});

test("the request owner selects Tools and focuses the selected-tools manifest", async () => {
  let acknowledgements = 0;
  const view = await render("/app/request/request-composer.client.tsx", "RequestComposer", composerProps(
    { surface: "request", tab: "tools", control: "tool-manifest" },
    () => { acknowledgements += 1; },
 ));
  try {
    assert.equal(document.activeElement?.getAttribute("data-readiness-target"), "tool-manifest");
    assert.equal(acknowledgements, 1);
  } finally {
    await view.close();
  }
});

test("the request owner focuses the named unresolved template variable", async () => {
  let acknowledgements = 0;
  const destination = {
    surface: "request", tab: "messages", control: "template-variable",
    entityId: "template-use_1", fieldName: "topic",
  };
  const props = composerProps(destination, () => { acknowledgements += 1; });
  props.project = {
    projectId: "project_1",
    promptTemplates: [{
      id: "template_1", name: "Topic prompt", currentRevisionId: "template-revision_1",
      revisions: [{
        id: "template-revision_1", content: { kind: "fragment", text: "Tell me about {{topic}}." },
        variableDefaults: {},
      }],
    }],
    connectionRequirements: [], defaults: { target: {} }, externalImports: [],
  };
  props.templates.templateWorkbench = {
    composerItems: [{
      kind: "template-use",
      use: { id: "template-use_1", templateId: "template_1", templateRevisionId: "template-revision_1", values: {} },
    }],
    resolution: { diagnostics: [{
      templateUseId: "template-use_1",
      diagnostic: { code: "missing-template-variable", name: "topic", message: "topic needs a value" },
    }] },
  };
  const view = await render("/app/request/request-composer.client.tsx", "RequestComposer", props);
  try {
    assert.equal(document.activeElement?.getAttribute("data-template-variable"), "topic");
    assert.equal(acknowledgements, 1);
  } finally {
    await view.close();
  }
});
