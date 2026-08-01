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
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});

after(() => dom.window.close());

const runState = {
  runId: "run_interaction",
  status: { kind: "starting" },
  events: [],
  turns: [],
  exchanges: {},
  toolResults: [],
  lastSequence: -1,
};

const templateResolution = {
  templateUseId: "template-use_question",
  templateId: "template_question",
  templateRevisionId: "template-revision_question-2",
  templateName: "Question",
  content: { kind: "fragment", text: "Explain {{topic}}." },
  variableDefaults: { topic: "branching" },
  values: { topic: "atomic branches" },
  outputMessageIds: ["message_question"],
  fragmentRole: "user",
};

test("disclosure preserves the selected tab and tabs support arrow keys", async () => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  const [
    { RunTracePanel },
    { createElement },
    { createRoot },
    { act },
  ] = await Promise.all([
    server.ssrLoadModule("/app/run-trace-panel.client.tsx"),
    import("react"),
    import("react-dom/client"),
    import("react"),
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let open = true;

  const render = () =>
    root.render(
      createElement(RunTracePanel, {
        open,
        runState,
        parentTrace: { status: "idle" },
        onLoadParentTrace() {},
        onOpenChange(next) {
          open = next;
          render();
        },
      }),
    );

  try {
    await act(async () => render());
    const eventsTab = container.querySelector("#run-details-events-tab");
    assert.ok(eventsTab);
    eventsTab.focus();
    await act(async () => {
      eventsTab.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
        }),
      );
    });

    const metricsTab = container.querySelector("#run-details-metrics-tab");
    assert.equal(metricsTab?.getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, metricsTab);
    assert.match(container.innerHTML, /run-details-metrics-panel/);

    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Run details"),
    );
    assert.ok(toggle);
    await act(async () => toggle.click());
    assert.equal(container.querySelector('[role="tabpanel"]'), null);

    const collapsedToggle = [...container.querySelectorAll("button")].find(
      (button) => button.textContent.includes("Run details"),
    );
    await act(async () => collapsedToggle.click());
    assert.equal(
      container
        .querySelector("#run-details-metrics-tab")
        ?.getAttribute("aria-selected"),
      "true",
    );
    assert.match(container.innerHTML, /run-details-metrics-panel/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await server.close();
  }
});

test("clearing the run retires the disclosure so the next run stays collapsed", async () => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  const [
    { RunTracePanel },
    { createElement },
    { createRoot },
    { act },
  ] = await Promise.all([
    server.ssrLoadModule("/app/run-trace-panel.client.tsx"),
    import("react"),
    import("react-dom/client"),
    import("react"),
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let open = true;
  let state = runState;

  const render = () =>
    root.render(
      createElement(RunTracePanel, {
        open,
        runState: state,
        parentTrace: { status: "idle" },
        onLoadParentTrace() {},
        onOpenChange(next) {
          open = next;
          render();
        },
      }),
    );

  try {
    await act(async () => render());
    assert.match(container.innerHTML, /run-details-events-panel/);

    // Resetting the session clears the run state out from under an open panel.
    state = null;
    await act(async () => render());
    assert.equal(open, false);
    assert.equal(container.querySelector('[role="tabpanel"]'), null);

    // A later run must not inherit the disclosure the reset invalidated.
    state = runState;
    await act(async () => render());
    assert.equal(open, false);
    assert.equal(container.querySelector('[role="tabpanel"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await server.close();
  }
});

test("falls back from a preserved Templates preference and restores it when available", async () => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  const [
    { RunTracePanel },
    { createElement },
    { createRoot },
    { act },
  ] = await Promise.all([
    server.ssrLoadModule("/app/run-trace-panel.client.tsx"),
    import("react"),
    import("react-dom/client"),
    import("react"),
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let state = {
    ...runState,
    input: { templateResolutions: [templateResolution] },
  };

  const render = () =>
    root.render(
      createElement(RunTracePanel, {
        open: true,
        runState: state,
        parentTrace: { status: "idle" },
        onLoadParentTrace() {},
        onOpenChange() {},
      }),
    );

  try {
    await act(async () => render());
    const templatesTab = container.querySelector("#run-details-resolution-tab");
    assert.ok(templatesTab);
    assert.match(templatesTab.textContent, /Templates1/);
    await act(async () => templatesTab.click());
    assert.equal(templatesTab.getAttribute("aria-selected"), "true");
    assert.match(container.innerHTML, /run-details-resolution-panel/);

    state = { ...runState, input: { templateResolutions: [] } };
    await act(async () => render());
    assert.equal(container.querySelector("#run-details-resolution-tab"), null);
    assert.equal(
      container.querySelectorAll('[role="tab"][aria-selected="true"]').length,
      1,
    );
    assert.equal(
      container
        .querySelector("#run-details-events-tab")
        ?.getAttribute("aria-selected"),
      "true",
    );
    assert.match(container.innerHTML, /run-details-events-panel/);
    assert.doesNotMatch(container.innerHTML, /run-details-resolution-panel/);

    state = {
      ...runState,
      input: { templateResolutions: [templateResolution] },
    };
    await act(async () => render());
    assert.equal(
      container
        .querySelector("#run-details-resolution-tab")
        ?.getAttribute("aria-selected"),
      "true",
    );
    assert.match(container.innerHTML, /run-details-resolution-panel/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await server.close();
  }
});
