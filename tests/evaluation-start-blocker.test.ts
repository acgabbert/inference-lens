import assert from "node:assert/strict";
import test from "node:test";

import { evaluationStartBlocker } from "../packages/runner/src/evaluation-start.ts";
import type { EvaluationResolvedLocalTarget } from "../packages/runner/src/evaluation-start.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const target: EvaluationResolvedLocalTarget = {
  variantId: "evaluation-variant_default",
  variantName: "Default",
  requirementId: "connection_default",
  requirementName: "Default provider",
  protocol: "openai-compatible-chat-completions",
  model: "test-model",
  responseMode: "buffered",
  options: {},
  profile: {
    id: "profile-1",
    name: "Fixture profile",
    endpoint: "https://provider.example.test/v1",
    capabilities: { ...OPENAI_COMPATIBLE_CAPABILITIES, tools: false },
  },
};

const ready = {
  diagnostics: [],
  selectedCaseCount: 1,
  selectedVariantCount: 1,
  repetitions: 1,
  toolBindings: [],
  targets: [target],
};

test("a ready start has no blocker", () => {
  assert.equal(evaluationStartBlocker(ready), undefined);
});

test("blockers carry the data each host phrases, not a sentence", () => {
  assert.deepEqual(
    evaluationStartBlocker({ ...ready, toolBindings: [{ name: "lookup", bound: false }, { name: "search", bound: true }] }),
    { kind: "unbound_tools", toolNames: ["lookup"] },
  );
  assert.deepEqual(
    evaluationStartBlocker({ ...ready, toolBindings: [{ name: "lookup", bound: true }] }),
    { kind: "tools_unsupported", target },
  );
  const limited = evaluationStartBlocker({ ...ready, selectedCaseCount: 1_001 });
  assert.equal(limited?.kind, "batch_limit");
  assert.deepEqual(limited?.kind === "batch_limit" && limited.limit, { kind: "calls_exceeded", maximum: 1_000 });
});

test("authoring and cost come before tools, and tools before any connection", () => {
  const everythingWrong = {
    diagnostics: [{ message: "Select at least one case." }],
    selectedCaseCount: 1,
    selectedVariantCount: 1,
    repetitions: 0,
    toolBindings: [{ name: "lookup", bound: false }],
    targets: [{ ...target, model: "" }],
  };
  assert.equal(evaluationStartBlocker(everythingWrong)?.kind, "suite_diagnostic");
  assert.equal(evaluationStartBlocker({ ...everythingWrong, diagnostics: [] })?.kind, "batch_limit");
  assert.equal(evaluationStartBlocker({ ...everythingWrong, diagnostics: [], repetitions: 1 })?.kind, "unbound_tools");
  assert.equal(
    evaluationStartBlocker({ ...everythingWrong, diagnostics: [], repetitions: 1, toolBindings: [] })?.kind,
    "model_missing",
  );
});
