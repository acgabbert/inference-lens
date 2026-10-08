import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  setPromptTemplateRecommendedTarget,
} from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import type { PromptTemplateId } from "../packages/core/src/run-kernel/types.ts";
import { projectTemplateWorkbenchView } from "../app/templates/project-template-workbench.client.ts";
import {
  templateReadinessInputs,
  templateRequestPreview,
} from "../app/templates/template-run-view.ts";

const request = {
  provider: "openai-compatible" as const,
  endpoint: "https://api.example.com/v1",
  model: "project-model",
  messages: [],
};

function projectWithUses(
  uses: { suffix: string; content: string; values: Record<string, string>; model?: string }[],
): ProjectFile {
  let project = createProjectFile({
    name: "Template run view",
    request,
    idSuffix: "template-run-view",
    createdAt: "2026-10-08T12:00:00.000Z",
  });
  const requirementId = project.connectionRequirements[0]!.id;
  for (const { suffix, content, values, model } of uses) {
    const templateId = `template_${suffix}` as PromptTemplateId;
    project = createPromptTemplate(project, {
      name: `${suffix} prompt`,
      messages: [{ role: "user", content }],
      variableDefaults: {},
      idSuffix: suffix,
      revisionIdSuffix: `${suffix}-1`,
      createdAt: "2026-10-08T12:00:01.000Z",
    });
    if (model) {
      project = setPromptTemplateRecommendedTarget(project, templateId, {
        connectionRequirementId: requirementId,
        model,
      });
    }
    project = insertPromptTemplateUse(project, {
      conversationRevisionId: project.conversationRevisions[0]!.id,
      templateId,
      values,
      idSuffix: suffix,
      outputMessageIdSuffixes: [suffix],
    });
  }
  return project;
}

function viewOf(project: ProjectFile | null) {
  return projectTemplateWorkbenchView({ project, messages: [], runOverrides: {} });
}

function activeRevision(project: ProjectFile) {
  return project.conversationRevisions.find(
    ({ id }) => id === project.defaults.conversationRevisionId,
  );
}

test("readiness inputs name each pinned prompt's recommended target", () => {
  const project = projectWithUses([
    { suffix: "triage", content: "Triage {{topic}}.", values: { topic: "it" }, model: "triage-model" },
    { suffix: "plain", content: "Plain.", values: {} },
  ]);
  const inputs = templateReadinessInputs(project, viewOf(project));
  assert.deepEqual(inputs.templateTargets, [
    {
      templateName: "triage prompt",
      connectionRequirementId: project.connectionRequirements[0]!.id,
      connectionRequirementName: project.connectionRequirements[0]!.name,
      model: "triage-model",
    },
  ]);
  assert.deepEqual(inputs.templateIssues, []);
  assert.equal("templateResolutionError" in inputs, false);
});

test("readiness inputs report one issue per missing variable, keyed by its use", () => {
  const project = projectWithUses([
    { suffix: "triage", content: "Triage {{topic}} for {{team}}.", values: { topic: "it" } },
  ]);
  const inputs = templateReadinessInputs(project, viewOf(project));
  assert.deepEqual(inputs.templateIssues, [
    { templateUseId: "template-use_triage", variableName: "team" },
  ]);
});

test("readiness inputs carry a resolution error and are empty without a project", () => {
  assert.deepEqual(
    templateReadinessInputs(null, viewOf(null)),
    { templateIssues: [], templateTargets: [] },
  );
  const project = projectWithUses([]);
  assert.deepEqual(
    templateReadinessInputs(project, { composerItems: [], resolutionError: "Broken." }),
    { templateResolutionError: "Broken.", templateIssues: [], templateTargets: [] },
  );
});

test("the request preview resolves pinned prompts into the provider body", () => {
  const project = projectWithUses([
    { suffix: "triage", content: "Triage {{topic}}.", values: { topic: "the rollback" } },
  ]);
  const view = viewOf(project);
  const preview = templateRequestPreview({
    project,
    revision: activeRevision(project),
    view,
    request: { ...request, messages: [] },
    tools: [],
  });
  assert.ok(preview && !("error" in preview));
  assert.deepEqual(
    preview.messages.map(({ content }) => content),
    [[{ type: "text", text: "Triage the rollback." }]],
  );
  const body = preview.body as { model: string; messages: { content: string }[] };
  assert.equal(body.model, "project-model");
  assert.equal(body.messages.at(-1)?.content, "Triage the rollback.");
});

test("the request preview is absent without a project and reports resolution errors", () => {
  assert.equal(
    templateRequestPreview({ project: null, view: viewOf(null), request, tools: [] }),
    undefined,
  );
  const project = projectWithUses([]);
  assert.deepEqual(
    templateRequestPreview({
      project,
      revision: activeRevision(project),
      view: { composerItems: [], resolutionError: "Broken." },
      request,
      tools: [],
    }),
    { error: "Broken." },
  );
});

test("the request preview is the body of the run's own protocol", () => {
  const project = projectWithUses([
    { suffix: "triage", content: "Triage {{topic}}.", values: { topic: "the rollback" } },
  ]);
  const preview = templateRequestPreview({
    project,
    revision: activeRevision(project),
    view: viewOf(project),
    request: {
      ...request,
      protocol: "openai-responses",
      capabilities: {
        chatCompletions: false,
        responsesApi: true,
        anthropicMessages: false,
        streaming: true,
        modelDiscovery: true,
        tools: false,
        parallelToolCalls: false,
        structuredOutput: false,
        vision: false,
        embeddings: false,
      },
      messages: [],
    },
    tools: [],
  });
  assert.ok(preview && !("error" in preview));
  const body = preview.body as { input?: { content: string }[]; messages?: unknown };
  assert.equal(body.messages, undefined);
  assert.equal(body.input?.at(-1)?.content, "Triage the rollback.");
});
