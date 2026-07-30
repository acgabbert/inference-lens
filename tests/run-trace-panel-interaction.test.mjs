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

test("disclosure preserves the selected tab and tabs support arrow keys", async () => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
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
