import assert from "node:assert/strict";
import test, { after } from "node:test";

import { JSDOM } from "jsdom";
import { ssrLoadModule } from "./support/ssr.mjs";

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
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});

after(() => dom.window.close());

function execution() {
  const plan = {
    schemaVersion: 3,
    experimentId: "experiment_interaction",
    kind: "repeated-request",
    createdAt: "2026-07-31T12:00:00.000Z",
    commonInput: {
      conversationId: "conversation_interaction",
      conversationRevisionId: "revision_interaction",
      target: {
        profileId: "profile_interaction",
        protocol: "openai-compatible-chat-completions",
        endpoint: "https://provider.example.test/v1",
        model: "interaction-model",
        capabilities: {
          chatCompletions: true,
          responsesApi: false,
          streaming: true,
          modelDiscovery: false,
          tools: false,
          parallelToolCalls: false,
          structuredOutput: false,
          vision: false,
          embeddings: false,
        },
      },
      messages: [{ id: "message_interaction", role: "user", content: [{ type: "text", text: "Test" }] }],
      templateResolutions: [],
      responseMode: "streaming",
      options: {},
      tools: [],
      resolvedAt: "2026-07-31T12:00:00.000Z",
    },
    cells: [
      { cellId: "experiment-cell_interaction-1", ordinal: 1, runId: "run_interaction-1" },
      { cellId: "experiment-cell_interaction-2", ordinal: 2, runId: "run_interaction-2" },
    ],
  };
  return {
    plan,
    storage: "unsaved",
    workspace: null,
    states: new Map(),
    unreadableTraces: new Map(),
    result: {
      schemaVersion: 3,
      experimentId: plan.experimentId,
      status: "completed",
      endedAt: "2026-07-31T12:01:00.000Z",
      cells: [
        { cellId: "experiment-cell_interaction-1", runId: "run_interaction-1", status: "completed" },
        { cellId: "experiment-cell_interaction-2", runId: "run_interaction-2", status: "completed" },
      ],
    },
    traces: new Map([
      ["run_interaction-1", { runId: "run_interaction-1" }],
      ["run_interaction-2", { runId: "run_interaction-2" }],
    ]),
    selectedRunId: "run_interaction-1",
  };
}

test("contextual experiment review can select another trace and return to the request", async () => {
  const [{ RepeatedExperimentWorkspace }, { createElement }, { createRoot }, { act }] =
    await Promise.all([
      ssrLoadModule("/app/run/repeated-experiment-workspace.client.tsx"),
      import("react"),
      import("react-dom/client"),
      import("react"),
    ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let openedRunId;
  let returned = false;

  try {
    await act(async () => {
      root.render(createElement(RepeatedExperimentWorkspace, {
        execution: execution(),
        placement: "request",
        onStop() {},
        onOpenTrace(runId) { openedRunId = runId; },
        onReturnToRequest() { returned = true; },
      }));
    });

    const openButtons = [...container.querySelectorAll("button")].filter((button) =>
      button.textContent.includes("Open Response & Inspect"),
    );
    assert.equal(openButtons.length, 2);
    await act(async () => openButtons[1].click());
    assert.equal(openedRunId, "run_interaction-2");

    const backButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Back to request"),
    );
    assert.ok(backButton);
    await act(async () => backButton.click());
    assert.equal(returned, true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
