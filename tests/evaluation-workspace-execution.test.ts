import assert from "node:assert/strict";
import test from "node:test";

import { evaluationWorkspaceExecution } from "../app/evaluations/evaluation-start.client.ts";
import type { EvaluationWorkspaceExecutionInput } from "../app/evaluations/evaluation-start.client.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectFile,
} from "../packages/core/src/project.ts";
import type { ConversationRevisionId, ToolDefinition } from "../packages/core/src/run-kernel/types.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const weatherTool: ToolDefinition = {
  id: "tool_weather",
  name: "get_weather",
  inputSchema: { type: "object", properties: {} },
};

function projectFixture(toolIds: string[] = []) {
  let project = createProjectFile({
    name: "Evaluation workspace",
    idSuffix: "evaluation-workspace",
    createdAt: "2026-10-08T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "https://provider.example.test/v1",
      model: "authored-model",
      messages: [{ role: "system", content: "System context" }],
    },
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    variableDefaults: {},
    idSuffix: "question",
    revisionIdSuffix: "question-1",
    createdAt: "2026-10-08T12:00:01.000Z",
  });
  const revisionId = project.defaults.conversationRevisionId;
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: revisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
    outputMessageIdSuffixes: ["question-output"],
  });
  return parseProjectFile({
    ...project,
    tools: [weatherTool],
    evaluationSuites: [{
      id: "evaluation-suite_topics",
      name: "Topics",
      input: { kind: "conversation-revision", conversationRevisionId: revisionId },
      execution: {
        target: { ...project.defaults.target },
        responseMode: "streaming",
        options: { temperature: 0.2 },
        repetitions: 3,
        toolIds,
      },
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
      inputBindings: [{
        id: "evaluation-input_topic",
        name: "Topic",
        target: { kind: "template-variable", templateUseId: "template-use_question-use", variableName: "topic" },
      }],
      cases: [{
        id: "evaluation-case_migrations",
        name: "Migrations",
        values: { "evaluation-input_topic": "database migrations" },
        checks: [],
      }],
    }],
  });
}


function readyInput(project = projectFixture()): EvaluationWorkspaceExecutionInput {
  return {
    project,
    suiteId: "evaluation-suite_topics",
    revisionId: project.defaults.conversationRevisionId,
    diagnostics: [],
    selectedCaseCount: 1,
    selectedVariantIds: ["evaluation-variant_default"],
    profiles: [{
      id: "profile-1",
      name: "Fixture profile",
      endpoint: "https://provider.example.test/v1",
      capabilities: { ...OPENAI_COMPATIBLE_CAPABILITIES, tools: true },
    }],
    mappedProfileIds: { [project.defaults.target.connectionRequirementId]: "profile-1" },
    toolBindings: [],
    activityInProgress: false,
  };
}

test("a ready workspace resolves each selected configuration into the preview both panes read", () => {
  const execution = evaluationWorkspaceExecution(readyInput());
  assert.equal(execution.disabledReason, undefined);
  assert.deepEqual(execution.targets.map(({ variantId, model }) => ({ variantId, model })), [
    { variantId: "evaluation-variant_default", model: "authored-model" },
  ]);
  assert.deepEqual(execution.previewTargets, [{
    variantId: "evaluation-variant_default",
    variantName: "Default",
    requirementName: execution.targets[0]!.requirementName,
    targetName: "Fixture profile",
    endpoint: "https://provider.example.test/v1",
    protocol: "openai-compatible-chat-completions",
    model: "authored-model",
    responseMode: "streaming",
    options: { temperature: 0.2 },
    streamingAvailable: true,
  }]);
});

test("without an open project nothing resolves and the start gate names the missing project", () => {
  const execution = evaluationWorkspaceExecution({ ...readyInput(), project: null });
  assert.deepEqual(execution, {
    targets: [],
    previewTargets: [],
    disabledReason: "Open or save a project first.",
  });
});

test("an unmapped configuration previews without a target and blocks the start", () => {
  const execution = evaluationWorkspaceExecution({ ...readyInput(), mappedProfileIds: {} });
  const [preview] = execution.previewTargets;
  assert.equal(preview?.targetName, undefined);
  assert.equal(preview?.endpoint, undefined);
  assert.equal(preview?.streamingAvailable, false);
  assert.match(execution.disabledReason ?? "", /^Map “.+” to a local profile for configuration “Default”\.$/);
});

test("a revision that no longer exists blocks the start", () => {
  const execution = evaluationWorkspaceExecution({
    ...readyInput(),
    revisionId: "revision_gone" as ConversationRevisionId,
  });
  assert.equal(execution.disabledReason, "The selected conversation revision no longer exists.");
});

test("only the tools the suite exposes are checked for a binding on this device", () => {
  const unboundWeather = [{ tool: weatherTool }];
  assert.equal(
    evaluationWorkspaceExecution({ ...readyInput(), toolBindings: unboundWeather }).disabledReason,
    undefined,
  );
  assert.equal(
    evaluationWorkspaceExecution({
      ...readyInput(projectFixture(["tool_weather"])),
      toolBindings: unboundWeather,
      commandToolsUnavailableReason: "Command tools need the desktop app.",
    }).disabledReason,
    "This suite exposes get_weather, and nothing on this device can serve it. Enable a mock or grant a command tool first. Command tools need the desktop app.",
  );
});

test("the suite's own repetitions feed the batch guardrail", () => {
  const project = projectFixture();
  project.evaluationSuites[0]!.execution.repetitions = 1_000;
  const execution = evaluationWorkspaceExecution({ ...readyInput(project), selectedCaseCount: 1_000 });
  assert.ok(execution.disabledReason, "a thousand cases at a thousand repetitions must be refused");
  assert.equal(
    evaluationWorkspaceExecution(readyInput()).disabledReason,
    undefined,
  );
});

test("other activity in progress blocks the start after every authoring gate passes", () => {
  assert.equal(
    evaluationWorkspaceExecution({ ...readyInput(), activityInProgress: true }).disabledReason,
    "Finish or stop the current run first.",
  );
});
