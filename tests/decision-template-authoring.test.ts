import assert from "node:assert/strict";
import test from "node:test";

import { decisionTemplateUseOverrides } from "../app/decisions/decision-template-use-overrides.ts";
import { materializeSessionDecisionTemplate } from "../app/templates/decision-session-template.ts";
import type { DecisionInput } from "../packages/core/src/decision.ts";
import { createProjectFile, type DecisionPromptTemplate, type ProjectFile } from "../packages/core/src/project.ts";
import { createEntityId } from "../packages/core/src/run-kernel/types.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";

test("Compose edits keep existing overrides and add only changed values", () => {
  assert.deepEqual(
    decisionTemplateUseOverrides({
      variables: ["ticket", "plan", "tier", "region"],
      effectiveValues: { ticket: "Default", plan: "basic", tier: "gold", region: "eu" },
      existingOverrides: { plan: "basic" },
      values: { ticket: "Default", plan: "basic", tier: "silver", stale: "dropped" },
    }),
    // ticket matches its default and was never overridden; plan stays
    // overridden although it matches; tier changed; region has no value.
    { plan: "basic", tier: "silver" },
  );
});

test("an override can hold an explicitly empty value", () => {
  assert.deepEqual(
    decisionTemplateUseOverrides({
      variables: ["ticket"],
      effectiveValues: { ticket: "Default" },
      existingOverrides: {},
      values: { ticket: "" },
    }),
    { ticket: "" },
  );
});

const decision: DecisionInput = {
  state: "{{ticket}}",
  questions: { answer: { type: "noul", instructions: "Is this relevant?" } },
};

function sessionTemplate(connectionRequirementId: ProjectFile["connectionRequirements"][number]["id"]): DecisionPromptTemplate {
  const revisionId = createEntityId("template-revision", "session-1");
  return {
    kind: "decision",
    id: createEntityId("template", "session"),
    name: "Staged",
    currentRevisionId: revisionId,
    recommendedTarget: { connectionRequirementId, model: "advised" },
    revisions: [{ id: revisionId, createdAt: "2026-10-25T00:00:00.000Z", decision, variableDefaults: { ticket: "Captured" } }],
  };
}

function project() {
  return createProjectFile({
    name: "Decisions",
    idSuffix: "d",
    createdAt: "2026-10-24T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:24028/v1",
      model: "chat-model",
      messages: [{ role: "user", content: "Hello" }],
      capabilities: resolveProviderCapabilities("openai-compatible"),
    },
  });
}

test("saving a session prompt keeps its ids and recommendation with the reviewed content", () => {
  const base = project();
  const staged = sessionTemplate(base.connectionRequirements[0]!.id);
  const saved = materializeSessionDecisionTemplate(base, staged, {
    name: "Reviewed",
    decision: { ...decision, state: "Reviewed {{ticket}}" },
    variableDefaults: {},
    revisionName: "  First cut ",
  });
  const template = saved.promptTemplates.find(({ id }) => id === staged.id);
  assert.ok(template && template.kind === "decision");
  assert.equal(template.name, "Reviewed");
  assert.equal(template.currentRevisionId, staged.currentRevisionId);
  assert.deepEqual(template.recommendedTarget, staged.recommendedTarget);
  assert.equal(template.revisions.length, 1);
  assert.equal(template.revisions[0]!.name, "First cut");
  assert.equal(template.revisions[0]!.decision.state, "Reviewed {{ticket}}");
  // Removing a captured default during review leaves the variable unfilled.
  assert.deepEqual(template.revisions[0]!.variableDefaults, {});
});

test("a blank revision name is not recorded", () => {
  const base = project();
  const staged = sessionTemplate(base.connectionRequirements[0]!.id);
  const saved = materializeSessionDecisionTemplate(base, staged, {
    name: "Reviewed",
    decision,
    variableDefaults: { ticket: "" },
    revisionName: "   ",
  });
  const template = saved.promptTemplates.find(({ id }) => id === staged.id);
  assert.ok(template && template.kind === "decision");
  assert.equal(Object.hasOwn(template.revisions[0]!, "name"), false);
  assert.deepEqual(template.revisions[0]!.variableDefaults, { ticket: "" });
});
