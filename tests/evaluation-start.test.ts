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
  selectedToolCount: 0,
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
    evaluationStartReadiness({ ...ready, selectedToolCount: 1 }),
    { blockedReason: "Evaluations do not support exposed tools yet. Disable tools before starting." },
  );
  assert.deepEqual(
    evaluationStartReadiness({ ...ready, connectionMapped: false, hasProjectMapping: false }),
    { blockedReason: "Map this project's connection to a local profile before starting." },
  );
});
