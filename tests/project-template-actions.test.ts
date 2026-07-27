import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  projectDraft,
  resolveProjectRevision,
} from "../packages/core/src/project.ts";
import {
  nextTemplateRunOverrides,
  projectTemplateMutationTarget,
  resolvedTemplateRequestPreview,
  updateAuthoredProjectItems,
} from "../app/project-template-actions.client.ts";

const request = {
  provider: "openai-compatible" as const,
  endpoint: "https://api.example.com/v1",
  model: "example-model",
  messages: [{ role: "user" as const, content: "Question" }],
};

function templateProject() {
  let project = createProjectFile({
    name: "Template policy",
    request,
    idSuffix: "template-policy",
    createdAt: "2026-07-26T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Topic",
    content: { kind: "fragment", text: "About {{topic}}" },
    variableDefaults: { topic: "default" },
    idSuffix: "topic",
    revisionIdSuffix: "topic-1",
    createdAt: "2026-07-26T12:00:01.000Z",
  });
  return insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_topic",
    fragmentRole: "user",
    idSuffix: "topic",
    outputMessageIdSuffixes: ["topic"],
  });
}

test("the first authored edit after execution creates one child revision", () => {
  const project = templateProject();
  const parent = project.defaults.conversationRevisionId;
  const first = projectTemplateMutationTarget({
    project,
    runOverrides: {},
    executedRevisionIds: new Set([parent]),
  });

  assert.equal(first.branched, true);
  assert.notEqual(first.revisionId, parent);
  assert.equal(first.project.conversationRevisions.length, 2);

  const later = projectTemplateMutationTarget({
    project: first.project,
    runOverrides: {},
    executedRevisionIds: new Set([parent]),
  });
  assert.equal(later.branched, false);
  assert.equal(later.revisionId, first.revisionId);
  assert.equal(later.project.conversationRevisions.length, 2);
});

test("run-only overrides update and clear without changing the project", () => {
  const useId = "template-use_topic" as const;
  const updated = nextTemplateRunOverrides({}, useId, { topic: "temporary" });
  assert.deepEqual(updated, { [useId]: { topic: "temporary" } });
  assert.deepEqual(nextTemplateRunOverrides(updated, useId), {});
  assert.deepEqual(updated, { [useId]: { topic: "temporary" } });
});

test("authored item updates retain template uses and the preview uses resolved messages", () => {
  const project = templateProject();
  const revision = project.conversationRevisions[0]!;
  const next = updateAuthoredProjectItems({
    project,
    revisionId: revision.id,
    draft: {
      ...request,
      messages: projectDraft(project).messages,
      tools: [],
      toolMocks: [],
      enabledToolIds: [],
    },
    items: [
      ...revision.items,
      {
        kind: "message",
        message: {
          id: "message_follow-up" as const,
          role: "user" as const,
          content: [{ type: "text" as const, text: "Follow up" }],
        },
      },
    ],
  });
  const active = next.conversationRevisions.find(
    ({ id }) => id === next.defaults.conversationRevisionId,
  )!;
  const resolution = resolveProjectRevision(next, active, {
    "template-use_topic": { topic: "overridden" },
  });
  const preview = resolvedTemplateRequestPreview({
    request: {
      ...request,
      messages: [{
        id: "message_stale" as const,
        role: "user",
        content: [{ type: "text", text: "stale" }],
      }],
    },
    resolution,
    conversationId: active.conversationId,
    conversationRevisionId: active.id,
    tools: [],
  });

  const resolvedTemplateMessage = resolution.messages.find((message) =>
    message.content.some((part) => part.type === "text" && part.text === "About overridden"),
  );
  assert.equal(resolvedTemplateMessage?.content[0]?.type, "text");
  assert.deepEqual(
    resolvedTemplateMessage?.content,
    [{ type: "text", text: "About overridden" }],
  );
  assert.ok("body" in preview);
  if ("body" in preview) {
    assert.deepEqual(preview.messages, resolution.messages);
    assert.match(JSON.stringify(preview.body), /About overridden/);
    assert.doesNotMatch(JSON.stringify(preview.body), /stale/);
  }
});
