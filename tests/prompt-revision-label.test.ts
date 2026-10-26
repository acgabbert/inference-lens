import { chatTemplate } from "./project-kind-helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { createProjectFile, createPromptTemplate, appendPromptTemplateRevision } from "../packages/core/src/project.ts";
import { diffPromptTemplateRevisions } from "../packages/core/src/prompt-template-revision-diff.ts";
import { diffDecisionPromptTemplateRevisions } from "../packages/core/src/decision-template-revision-diff.ts";
import type { DecisionPromptTemplateRevision } from "../packages/core/src/project.ts";
import {
  describeCompatibleSuiteRevision,
  promptRevisionLabel,
  summarizeDecisionRevisionDiff,
  summarizeRevisionDiff,
  summarizeRevisionVariableChanges,
} from "../app/templates/prompt-revision-label.ts";

function projectWithTemplate() {
  const base = createProjectFile({
    name: "Prompt revision label",
    request: {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      messages: [{ role: "user", content: "Original question" }],
    },
    idSuffix: "prompt-revision-label",
    createdAt: "2026-08-06T12:00:00.000Z",
  });
  const withTemplate = createPromptTemplate(base, {
    name: "Support reply",
    messages: [{ role: "user", content: "Reply to {{ticket}}." }],
    idSuffix: "support-reply",
    revisionIdSuffix: "support-reply-1",
  });
  const templateId = withTemplate.promptTemplates[0]!.id;
  const withSecondRevision = appendPromptTemplateRevision(withTemplate, {
    templateId,
    messages: [{ role: "user", content: "Reply kindly to {{ticket}}." }],
    idSuffix: "support-reply-2",
  });
  return { project: withSecondRevision, template: chatTemplate(withSecondRevision.promptTemplates[0]) };
}

test("promptRevisionLabel falls back to position and marks the current revision", () => {
  const { template } = projectWithTemplate();
  const [first, second] = template.revisions;
  assert.equal(promptRevisionLabel(template, second!.id), "Revision 2 (current)");
  assert.equal(promptRevisionLabel(template, first!.id), "Revision 1");
});

test("promptRevisionLabel leads with an author-supplied revision name", () => {
  const { project, template } = projectWithTemplate();
  const named = chatTemplate(appendPromptTemplateRevision(project, {
    templateId: template.id,
    messages: [{ role: "user", content: "Reply briefly to {{ticket}}." }],
    name: "Brevity pass",
    idSuffix: "support-reply-3",
  }).promptTemplates[0]);
  const renamedOlder = { ...named, revisions: named.revisions.map((revision, index) =>
    index === 0 ? { ...revision, name: "Baseline" } : revision) };
  assert.equal(promptRevisionLabel(renamedOlder, named.revisions[2]!.id), "Brevity pass (current)");
  assert.equal(promptRevisionLabel(renamedOlder, named.revisions[0]!.id), "Baseline");
  assert.equal(promptRevisionLabel(renamedOlder, named.revisions[1]!.id), "Revision 2");
});

test("describeCompatibleSuiteRevision reports 'current' when the suite already pins the target revision", () => {
  const { template } = projectWithTemplate();
  const [, second] = template.revisions;
  const state = describeCompatibleSuiteRevision(template, second!.id, second!.id);
  assert.deepEqual(state, { kind: "current", label: "Revision 2 (current)" });
});

test("describeCompatibleSuiteRevision reports 'outdated' with both labels when the suite pins an older revision", () => {
  const { template } = projectWithTemplate();
  const [first, second] = template.revisions;
  const state = describeCompatibleSuiteRevision(template, first!.id, second!.id);
  assert.deepEqual(state, { kind: "outdated", pinnedLabel: "Revision 1", targetLabel: "Revision 2 (current)" });
});

test("describeCompatibleSuiteRevision reports 'unknown' when the template is absent", () => {
  const { template } = projectWithTemplate();
  const [, second] = template.revisions;
  const state = describeCompatibleSuiteRevision(undefined, second!.id, second!.id);
  assert.deepEqual(state, { kind: "unknown" });
});

test("summarizeRevisionDiff reports 'identical' for a no-op comparison", () => {
  const { template } = projectWithTemplate();
  const [first] = template.revisions;
  const diff = diffPromptTemplateRevisions(first!, first!);
  assert.equal(summarizeRevisionDiff(diff), "identical");
});

test("summarizeRevisionDiff counts message and default changes", () => {
  const { template } = projectWithTemplate();
  const [first, second] = template.revisions;
  const diff = diffPromptTemplateRevisions(first!, second!);
  assert.equal(summarizeRevisionDiff(diff), "1 message change");
});

test("summarizeRevisionVariableChanges names what a switch adds, removes, clears and newly requires", () => {
  const changes = summarizeRevisionVariableChanges({
    before: { variables: ["ticket", "tone", "locale", "audience"], defaults: { audience: "customers" } },
    after: { variables: ["ticket", "audience", "product", "channel"], defaults: { channel: "email" } },
    kept: ["ticket", "tone"],
  });
  assert.deepEqual(changes, {
    added: ["product", "channel"],
    removed: ["tone", "locale"],
    cleared: ["tone"],
    // audience lost its default; product is new without one. ticket keeps its value.
    needsValue: ["audience", "product"],
  });
});

test("summarizeRevisionVariableChanges is empty when the variable set and values carry over", () => {
  const changes = summarizeRevisionVariableChanges({
    before: { variables: ["ticket"], defaults: {} },
    after: { variables: ["ticket"], defaults: {} },
    kept: [],
  });
  // ticket already needed a value before the switch, so it is not a change.
  assert.deepEqual(changes, { added: [], removed: [], cleared: [], needsValue: [] });
});

test("summarizeDecisionRevisionDiff counts decision content changes", () => {
  const before = {
    id: "template-revision_a", createdAt: "2026-08-06T12:00:00.000Z", variableDefaults: {},
    decision: { state: { ticket: "{{ticket}}" }, questions: {
      severity: { type: "single-choice", instructions: "Rate it.", criteria: ["low", "high"] },
    } },
  } as unknown as DecisionPromptTemplateRevision;
  const after = {
    ...before, id: "template-revision_b", variableDefaults: { ticket: "T-1" },
    decision: { state: { ticket: "{{ticket}}", extra: true }, questions: {
      severity: { type: "single-choice", instructions: "Rate it carefully.", criteria: ["low", "high"] },
    } },
  } as unknown as DecisionPromptTemplateRevision;
  assert.equal(summarizeDecisionRevisionDiff(diffDecisionPromptTemplateRevisions(before, before)), "identical");
  assert.equal(
    summarizeDecisionRevisionDiff(diffDecisionPromptTemplateRevisions(before, after)),
    "state changed, 1 question change, 1 default change",
  );
});
