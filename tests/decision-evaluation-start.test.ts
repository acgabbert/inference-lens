import assert from "node:assert/strict";
import test from "node:test";

import {
  createDecisionEvaluationStartPlan,
  decisionEvaluationStartBlocker,
  resolveDecisionEvaluationLocalTargets,
} from "../packages/runner/src/evaluation-start.ts";
import type { EvaluationLocalProfile } from "../packages/runner/src/evaluation-start.ts";
import type { EvaluationVariantId } from "../packages/core/src/run-kernel/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import { decisionProject } from "./fixtures/decision-evaluation.ts";

const project = decisionProject();
const requirementId = project.defaults.target.connectionRequirementId;
const BASE = "evaluation-variant_base" as EvaluationVariantId;
const BIG = "evaluation-variant_big" as EvaluationVariantId;

const decisionProfile: EvaluationLocalProfile = {
  id: "decisions",
  name: "Decision fixture",
  endpoint: "http://127.0.0.1:44028/llamacpp/v1",
  capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  systemOne: true,
};

const base = {
  project,
  suiteId: "evaluation-suite_routing" as const,
  selectedVariantIds: [BASE, BIG],
  profiles: [decisionProfile],
  mappedProfileIds: { [requirementId]: "decisions" },
};

test("each selected configuration resolves to its model on the profile its requirement maps to", () => {
  const targets = resolveDecisionEvaluationLocalTargets(base);
  assert.deepEqual(targets.map(({ variantName, model, requirementId: id, profile }) => ({ variantName, model, id, profile: profile?.id })), [
    { variantName: "Default", model: "local-decision", id: requirementId, profile: "decisions" },
    { variantName: "Big", model: "big-decision", id: requirementId, profile: "decisions" },
  ]);
});

test("a decision start is blocked by an unmapped requirement and by a profile without System One", () => {
  const ready = { diagnostics: [], selectedCaseCount: 2, selectedVariantCount: 2, repetitions: 2 };
  assert.equal(decisionEvaluationStartBlocker({ ...ready, targets: resolveDecisionEvaluationLocalTargets(base) }), undefined);

  const unmapped = resolveDecisionEvaluationLocalTargets({ ...base, mappedProfileIds: {} });
  assert.equal(decisionEvaluationStartBlocker({ ...ready, targets: unmapped })?.kind, "profile_unmapped");

  const chatOnly = resolveDecisionEvaluationLocalTargets({ ...base, profiles: [{ ...decisionProfile, systemOne: false }] });
  const blocker = decisionEvaluationStartBlocker({ ...ready, targets: chatOnly });
  assert.equal(blocker?.kind, "system_one_undeclared");
  assert.equal(blocker && "target" in blocker ? blocker.target.variantName : undefined, "Default");

  assert.equal(decisionEvaluationStartBlocker({ ...ready, diagnostics: [{ message: "Add a case." }], targets: chatOnly })?.kind, "suite_diagnostic");
  assert.equal(decisionEvaluationStartBlocker({ ...ready, selectedVariantCount: 0, targets: [] })?.kind, "no_configuration_selected");
});

test("the start plan is a decision evaluation whose targets are the mapped profile", () => {
  const { plan, targets } = createDecisionEvaluationStartPlan({
    ...base,
    selectedCaseIds: ["evaluation-case_refund"],
  });
  assert.equal(plan.kind, "decision-evaluation");
  assert.equal(targets.length, 2);
  assert.deepEqual(plan.suite.variants.map(({ target }) => target), [
    { profileId: "profile_decisions", protocol: "systemone", endpoint: decisionProfile.endpoint, model: "local-decision", capabilities: OPENAI_COMPATIBLE_CAPABILITIES },
    { profileId: "profile_decisions", protocol: "systemone", endpoint: decisionProfile.endpoint, model: "big-decision", capabilities: OPENAI_COMPATIBLE_CAPABILITIES },
  ]);
  assert.equal(plan.cells.length, 4);
});
