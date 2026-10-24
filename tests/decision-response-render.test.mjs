import assert from "node:assert/strict";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

/**
 * Renders the real Decision response pane. A paused run's Retry is refused
 * while another foreground activity runs (D24); the button has to say so
 * rather than stay enabled and do nothing.
 */
async function renderResponse(props) {
  const [{ DecisionResponse }, { renderToStaticMarkup }, { createElement }] =
    await Promise.all([
      ssrLoadModule("/app/decisions/decision-response.client.tsx"),
      import("react-dom/server"),
      import("react"),
    ]);
  return renderToStaticMarkup(
    createElement(DecisionResponse, {
      executing: false,
      traceStorage: null,
      emptyDetail: "Run the decision to see each answer.",
      onRetry() {},
      onDiscard() {},
      onSaveTrace() {},
      ...props,
    }),
  );
}

const pausedRun = {
  runId: "run_paused",
  status: { kind: "paused", attempt: 1, error: { message: "Too many requests." } },
  attempts: [],
  exchanges: {},
  input: {
    target: { model: "decider", endpoint: "https://llm.example.test/v1" },
    decision: { state: "s", questions: {} },
  },
};

test("a paused run's Retry names the activity that refuses it", async () => {
  const html = await renderResponse({
    run: pausedRun,
    retryBlockedReason: "A batch is running. Wait for it or stop it before running a decision.",
  });
  const button = html.match(/<button[^>]*>Retry attempt/)?.[0];
  assert.ok(button, "the Retry button is rendered");
  assert.match(button, /disabled=""/);
  const describedBy = button.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy, "Retry names the element that states why");
  assert.match(
    html,
    new RegExp(`id="${describedBy}"[^>]*>A batch is running\\. Wait for it or stop it before running a decision\\.<`),
  );
});

test("with nothing else running, a paused run's Retry is offered", async () => {
  const html = await renderResponse({ run: pausedRun });
  const button = html.match(/<button[^>]*>Retry attempt/)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /disabled=""/);
  assert.doesNotMatch(button, /aria-describedby/);
});
