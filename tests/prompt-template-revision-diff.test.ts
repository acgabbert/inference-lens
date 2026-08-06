import assert from "node:assert/strict";
import test from "node:test";

import { diffPromptTemplateRevisions } from "../packages/core/src/prompt-template-revision-diff.ts";
import type { PromptTemplateRevision } from "../packages/core/src/project.ts";

const revision = (overrides: Partial<PromptTemplateRevision> = {}): PromptTemplateRevision => ({
  id: "template-revision_test-1",
  createdAt: "2026-08-06T12:00:00.000Z",
  messages: [{ role: "user", content: "Ask {{topic}}." }],
  variableDefaults: { topic: "trees" },
  ...overrides,
});

test("keeps message order and roles explicit while diffing each message body", () => {
  const result = diffPromptTemplateRevisions(
    revision({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Ask {{topic}}." }] }),
    revision({ messages: [{ role: "user", content: "Ask {{topic}}." }, { role: "system", content: "Be precise." }] }),
  );
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.roleChanged, true);
  assert.equal(result.messages[1]?.roleChanged, true);
  assert.equal(result.messages[1]?.content.addedCount, 1);
  assert.equal(result.messages[1]?.content.removedCount, 1);
});

test("reports default removals, provenance changes, and identical revisions", () => {
  const changed = diffPromptTemplateRevisions(
    revision({ externalImportId: "external-import_before", variableDefaults: { topic: "trees", audience: "experts" } }),
    revision({ externalImportId: "external-import_after", variableDefaults: { topic: "gardens" } }),
  );
  assert.deepEqual(changed.variableDefaults.map(({ name, status }) => [name, status]), [["audience", "removed"], ["topic", "changed"]]);
  assert.equal(changed.importProvenance.status, "changed");
  const identical = diffPromptTemplateRevisions(revision(), revision());
  assert.equal(identical.identical, true);
});

test("marks overlong content as a bounded whole-block replacement", () => {
  const long = Array.from({ length: 4_001 }, (_, index) => String(index)).join("\n");
  const result = diffPromptTemplateRevisions(revision({ messages: [{ role: "user", content: long }] }), revision());
  assert.equal(result.messages[0]?.content.truncated, true);
});
