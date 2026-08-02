import assert from "node:assert/strict";
import test from "node:test";

import { promptTargetAdvisories } from "../packages/core/src/prompt-target-advisory.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  setPromptTemplateRecommendedTarget,
} from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";

function fixture(): ProjectFile {
  let project = createProjectFile({
    name: "Advisories",
    idSuffix: "advisory",
    createdAt: "2026-08-01T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "http://localhost:4010/v1/chat/completions",
      model: "target-model",
      messages: [{ role: "user", content: "Hello" }],
    },
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "question",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Safety policy",
    messages: [{ role: "system", content: "Be careful." }],
    idSuffix: "safety",
    createdAt: "2026-08-01T12:00:02.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_safety",
    idSuffix: "safety-use",
  });
  return insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    idSuffix: "question-use",
  });
}

function recommend(project: ProjectFile, templateId: string, model: string): ProjectFile {
  return setPromptTemplateRecommendedTarget(project, templateId as never, {
    connectionRequirementId: project.defaults.target.connectionRequirementId,
    model,
  });
}

test("reports nothing to say when no template carries a recommendation", () => {
  const project = fixture();

  const advisories = promptTargetAdvisories(
    project,
    project.conversationRevisions[0]!,
    { model: "target-model" },
  );

  assert.deepEqual(advisories, { recommendations: [], differing: [], recommendedModels: [] });
});

test("stays silent when the recommendation matches the target the evaluation sends", () => {
  const project = recommend(fixture(), "template_question", "target-model");

  const advisories = promptTargetAdvisories(
    project,
    project.conversationRevisions[0]!,
    { model: "target-model" },
  );

  assert.equal(advisories.recommendations.length, 1);
  assert.deepEqual(advisories.differing, []);
  assert.deepEqual(advisories.recommendedModels, ["target-model"]);
});

test("names the template and its connection when a recommendation disagrees", () => {
  const project = recommend(fixture(), "template_question", "authored-against-model");

  const advisories = promptTargetAdvisories(
    project,
    project.conversationRevisions[0]!,
    { model: "target-model" },
  );

  assert.deepEqual(
    advisories.differing.map(({ templateName, model, connectionName }) =>
      [templateName, model, connectionName].join(" | "),
    ),
    ["Question | authored-against-model | Default connection"],
  );
});

test("reports two prompts recommending different models as a conflict no target can settle", () => {
  let project = recommend(fixture(), "template_safety", "safety-model");
  project = recommend(project, "template_question", "question-model");

  const advisories = promptTargetAdvisories(
    project,
    project.conversationRevisions[0]!,
    { model: "safety-model" },
  );

  // Authored order, not template order: the revision is what the author reads.
  assert.deepEqual(advisories.recommendedModels, ["safety-model", "question-model"]);
  assert.deepEqual(advisories.differing.map(({ templateName }) => templateName), ["Question"]);
});

test("keeps two uses of one recommending template distinct", () => {
  const project = recommend(fixture(), "template_question", "authored-against-model");
  const withSecondUse = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    idSuffix: "second-question-use",
  });

  const advisories = promptTargetAdvisories(
    withSecondUse,
    withSecondUse.conversationRevisions[0]!,
    { model: "target-model" },
  );

  assert.deepEqual(
    advisories.differing.map(({ templateUseId }) => templateUseId),
    ["template-use_question-use", "template-use_second-question-use"],
  );
  // One model is recommended twice, so the prompts do not disagree with
  // each other — only with the target.
  assert.deepEqual(advisories.recommendedModels, ["authored-against-model"]);
});
