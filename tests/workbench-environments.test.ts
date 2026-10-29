import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectEnvironment } from "../packages/core/src/environment.ts";
import {
  createBranchRevision,
  createProjectFile,
  createPromptTemplate,
  detachPromptTemplateUse,
  insertPromptTemplateUse,
  parseProjectFile,
  projectDraft,
} from "../packages/core/src/project.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import { prepareWorkbenchRun } from "../app/run/prepare-workbench-run.client.ts";
import { projectForTemplateMutation } from "../app/templates/project-template-policy.ts";
import { projectTemplateWorkbenchView } from "../app/templates/project-template-workbench.client.ts";

const request = {
  provider: "openai-compatible" as const,
  endpoint: "https://api.example.com/v1",
  model: "example-model",
  messages: [{ role: "user" as const, content: "Question" }],
  capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
};

const staging: ProjectEnvironment = {
  id: "environment_staging",
  name: "Staging",
  entries: [
    { name: "customer", value: "Acme" },
    { name: "greeting", value: "Hello {{customer}}" },
  ],
};

function environmentProject() {
  let project = createProjectFile({
    name: "Workbench environments",
    request,
    idSuffix: "workbench-environments",
    createdAt: "2026-10-29T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Greeting",
    messages: [{ role: "user", content: "{{greeting}} about {{topic}}" }],
    variableDefaults: { topic: "billing" },
    idSuffix: "greeting",
    revisionIdSuffix: "greeting-1",
    createdAt: "2026-10-29T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_greeting",
    idSuffix: "greeting",
    outputMessageIdSuffixes: ["greeting"],
  });
  return parseProjectFile({ ...project, environments: [staging] });
}

const assistant = {
  id: "message_assistant" as const,
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "Answer" }],
};

type Message = { id: string; content: Array<{ type: string; text?: string }> };

/** The text the greeting use rendered; the project's own first message precedes it. */
function greeting(messages: readonly Message[]): string | undefined {
  return messages.find(({ id }) => id === "message_greeting")?.content
    .map((part) => part.text ?? "").join("");
}

test("the project draft renders against the environment in its context", () => {
  const project = environmentProject();
  const draft = projectDraft(project, { environment: staging });
  assert.equal(greeting(draft.messages), "Hello Acme about billing");
  assert.deepEqual(draft.templateResolutions[0]?.valueSources, {
    topic: "template-default",
    greeting: "environment",
  });
});

test("a pending branch rendered with an environment matches its parent", () => {
  const project = environmentProject();
  const parent = project.conversationRevisions[0]!;
  const context = { environment: staging };
  const rendered = projectDraft(project, context).messages;

  const view = projectTemplateWorkbenchView({
    project,
    messages: [...rendered, assistant],
    resolutionContext: context,
    branchParentRevisionId: parent.id,
  });
  assert.equal(view.resolutionError, undefined);
  assert.deepEqual(view.resolution?.messages, [...rendered, assistant]);

  const branched = createBranchRevision(project, {
    conversationId: parent.conversationId,
    parentRevisionId: parent.id,
    messages: [...rendered, assistant],
    resolutionContext: context,
  });
  assert.deepEqual(branched.conversationRevisions.at(-1)?.items, [
    ...parent.items,
    { kind: "message", message: assistant },
  ]);
});

test("branching an executed revision keeps the environment-rendered messages", () => {
  const project = environmentProject();
  const { project: branched } = projectForTemplateMutation({
    project,
    executedRevisionIds: new Set([project.defaults.conversationRevisionId]),
    resolutionContext: { environment: staging },
  });
  assert.equal(branched.conversationRevisions.length, 2);
  assert.equal(
    greeting(projectDraft(branched, { environment: staging }).messages),
    "Hello Acme about billing",
  );
});

test("detaching a use bakes in the environment value it rendered", () => {
  const project = environmentProject();
  const detached = detachPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateUseId: "template-use_greeting",
    resolutionContext: { environment: staging },
  });
  const messages = detached.conversationRevisions.at(-1)!.items.flatMap((item) =>
    item.kind === "message" ? [item.message] : []);
  assert.equal(greeting(messages), "Hello Acme about billing");
});

test("a workbench run records the environment it rendered against", () => {
  const project = environmentProject();
  const context = { environment: staging };
  const result = prepareWorkbenchRun({
    request: { ...request, messages: projectDraft(project, context).messages },
    project,
    projectTools: [],
    requestTools: [],
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    profileName: "Example profile",
    resolutionContext: context,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.environment, {
    environmentId: "environment_staging",
    name: "Staging",
    consumed: { greeting: "Hello Acme" },
  });
  assert.equal(result.input.templateResolutions[0]?.valueSources?.greeting, "environment");
});

test("a workbench run is refused when a consumed entry is unfinished", () => {
  const unfinished: ProjectEnvironment = {
    ...staging,
    entries: [{ name: "greeting", value: "Hello {{customer}}" }],
  };
  const project = parseProjectFile({ ...environmentProject(), environments: [unfinished] });
  const context = { environment: unfinished };
  const result = prepareWorkbenchRun({
    request: { ...request, messages: projectDraft(project, context).messages },
    project,
    projectTools: [],
    requestTools: [],
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    profileName: "Example profile",
    resolutionContext: context,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /Staging.*customer/);
});
