import assert from "node:assert/strict";
import test from "node:test";

import { evaluationStartReadiness } from "../app/evaluations/evaluation-start.client.ts";
import type { EvaluationResolvedLocalTarget } from "../app/evaluations/evaluation-start.client.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const ready = {
  projectOpen: true,
  suiteSelected: true,
  revisionSelected: true,
  revisionAvailable: true,
  diagnostics: [],
  selectedCaseCount: 1,
  repetitions: 1,
  toolBindings: [],
  targets: [{
    variantId: "evaluation-variant_default" as const,
    variantName: "Default",
    requirementId: "connection_default",
    requirementName: "Default provider",
    model: "test-model",
    responseMode: "streaming" as const,
    options: {},
    profile: {
      id: "profile-1",
      name: "Fixture profile",
      endpoint: "https://provider.example.test/v1",
      capabilities: { ...OPENAI_COMPATIBLE_CAPABILITIES, tools: true },
    },
  }],
  activityInProgress: false,
};

test("evaluation start readiness is ready only after every start gate passes", () => {
  assert.deepEqual(evaluationStartReadiness(ready), {});
  assert.deepEqual(
    evaluationStartReadiness({ ...ready, targets: ready.targets.map((target) => ({ ...target, profile: { ...target.profile, endpoint: "  " } })) }),
    { blockedReason: "The profile mapped to configuration “Default” needs an endpoint." },
  );
  assert.deepEqual(
    evaluationStartReadiness({ ...ready, targets: ready.targets.map((target) => ({ ...target, model: "" })) }),
    { blockedReason: "Configuration “Default” needs a model." },
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
  const unmappedTargets: EvaluationResolvedLocalTarget[] = structuredClone(ready.targets);
  delete unmappedTargets[0]!.profile;
  assert.deepEqual(
    evaluationStartReadiness({ ...ready, targets: unmappedTargets }),
    { blockedReason: "Map “Default provider” to a local profile for configuration “Default”." },
  );
});

test("every selected configuration is checked against its own mapped capabilities", () => {
  assert.deepEqual(
    evaluationStartReadiness({
      ...ready,
      targets: [
        ...ready.targets,
        {
          ...ready.targets[0],
          variantId: "evaluation-variant_second" as const,
          variantName: "Buffered only",
          profile: {
            ...ready.targets[0].profile,
            id: "profile-2",
            name: "Buffered fixture",
            capabilities: { ...ready.targets[0].profile.capabilities, streaming: false },
          },
        },
      ],
    }),
    { blockedReason: "Configuration “Buffered only” uses streaming, but Buffered fixture cannot stream. Choose buffered delivery." },
  );
});
