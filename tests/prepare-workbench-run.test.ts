import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  resolveProjectRevision,
} from "../packages/core/src/project.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";
import { createEntityId } from "../packages/core/src/run-kernel/index.ts";
import type { ToolDefinition } from "../packages/core/src/run-kernel/index.ts";
import {
  prepareWorkbenchRun,
} from "../app/prepare-workbench-run.client.ts";
import type { PrepareWorkbenchRunInput } from "../app/prepare-workbench-run.client.ts";

const parentRunId = createEntityId("run", "source");

const baseRequest = {
  provider: "openai-compatible" as const,
  endpoint: "https://api.example.com/v1",
  model: "example-model",
  messages: [{ role: "user" as const, content: "Question" }],
};

const richMessages = [
  {
    id: createEntityId("message", "question"),
    role: "user" as const,
    content: [{ type: "text" as const, text: "Question" }],
  },
];

const activeProfile = { id: "profile-1", name: "Test profile" };

function baseInput(
  overrides: Partial<PrepareWorkbenchRunInput> = {},
): PrepareWorkbenchRunInput {
  return {
    request: { ...baseRequest, messages: structuredClone(richMessages) },
    resolvedTools: [],
    requestTools: [],
    activeCapabilities: resolveProviderCapabilities("openai-compatible"),
    activeProfile,
    runOverrides: {},
    adHocConversationId: null,
    ...overrides,
  };
}

function tool(name: string): ToolDefinition {
  return { id: `tool_${name}` as ToolDefinition["id"], name, inputSchema: {} };
}

function templateProject(variableDefaults: Record<string, string> = { topic: "default" }) {
  let project = createProjectFile({
    name: "Prepare workbench run",
    request: baseRequest,
    idSuffix: "prepare-run",
    createdAt: "2026-07-27T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Topic",
    content: { kind: "fragment", text: "About {{topic}}" },
    variableDefaults,
    idSuffix: "topic",
    revisionIdSuffix: "topic-1",
    createdAt: "2026-07-27T12:00:01.000Z",
  });
  return insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_topic",
    fragmentRole: "user",
    idSuffix: "topic",
    outputMessageIdSuffixes: ["topic"],
  });
}

test("a blank tool name fails preparation", () => {
  const result = prepareWorkbenchRun(
    baseInput({ requestTools: [tool("  ")] }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, "Every attached tool needs a name.");
    assert.equal(result.errorKind, undefined);
  }
});

test("duplicate tool names fail preparation", () => {
  const result = prepareWorkbenchRun(
    baseInput({ requestTools: [tool("search"), tool("search")] }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /More than one attached tool is named "search"/);
  }
});

test("selecting tools against a tools-disabled capability reports the tools-disabled error kind", () => {
  const result = prepareWorkbenchRun(
    baseInput({ requestTools: [tool("search")] }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorKind, "tools-disabled");
    assert.match(result.message, /1 selected tool/);
    assert.match(result.message, /"Test profile"/);
  }
});

test("an ad hoc run without a project mints and then reuses a conversation id", () => {
  const first = prepareWorkbenchRun(baseInput());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.ok(first.adHocConversationId);
  assert.equal(first.executedRevisionId, undefined);
  assert.equal(first.projectMutation, undefined);

  const second = prepareWorkbenchRun(
    baseInput({ adHocConversationId: first.adHocConversationId }),
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.input.conversationId, first.input.conversationId);
  assert.notEqual(
    second.input.conversationRevisionId,
    first.input.conversationRevisionId,
  );
});

