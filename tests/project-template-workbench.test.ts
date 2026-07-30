import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectFile,
  projectDraft,
} from "../packages/core/src/project.ts";
import {
  pendingBranchMessagesAfterItemUpdate,
  projectTemplateWorkbenchView,
} from "../app/templates/project-template-workbench.client.ts";

const request = {
  provider: "openai-compatible" as const,
  endpoint: "https://api.example.com/v1",
  model: "example-model",
  messages: [
    { role: "system" as const, content: "System" },
    { role: "user" as const, content: "Question" },
  ],
};

function templateProject() {
  let project = createProjectFile({
    name: "Template workbench",
    request,
    idSuffix: "template-workbench",
    createdAt: "2026-07-26T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Prompt",
    content: { kind: "fragment", text: "Topic: {{topic}}" },
    variableDefaults: { topic: "default" },
    idSuffix: "prompt",
    revisionIdSuffix: "prompt-1",
    createdAt: "2026-07-26T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_prompt",
    fragmentRole: "user",
    idSuffix: "prompt",
    outputMessageIdSuffixes: ["prompt"],
  });
  return parseProjectFile(project);
}

test("derives a pending branch composer and preview from the same authored items", () => {
  const project = templateProject();
  const parent = project.conversationRevisions[0]!;
  const resolved = projectDraft(project, {
    "template-use_prompt": { topic: "override" },
  }).messages;
  const assistant = {
    id: "message_assistant" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Answer" }],
  };

  const view = projectTemplateWorkbenchView({
    project,
    messages: [...resolved, assistant],
    runOverrides: {
      "template-use_prompt": { topic: "override" },
    },
    branchParentRevisionId: parent.id,
  });

  assert.equal(view.resolutionError, undefined);
  assert.deepEqual(view.resolution?.messages, [...resolved, assistant]);
  assert.deepEqual(view.composerItems, [
    ...parent.items,
    { kind: "message", message: assistant },
  ]);
});

test("adds a message to a pending branch without dropping its assistant response", () => {
  const project = templateProject();
  const parent = project.conversationRevisions[0]!;
  const overrides = {
    "template-use_prompt": { topic: "override" },
  };
  const resolved = projectDraft(project, overrides).messages;
  const assistant = {
    id: "message_assistant" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Answer" }],
  };
  const followUp = {
    id: "message_follow-up" as const,
    role: "user" as const,
    content: [{ type: "text" as const, text: "" }],
  };

  const messages = pendingBranchMessagesAfterItemUpdate({
    project,
    messages: [...resolved, assistant],
    runOverrides: overrides,
    parentRevisionId: parent.id,
    update: (items) => [
      ...items,
      { kind: "message", message: followUp },
    ],
  });

  assert.deepEqual(messages, [...resolved, assistant, followUp]);
  assert.equal(project.conversationRevisions.length, 1);
  assert.deepEqual(projectDraft(project, overrides).messages, resolved);
});

test("contains project resolution failures instead of throwing during render", () => {
  const project = templateProject();

  const view = projectTemplateWorkbenchView({
    project,
    messages: projectDraft(project).messages,
    runOverrides: {
      "template-use_missing": { topic: "override" },
    },
  });

  assert.match(view.resolutionError ?? "", /unknown template use/);
  assert.equal(view.resolution, undefined);
});
