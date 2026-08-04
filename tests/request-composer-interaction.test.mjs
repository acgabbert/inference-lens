import assert from "node:assert/strict";
import test, { after } from "node:test";

import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { uniqueViteCacheDir } from "./support/vite-cache-dir.mjs";

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
    commandTools: {
      availability: { kind: "unconfigured", variable: "INFERENCE_LENS_COMMAND_TOOLS" },
      commands: [],
      grantFor: () => undefined,
      bindingFor: () => undefined,
      grant() {},
      revoke() {},
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
    onDestinationHandled: noop,
    activeProfile: { name: "Fixture profile" },
    onOpenConnectionSettings: noop,
    onOpenN8nImport: noop,
    onOpenToolLibrary: noop,
    onSaveParentTrace: noop,
    onDiscardPendingBranch: noop,
    ...overrides,
  };
}

/**
 * Evaluations left the composer for their own mode. The composer used to blank
 * the application's readiness policy on that tab, which is the disguise the
 * mode shell removed — so the notice now belongs to every tab it can reach.
 */
test("the composer owns request tabs only, and states readiness on each of them", async () => {
  const view = await mount({
    readiness: {
      blocked: true,
      headline: "A template variable still needs a value",
      detail: "Enter a value for topic in the Messages tab.",
      summary: "Complete the named template input before running.",
      facts: [],
      actions: [],
    },
  });
  try {
    assert.equal(view.tab("Evaluations"), undefined);
    assert.deepEqual(
      Array.from(view.container.querySelectorAll('[role="tab"]')).map((tab) =>
        tab.textContent.replace(/\d+$/, ""),
      ),
      ["Messages", "Prompt library", "Tools"],
    );

    assert.match(view.container.textContent, /template variable still needs a value/i);
    await view.click(view.tab("Tools"));
    assert.match(view.container.textContent, /template variable still needs a value/i);
    await view.click(view.tab("Prompt library"));
    assert.match(view.container.textContent, /template variable still needs a value/i);
  } finally {
    await view.close();
  }
});

test("temperature is omitted by default and can be explicitly overridden", async () => {
  const changes = [];
  const view = await mount({
    settings: {
      ...composerProps().settings,
      temperature: undefined,
      onTemperatureChange: (temperature) => changes.push(temperature),
    },
  });
  try {
    await view.click(view.settingsToggle());
    assert.match(view.container.textContent, /Provider default/);
    const toggle = view.container.querySelector(
      '.temperature-control input[type="checkbox"]',
    );
    assert.ok(toggle);
    assert.equal(toggle.checked, false);

    await view.click(toggle);
    assert.deepEqual(changes, [0.2]);
  } finally {
    await view.close();
  }
});

test("the remembered temperature override survives collapsing the panel", async () => {
  const changes = [];
  // The profile's own value, which the author is entitled to get back after
  // clearing the override. The workbench owns the committed value, so the test
  // re-renders with it exactly as the route does.
  const settings = (temperature) => ({
    ...composerProps().settings,
    temperature,
    onTemperatureChange: (next) => changes.push(next),
  });
  const view = await mount({ settings: settings(0.7) });
  try {
    await view.click(view.settingsToggle());
    const override = () =>
      view.container.querySelector('.temperature-control input[type="checkbox"]');
    await view.click(override());
    assert.deepEqual(changes, [undefined]);
    await view.rerender({ settings: settings(undefined) });
    assert.equal(override().checked, false);

    // The control that reads the remembered override is inside the disclosure,
    // so a collapse and reopen is exactly what would discard it.
    await view.click(view.settingsToggle());
    await view.click(view.settingsToggle());
    await view.click(override());
    assert.deepEqual(changes, [undefined, 0.7]);
  } finally {
    await view.close();
  }
});

test("the settings panel hides its controls behind a summary of what will be sent", async () => {
  const view = await mount();
  try {
    const toggle = view.settingsToggle();
    assert.ok(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    // The model stays a live field in the summary row; collapsing hides only
    // the secondary controls, whose values remain named as facts.
    const model = view.container.querySelector('[data-readiness-control="model"]');
    assert.equal(model?.value, "fixture-model");
    const facts = Array.from(
      view.container.querySelectorAll(".inference-settings-fact"),
    ).map((fact) => fact.textContent);
    assert.deepEqual(facts, ["Temp 0.7", "Buffered"]);
    assert.equal(
      view.container.querySelector('.temperature-control input[type="range"]'),
      null,
    );

    await view.click(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(
      toggle.getAttribute("aria-controls"),
      view.container.querySelector(".inference-settings-body")?.id,
    );
    assert.ok(
      view.container.querySelector('.temperature-control input[type="range"]'),
    );

    await view.click(toggle);
    assert.equal(view.container.querySelector(".inference-settings-body"), null);
  } finally {
    await view.close();
  }
});

test("a readiness destination naming the model focuses it without disturbing the panel", async () => {
  let handled = 0;
  const view = await mount({
    pendingDestination: { surface: "request", tab: "messages", control: "model" },
    onDestinationHandled: () => { handled += 1; },
  });
  try {
    // The field lives in the always-visible summary row, so the destination
    // focuses it directly and the disclosure stays collapsed.
    const input = view.container.querySelector('[data-readiness-control="model"]');
    assert.ok(input);
    assert.equal(view.settingsToggle().getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, input);
    assert.equal(handled, 1);
  } finally {
    await view.close();
  }
});

async function mount(overrides = {}) {
  const server = await createServer({
    configFile: false, cacheDir: uniqueViteCacheDir(),
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
    /** Re-renders with new props, as the workbench does when a setting commits. */
    async rerender(nextOverrides) {
      await act(async () => {
        root.render(createElement(RequestComposer, composerProps(nextOverrides)));
      });
    },
    expandButton: () =>
      container.querySelector('[aria-label="Open request composer in focus mode"]'),
    settingsToggle: () => container.querySelector(".inference-settings-toggle"),
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
