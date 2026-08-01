import assert from "node:assert/strict";
import test from "node:test";

import {
  addEvaluationCase,
  addEvaluationCheck,
  addEvaluationInput,
  createEvaluationSuite,
  evaluationBindingCandidates,
  evaluationSuitePreflight,
  removeEvaluationInput,
  updateEvaluationCase,
} from "../packages/core/src/evaluation-suite-authoring.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
} from "../packages/core/src/project.ts";

function fixture() {
  let project = createProjectFile({
    name: "Evaluation authoring",
    idSuffix: "evaluation-authoring",
    createdAt: "2026-08-01T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "http://localhost:4010/v1/chat/completions",
      model: "fixture",
      messages: [{ role: "user", content: "Hello" }],
    },
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}} to {{audience}}." }],
    idSuffix: "question",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });
  return project;
}

test("authors complete suite inputs, cases, and globally fresh checks", () => {
  let project = fixture();
  const revisionId = project.defaults.conversationRevisionId;
  const candidates = evaluationBindingCandidates(project, revisionId);
  assert.deepEqual(candidates.map(({ variableName }) => variableName), ["topic", "audience"]);

  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  const input = addEvaluationInput(project, created.suiteId, candidates[0]!, () => "topic");
  project = input.project;
  const addedCase = addEvaluationCase(project, created.suiteId, () => "first");
  project = updateEvaluationCase(addedCase.project, created.suiteId, addedCase.caseId, {
    name: "Migrations",
    values: { [input.inputId]: "database migrations" },
  });
  project = addEvaluationCheck(project, created.suiteId, addedCase.caseId, "contains", () => "mentions-migrations");
  project = updateEvaluationCase(project, created.suiteId, addedCase.caseId, {
    referenceAnswer: "Use a reversible rollout.",
  });
  project = updateEvaluationCase(project, created.suiteId, addedCase.caseId, {
    name: "Safe migrations",
  });

  assert.equal(project.evaluationSuites[0]?.cases[0]?.values[input.inputId], "database migrations");
  assert.equal(project.evaluationSuites[0]?.cases[0]?.referenceAnswer, "Use a reversible rollout.");
  assert.equal(project.evaluationSuites[0]?.cases[0]?.checks[0]?.checkId, "check_mentions-migrations");
  assert.deepEqual(evaluationSuitePreflight(project, created.suiteId, revisionId), []);

  project = removeEvaluationInput(project, created.suiteId, input.inputId);
  assert.deepEqual(project.evaluationSuites[0]?.cases[0]?.values, {});
});

test("preflight distinguishes empty selection from incompatible revisions", () => {
  let project = fixture();
  const revisionId = project.defaults.conversationRevisionId;
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  assert.deepEqual(
    evaluationSuitePreflight(project, created.suiteId, revisionId).map(({ code }) => code),
    ["empty-suite"],
  );
  const addedCase = addEvaluationCase(project, created.suiteId, () => "first");
  assert.deepEqual(
    evaluationSuitePreflight(addedCase.project, created.suiteId, revisionId, []).map(({ code }) => code),
    ["no-cases-selected"],
  );
});
