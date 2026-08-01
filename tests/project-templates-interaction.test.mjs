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

const template = {
  id: "template_question",
  name: "Question",
  currentRevisionId: "template-revision_question-1",
  revisions: [
    {
      id: "template-revision_question-1",
      createdAt: "2026-07-31T12:00:00.000Z",
      content: { kind: "fragment", text: "Explain {{topic}}." },
      variableDefaults: { topic: "branching" },
    },
  ],
};

async function mount() {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    logLevel: "warn",
  });
  const [{ createElement, act }, { createRoot }, { ProjectTemplatesPane }] =
    await Promise.all([
      import("react"),
      import("react-dom/client"),
      server.ssrLoadModule("/app/project-templates-pane.client.tsx"),
    ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const noop = () => {};
  await act(async () => {
    root.render(
      createElement(ProjectTemplatesPane, {
        templates: [template],
        connectionRequirements: [],
        usageCounts: new Map(),
        itemCount: 0,
        onOpenN8nImport: noop,
        onCreate: () => "template_new",
        onSave: () => template.currentRevisionId,
        onInsert: noop,
      }),
    );
  });
  return {
    act,
    container,
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

test("focus mode expands the live editor and restores focus when dismissed", async () => {
  const view = await mount();
  try {
    const expand = view.container.querySelector(
      '[aria-label="Open prompt editor in focus mode"]',
    );
    assert.ok(expand);

    await view.click(expand);
    await view.settle();

    const dialog = view.container.querySelector(
      '[role="dialog"][aria-label="Prompt editor focus mode"]',
    );
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.classList.contains("focus-mode-surface"));
    assert.ok(dialog.classList.contains("template-editor-focus-mode"));
    assert.equal(document.body.style.overflow, "hidden");
    assert.equal(
      document.activeElement,
      dialog.querySelector('textarea[aria-label="Prompt content"]'),
    );
    const close = dialog.querySelector(
      '[aria-label="Exit prompt editor focus mode"]',
    );
    assert.ok(close);
    assert.equal(close.textContent, "×");

    await view.keydown("Escape");
    await view.settle();

    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(document.body.style.overflow, "");
    assert.equal(
      document.activeElement,
      view.container.querySelector(
        '[aria-label="Open prompt editor in focus mode"]',
      ),
    );
  } finally {
    await view.close();
  }
});

test("focus mode has an explicit close button", async () => {
  const view = await mount();
  try {
    await view.click(
      view.container.querySelector(
        '[aria-label="Open prompt editor in focus mode"]',
      ),
    );
    await view.settle();

    const close = view.container.querySelector(
      '[aria-label="Exit prompt editor focus mode"]',
    );
    assert.ok(close);
    await view.click(close);
    await view.settle();

    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(document.body.style.overflow, "");
    // Dismissing with the pointer restores focus exactly as Escape does.
    assert.equal(
      document.activeElement,
      view.container.querySelector(
        '[aria-label="Open prompt editor in focus mode"]',
      ),
    );
  } finally {
    await view.close();
  }
});

test("focus mode traps keyboard focus within the editor", async () => {
  const view = await mount();
  try {
    await view.click(
      view.container.querySelector(
        '[aria-label="Open prompt editor in focus mode"]',
      ),
    );
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
