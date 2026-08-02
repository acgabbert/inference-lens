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
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});

after(() => dom.window.close());

const message = {
  id: "message_1",
  role: "user",
  content: [{ type: "text", text: "Composer fixture message" }],
};

function composerProps(overrides = {}) {
  const noop = () => {};
  return {
    requestDraft: {
      messages: [message],
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
      templateWorkbench: { composerItems: [{ kind: "message", message }] },
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
    evaluations: {
      project: null, selectedCaseIds: new Set(), repetitions: 1, candidates: [], diagnostics: [],
      selectSuite: noop, selectRevision: noop, setCaseSelected: noop, focusCase: noop,
      setRepetitions: noop, createSuite: noop, renameSuite: noop, deleteSuite: noop,
      addInput: noop, renameInput: noop, deleteInput: noop, addCase: noop,
      updateCase: noop, deleteCase: noop, addCheck: noop, updateCheck: noop, deleteCheck: noop,
    },
    evaluationExecution: { storage: "unsaved", running: false, onStart: noop },
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
    onDestinationHandled: noop,
    activeProfile: { name: "Fixture profile" },
    onOpenConnectionSettings: noop,
    onOpenN8nImport: noop,
    onOpenToolLibrary: noop,
    onSaveParentTrace: noop,
    onDiscardPendingBranch: noop,
    onActionContextChange: noop,
    ...overrides,
  };
}

test("reports evaluation action context when that tab owns the composer", async () => {
  const contexts = [];
  const view = await mount({ onActionContextChange: (context) => contexts.push(context) });
  try {
    assert.equal(contexts.at(-1), "ordinary");
    await view.click(view.tab("Evaluations"));
    assert.equal(contexts.at(-1), "evaluation");
    await view.click(view.tab("Messages"));
    assert.equal(contexts.at(-1), "ordinary");
  } finally {
    await view.close();
  }
});

async function mount(overrides = {}) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  const [{ createElement, act }, { createRoot }, { RequestComposer }] =
    await Promise.all([
      import("react"),
      import("react-dom/client"),
      server.ssrLoadModule("/app/request/request-composer.client.tsx"),
    ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(RequestComposer, composerProps(overrides)));
  });
  return {
    container,
    expandButton: () =>
      container.querySelector('[aria-label="Open request composer in focus mode"]'),
    closeButton: () =>
      container.querySelector('[aria-label="Exit request composer focus mode"]'),
    tab: (label) =>
      Array.from(container.querySelectorAll('[role="tab"]')).find((button) =>
        button.textContent.startsWith(label),
      ),
    async click(element) {
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
    },
    async keydown(key, options = {}) {
      await act(async () => {
        window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key,
            ...options,
          }),
        );
      });
    },
    async settle() {
      await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
      await server.close();
    },
  };
}

test("focus mode expands the composer and restores focus when dismissed", async () => {
  const view = await mount();
  try {
    const expand = view.expandButton();
    assert.ok(expand);

    await view.click(expand);
    await view.settle();

    const dialog = view.container.querySelector(
      '[role="dialog"][aria-label="Request composer focus mode"]',
    );
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.classList.contains("focus-mode-surface"));
    assert.ok(dialog.classList.contains("composer-focus-mode"));
    assert.equal(document.body.style.overflow, "hidden");
    assert.equal(
      document.activeElement,
      dialog.querySelector('textarea[aria-label="Message 1 content"]'),
    );
    assert.equal(view.closeButton()?.textContent, "×");

    await view.keydown("Escape");
    await view.settle();

    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(document.body.style.overflow, "");
    assert.equal(document.activeElement, view.expandButton());
  } finally {
    await view.close();
  }
});

test("focus mode has an explicit close button", async () => {
  const view = await mount();
  try {
    await view.click(view.expandButton());
    await view.settle();

    const close = view.closeButton();
    assert.ok(close);
    await view.click(close);
    await view.settle();

    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(document.body.style.overflow, "");
    // Dismissing with the pointer restores focus exactly as Escape does.
    assert.equal(document.activeElement, view.expandButton());
  } finally {
    await view.close();
  }
});

test("focus mode traps keyboard focus within the composer", async () => {
  const view = await mount();
  try {
    await view.click(view.expandButton());
    await view.settle();

    const dialog = view.container.querySelector('[role="dialog"]');
    const focusable = dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const last = focusable[focusable.length - 1];
    last.focus();
    await view.keydown("Tab");

    assert.equal(document.activeElement, focusable[0]);
  } finally {
    await view.close();
  }
});

test("leaving the messages tab exits focus mode and does not reopen on return", async () => {
  const view = await mount();
  try {
    await view.click(view.expandButton());
    await view.settle();
    assert.ok(view.container.querySelector('[role="dialog"]'));

    await view.click(view.tab("Tools"));
    await view.settle();
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(document.body.style.overflow, "");

    await view.click(view.tab("Messages"));
    await view.settle();

    // Focus mode belongs to the messages tab, but returning to it must not
    // restore a mode the user left behind.
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.ok(view.expandButton());
  } finally {
    await view.close();
  }
});
