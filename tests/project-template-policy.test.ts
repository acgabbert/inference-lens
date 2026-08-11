import assert from "node:assert/strict";
import test from "node:test";

import { createProjectFile, projectDraft } from "../packages/core/src/project.ts";
import {
  projectForTemplateMutation,
  templateRunOverridesAfterRevisionUpdate,
  templateRunOverridesAfterSave,
  templateRunOverridesAfterUpdate,
} from "../app/templates/project-template-policy.ts";

function project() {
  return createProjectFile({
    name: "Template mutation policy",
    request: {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      messages: [{ role: "user", content: "Original question" }],
    },
    idSuffix: "template-policy",
    createdAt: "2026-07-29T12:00:00.000Z",
  });
}

test("branches on the first template edit after an executed revision", () => {
  const source = project();
  const sourceRevision = source.defaults.conversationRevisionId;

  const result = projectForTemplateMutation({
    project: source,
    executedRevisionIds: new Set([sourceRevision]),
    runOverrides: {},
  });

  assert.notEqual(result.revisionId, sourceRevision);
  assert.equal(result.project.conversationRevisions.length, 2);
  assert.equal(result.project.defaults.conversationRevisionId, result.revisionId);
  const branch = result.project.conversationRevisions.find(
    ({ id }) => id === result.revisionId,
  )!;
  assert.equal(branch.parentRevisionId, sourceRevision);
  assert.deepEqual(projectDraft(result.project).messages, projectDraft(source).messages);
});

test("updates the current authored revision before it has executed", () => {
  const source = project();

  const result = projectForTemplateMutation({
    project: source,
    executedRevisionIds: new Set(),
    runOverrides: {},
  });

  assert.equal(result.project, source);
  assert.equal(result.revisionId, source.defaults.conversationRevisionId);
  assert.equal(result.project.conversationRevisions.length, 1);
});

test("keeps transient template overrides separate and removes saved empty overrides", () => {
  const initial = {
    "template-use_first": { topic: "before" },
    "template-use_second": { audience: "team" },
  };
  const updated = templateRunOverridesAfterUpdate(
    initial,
    "template-use_first",
    { topic: "after\nwith a newline" },
  );

  assert.deepEqual(updated, {
    "template-use_first": { topic: "after\nwith a newline" },
    "template-use_second": { audience: "team" },
  });
  assert.deepEqual(initial, {
    "template-use_first": { topic: "before" },
    "template-use_second": { audience: "team" },
  });
  assert.deepEqual(
    templateRunOverridesAfterSave(updated, "template-use_first", {}),
    { "template-use_second": { audience: "team" } },
  );
});

test("retains transient values declared by a newly pinned prompt and drops removed variables", () => {
  const initial = {
    "template-use_first": { topic: "database rollback", obsolete: "old value" },
    "template-use_second": { audience: "team" },
  };

  const updated = templateRunOverridesAfterRevisionUpdate(
    initial,
    "template-use_first",
    [{ role: "user", content: "Investigate {{topic}} for {{new_audience}}." }],
  );

  assert.deepEqual(updated, {
    "template-use_first": { topic: "database rollback" },
    "template-use_second": { audience: "team" },
  });
  assert.deepEqual(initial["template-use_first"], {
    topic: "database rollback",
    obsolete: "old value",
  });
});
