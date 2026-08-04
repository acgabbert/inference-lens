import assert from "node:assert/strict";
import test from "node:test";

import { evaluationStartReadiness } from "../app/evaluations/evaluation-start.client.ts";

const ready = {
  projectOpen: true,
  suiteSelected: true,
  revisionSelected: true,
  revisionAvailable: true,
  diagnostics: [],
  selectedCaseCount: 1,
  repetitions: 1,
  toolBindings: [],
  connectionMapped: true,
  hasProjectMapping: true,
  endpoint: "https://provider.example.test/v1",
  model: "test-model",
  responseMode: "streaming" as const,
  streamingAvailable: true,
  activityInProgress: false,
};

test("evaluation start readiness is ready only after every start gate passes", () => {
  assert.deepEqual(evaluationStartReadiness(ready), {});
  assert.deepEqual(
    evaluationStartReadiness({ ...ready, endpoint: "  " }),
    { blockedReason: "Enter an endpoint before starting." },
  );
  assert.deepEqual(
    evaluationStartReadiness({ ...ready, model: "" }),
    { blockedReason: "Enter a model before starting." },
  );
  assert.deepEqual(
    evaluationStartReadiness({ ...ready, activityInProgress: true }),
    { blockedReason: "Finish or stop the current run first." },
  );
});

test("evaluation start readiness preserves the ordered authoring and connection policy", () => {
  assert.deepEqual(
    evaluationStartReadiness({ ...ready, diagnostics: [{ message: "Select at least one case." }] }),
    { blockedReason: "Select at least one case." },
  );
  assert.deepEqual(
    evaluationStartReadiness({
      ...ready,
      toolBindings: [{ name: "get_weather", bound: false }],
    }),
    {
      blockedReason:
        "This suite exposes get_weather, and nothing on this device can serve it. Enable a mock or grant a command tool first.",
    },
  );
  // A bound tool passes the gate; the shell statement is appended only when the
  // shell is the reason nothing can serve it.
  assert.deepEqual(
    evaluationStartReadiness({
      ...ready,
      toolBindings: [{ name: "get_weather", bound: true }],
    }),
    {},
  );
  assert.deepEqual(
    evaluationStartReadiness({
      ...ready,
      toolBindings: [{ name: "query_db", bound: false }],
      commandToolsUnavailableReason: "The desktop app cannot run command tools yet.",
    }),
    {
      blockedReason:
        "This suite exposes query_db, and nothing on this device can serve it. Enable a mock or grant a command tool first. The desktop app cannot run command tools yet.",
    },
  );
  // The safety maximum now counts the worst case: 250 repetitions that may each
  // buy five turns is 1,250 provider calls, not 250.
  assert.deepEqual(
    evaluationStartReadiness({
      ...ready,
      selectedCaseCount: 50,
      repetitions: 5,
      toolBindings: [{ name: "get_weather", bound: true }],
    }),
    {
      blockedReason:
        "This evaluation exposes tools, so each of its 250 repetitions may spend up to 5 provider turns — 1,250 calls against a safety maximum of 1,000. Reduce the cases, the repetitions, or the turn ceiling.",
    },
  );
  assert.deepEqual(
    evaluationStartReadiness({ ...ready, connectionMapped: false, hasProjectMapping: false }),
    { blockedReason: "Map this project's connection to a local profile before starting." },
  );
});
