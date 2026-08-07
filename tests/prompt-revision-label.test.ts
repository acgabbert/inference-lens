import assert from "node:assert/strict";
import test from "node:test";

import { createProjectFile, createPromptTemplate, appendPromptTemplateRevision } from "../packages/core/src/project.ts";
import { diffPromptTemplateRevisions } from "../packages/core/src/prompt-template-revision-diff.ts";
import { describeCompatibleSuiteRevision, promptRevisionLabel, summarizeRevisionDiff } from "../app/templates/prompt-revision-label.ts";

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
  return { project: withSecondRevision, template: withSecondRevision.promptTemplates[0]! };
}

test("promptRevisionLabel names the current revision Current and earlier ones by position", () => {
  const { template } = projectWithTemplate();
  const [first, second] = template.revisions;
  assert.equal(promptRevisionLabel(template, second!.id), "Current");
  assert.equal(promptRevisionLabel(template, first!.id), "Revision 1");
});

test("describeCompatibleSuiteRevision reports 'current' when the suite already pins the target revision", () => {
  const { template } = projectWithTemplate();
  const [, second] = template.revisions;
  const state = describeCompatibleSuiteRevision(template, second!.id, second!.id);
  assert.deepEqual(state, { kind: "current", label: "Current" });
});

test("describeCompatibleSuiteRevision reports 'outdated' with both labels when the suite pins an older revision", () => {
  const { template } = projectWithTemplate();
  const [first, second] = template.revisions;
  const state = describeCompatibleSuiteRevision(template, first!.id, second!.id);
  assert.deepEqual(state, { kind: "outdated", pinnedLabel: "Revision 1", targetLabel: "Current" });
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