test("an ordinary project revision resolves its template use into the run input", () => {
  const project = templateProject();
  const revision = project.conversationRevisions[0]!;
  const result = prepareWorkbenchRun(
    baseInput({
      projectFile: project,
      mappedProfileId: "profile-1",
      request: {
        ...baseRequest,
        messages: resolveProjectRevision(project, revision, {}).messages,
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.executedRevisionId, revision.id);
  assert.equal(result.projectMutation, undefined);
  assert.equal(result.input.templateResolutions.length, 1);
  const rendered = result.input.messages.find((message) =>
    message.content.some((part) => part.type === "text" && part.text === "About default"),
  );
  assert.ok(rendered);
});

test("branch preparation with a valid parent revision produces a project mutation and branch provenance", () => {
  const project = templateProject();
  const revision = project.conversationRevisions[0]!;
  const result = prepareWorkbenchRun(
    baseInput({
      projectFile: project,
      mappedProfileId: "profile-1",
      request: {
        ...baseRequest,
        messages: resolveProjectRevision(project, revision, {}).messages,
      },
      branchContext: {
        parentRunId,
        parentConversationRevisionId: revision.id,
        branchMessageId: resolveProjectRevision(project, revision, {}).messages[0]!.id,
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.projectMutation);
  assert.equal(result.projectMutation?.conversationRevisions.length, 2);
  assert.equal(result.consumesPendingBranch, true);
  assert.deepEqual(result.branchedFrom, {
    runId: parentRunId,
    parentConversationRevisionId: revision.id,
    messageId: resolveProjectRevision(project, revision, {}).messages[0]!.id,
  });
  assert.equal(
    result.executedRevisionId,
    result.projectMutation?.defaults.conversationRevisionId,
  );
  // The original project passed in is untouched by branch creation.
  assert.equal(project.conversationRevisions.length, 1);
});

test("branch preparation without a resolvable parent revision fails without mutating the project", () => {
  const project = templateProject();
  const revision = project.conversationRevisions[0]!;

  const branchMessageId = createEntityId("message", "x");

  const missingParentId = prepareWorkbenchRun(
    baseInput({
      projectFile: project,
      mappedProfileId: "profile-1",
      branchContext: {
        parentRunId,
        branchMessageId,
      },
    }),
  );
  assert.equal(missingParentId.ok, false);
  if (!missingParentId.ok) {
    assert.match(missingParentId.message, /missing its parent revision/);
  }

  const unknownParent = prepareWorkbenchRun(
    baseInput({
      projectFile: project,
      mappedProfileId: "profile-1",
      branchContext: {
        parentRunId,
        parentConversationRevisionId: createEntityId("revision", "does-not-exist"),
        branchMessageId,
      },
    }),
  );
  assert.equal(unknownParent.ok, false);
  if (!unknownParent.ok) {
    assert.match(unknownParent.message, /parent revision is no longer in this project/);
  }
  assert.equal(project.conversationRevisions.length, 1);
  assert.equal(project.defaults.conversationRevisionId, revision.id);
});

test("run-only overrides survive branch preparation", () => {
  const project = templateProject();
  const revision = project.conversationRevisions[0]!;
  const overrides = { "template-use_topic": { topic: "overridden" } };
  const resolvedMessages = resolveProjectRevision(project, revision, overrides).messages;

  const result = prepareWorkbenchRun(
    baseInput({
      projectFile: project,
      mappedProfileId: "profile-1",
      runOverrides: overrides,
      request: { ...baseRequest, messages: resolvedMessages },
      branchContext: {
        parentRunId,
        parentConversationRevisionId: revision.id,
        branchMessageId: resolvedMessages[0]!.id,
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const rendered = result.input.messages.find((message) =>
    message.content.some((part) => part.type === "text" && part.text === "About overridden"),
  );
  assert.ok(rendered);
  assert.equal(result.input.templateResolutions[0]?.values.topic, "overridden");
});

test("unresolved template diagnostics block preparation without a project mutation", () => {
  const project = templateProject({});
  const revision = project.conversationRevisions[0]!;
  const result = prepareWorkbenchRun(
    baseInput({
      projectFile: project,
      mappedProfileId: "profile-1",
      request: {
        ...baseRequest,
        messages: resolveProjectRevision(project, revision, {}).messages,
      },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /Cannot run template use/);
  }
  assert.equal(project.conversationRevisions.length, 1);
});

test("a manually edited template-backed conversation fails preparation instead of running", () => {
  const project = templateProject();
  const revision = project.conversationRevisions[0]!;
  const editedMessages = resolveProjectRevision(project, revision, {}).messages.map(
    (message) => ({
      ...message,
      content: [{ type: "text" as const, text: "Hand edited" }],
    }),
  );
  const result = prepareWorkbenchRun(
    baseInput({
      projectFile: project,
      mappedProfileId: "profile-1",
      request: { ...baseRequest, messages: editedMessages },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /differs from its generated messages/);
  }
});
