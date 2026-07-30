import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  projectDraft,
} from "../packages/core/src/project.ts";
import type { ToolDefinition } from "../packages/core/src/run-kernel/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import { prepareWorkbenchRun } from "../app/run/prepare-workbench-run.client.ts";

const request = {
  provider: "openai-compatible" as const,
  endpoint: "https://api.example.com/v1",
  model: "example-model",
  messages: [{ id: "message_question" as const, role: "user" as const, content: [{ type: "text" as const, text: "Question" }] }],
  temperature: 0.7,
  responseMode: "streaming" as const,
  capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
};

const tool = (name: string): ToolDefinition => ({
  id: `tool_${name}`,
  name,
  inputSchema: {},
});

function prepare(overrides: Partial<Parameters<typeof prepareWorkbenchRun>[0]> = {}) {
  return prepareWorkbenchRun({
    request,
    projectTools: [],
    requestTools: [],
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    profileName: "Example profile",
    templateRunOverrides: {},
    ...overrides,
  });
}

function templateProject() {
  let project = createProjectFile({ name: "Templates", request, idSuffix: "templates" });
  project = createPromptTemplate(project, {
    name: "Topic",
    content: { kind: "fragment", text: "Topic: {{topic}}" },
    variableDefaults: { topic: "default" },
    idSuffix: "topic",
    revisionIdSuffix: "topic-1",
  });
  return insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_topic",
    fragmentRole: "user",
    idSuffix: "topic",
    outputMessageIdSuffixes: ["topic"],
  });
}

test("prepares ordinary ad-hoc streaming and buffered runs with a stable conversation", () => {
  const first = prepare();
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.input.responseMode, "streaming");
  assert.ok(first.adHocConversationId);

  const buffered = prepare({
    adHocConversationId: first.adHocConversationId,
    request: { ...request, responseMode: "buffered" },
  });
  assert.equal(buffered.ok, true);
  if (!buffered.ok) return;
  assert.equal(buffered.input.responseMode, "buffered");
  assert.equal(buffered.input.conversationId, first.input.conversationId);
});

test("returns tool validation and distinct tools-disabled failures", () => {
  const unnamed = prepare({ requestTools: [tool("")] });
  assert.equal(unnamed.ok, false);
  if (!unnamed.ok) assert.match(unnamed.message, /needs a name/);
  const duplicate = prepare({ projectTools: [tool("same")], requestTools: [tool("same")] });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.message, /More than one/);
  const result = prepare({
    requestTools: [tool("lookup")],
    capabilities: { ...OPENAI_COMPATIBLE_CAPABILITIES, tools: false },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorKind, "tools-disabled");
});

test("proposes, but does not adopt, a project branch", () => {
  const project = createProjectFile({ name: "Branch", request, idSuffix: "branch" });
  const before = structuredClone(project);
  const parent = project.defaults.conversationRevisionId;
  const result = prepare({
    project,
    branchContext: {
      parentRunId: "run_parent",
      parentConversationRevisionId: parent,
      branchMessageId: "message_question",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(project.conversationRevisions.length, 1);
  assert.deepEqual(project, before);
  assert.equal(result.projectMutation?.conversationRevisions.length, 2);
  assert.equal(result.executedRevisionId, result.input.conversationRevisionId);
  assert.equal(result.consumesPendingBranch, true);
});

test("keeps every supplied snapshot unchanged on failed branch and template preparation", () => {
  const project = templateProject();
  const snapshots = {
    project,
    request: { ...request, messages: projectDraft(project).messages },
    templateRunOverrides: {},
  };
  const before = structuredClone(snapshots);
  const missingParent = prepare({
    ...snapshots,
    branchContext: { parentRunId: "run_parent", branchMessageId: "message_topic" },
  });
  assert.equal(missingParent.ok, false);
  const mismatch = prepare({
    ...snapshots,
    request: request,
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.match(mismatch.message, /generated messages/);
  assert.deepEqual(snapshots, before);
});

test("resolves template-backed default revisions and reports invalid template values", () => {
  const project = templateProject();
  const resolved = projectDraft(project, { "template-use_topic": { topic: "override" } }).messages;
  const success = prepare({
    project,
    request: { ...request, messages: resolved },
    templateRunOverrides: { "template-use_topic": { topic: "override" } },
  });
  assert.equal(success.ok, true);
  if (!success.ok) return;
  assert.equal(success.input.templateResolutions[0]?.values.topic, "override");

  const failure = prepare({
    project,
    request: { ...request, messages: resolved },
    templateRunOverrides: { "template-use_missing": { topic: "missing" } },
  });
  assert.equal(failure.ok, false);
});
