import assert from "node:assert/strict";
import test from "node:test";

import { resolveEvaluationCase } from "../packages/core/src/evaluation-case-resolution.ts";
import { createEvaluationExperimentPlan } from "../packages/core/src/evaluation-execution.ts";
import {
  addEvaluationCase,
  addEvaluationInput,
  createEvaluationSuite,
  evaluationBindingCandidates,
  updateEvaluationCase,
} from "../packages/core/src/evaluation-suite-authoring.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  updatePromptTemplateUseValues,
} from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import type { EvaluationSuite } from "../packages/core/src/evaluation-suites.ts";

/**
 * Two uses of one template plus a second multi-message template, so precedence
 * and provenance can be checked where a template ID alone is ambiguous.
 */
function fixture(): ProjectFile {
  let project = createProjectFile({
    name: "Case resolution",
    idSuffix: "resolution",
    createdAt: "2026-08-01T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "http://localhost:4010/v1/chat/completions",
      model: "fixture",
      messages: [{ role: "system", content: "Be concise." }],
    },
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}} to {{audience}}." }],
    variableDefaults: { audience: "engineers", topic: "a default topic" },
    idSuffix: "question",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Safety policy",
    messages: [
      { role: "system", content: "Enforce {{policy}}." },
      { role: "user", content: "Now answer as {{persona}}." },
    ],
    variableDefaults: { policy: "the default policy" },
    idSuffix: "safety",
    createdAt: "2026-08-01T12:00:02.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_safety",
    idSuffix: "safety-use",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    idSuffix: "first-question",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    idSuffix: "second-question",
  });
  // An authored use value that must beat the template default but lose to a case.
  project = updatePromptTemplateUseValues(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateUseId: "template-use_first-question",
    values: { audience: "auditors", topic: "an authored topic" },
  });
  return updatePromptTemplateUseValues(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateUseId: "template-use_safety-use",
    values: { persona: "a reviewer" },
  });
}

function suiteBoundTo(
  project: ProjectFile,
  targets: readonly { templateUseId: string; variableName: string }[],
): { project: ProjectFile; suite: EvaluationSuite; inputIds: string[] } {
  const candidates = evaluationBindingCandidates(project, project.defaults.conversationRevisionId);
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  let next = created.project;
  const inputIds = targets.map((target, index) => {
    const candidate = candidates.find(
      (item) => item.templateUseId === target.templateUseId && item.variableName === target.variableName,
    );
    assert.ok(candidate, `missing candidate for ${target.templateUseId} ${target.variableName}`);
    const added = addEvaluationInput(next, created.suiteId, candidate, () => `input-${index}`);
    next = added.project;
    return added.inputId;
  });
  return { project: next, suite: next.evaluationSuites[0]!, inputIds };
}

test("applies default < authored use < case precedence across several variables and uses", () => {
  const base = fixture();
  const { project, suite, inputIds } = suiteBoundTo(base, [
    { templateUseId: "template-use_first-question", variableName: "topic" },
    { templateUseId: "template-use_second-question", variableName: "audience" },
  ]);
  const revision = project.conversationRevisions[0]!;

  const resolution = resolveEvaluationCase(project, revision, suite, {
    values: { [inputIds[0]!]: "database migrations", [inputIds[1]!]: "executives" },
  });

  assert.ok(resolution.ok);
  assert.deepEqual(resolution.unresolvedBindings, []);

  const provenance = resolution.variables.map(({ templateUseId, variableName, value, source }) =>
    [templateUseId, variableName, value, source].join(" | "),
  );
  assert.deepEqual(provenance, [
    // Safety policy: a template default, then an authored use value.
    "template-use_safety-use | policy | the default policy | template-default",
    "template-use_safety-use | persona | a reviewer | authored-use",
    // First question: the case beats the authored value, which beat the default.
    "template-use_first-question | topic | database migrations | case",
    "template-use_first-question | audience | auditors | authored-use",
    // Second question: same template, different use, so different provenance.
    "template-use_second-question | topic | a default topic | template-default",
    "template-use_second-question | audience | executives | case",
  ]);

  assert.deepEqual(
    resolution.variables
      .filter(({ source }) => source === "case")
      .map(({ inputBindingId, inputName }) => ({ inputBindingId, inputName })),
    [
      { inputBindingId: inputIds[0], inputName: "topic" },
      { inputBindingId: inputIds[1], inputName: "audience" },
    ],
  );
  assert.deepEqual(resolution.caseValues, {
    [inputIds[0]!]: "database migrations",
    [inputIds[1]!]: "executives",
  });

  assert.deepEqual(resolution.messages.map(({ role }) => role), [
    "system", "system", "user", "user", "user",
  ]);
  assert.deepEqual(
    resolution.messages.map((message) => message.content.map(({ text }) => text).join("")),
    [
      "Be concise.",
      "Enforce the default policy.",
      "Now answer as a reviewer.",
      "Explain database migrations to auditors.",
      "Explain a default topic to executives.",
    ],
  );
});

test("an empty case value is an intentional empty override, not an unresolved variable", () => {
  const base = fixture();
  const { project, suite, inputIds } = suiteBoundTo(base, [
    { templateUseId: "template-use_first-question", variableName: "topic" },
  ]);
  const resolution = resolveEvaluationCase(project, project.conversationRevisions[0]!, suite, {
    values: { [inputIds[0]!]: "" },
  });

  assert.ok(resolution.ok);
  const topic = resolution.variables.find(
    ({ templateUseId, variableName }) =>
      templateUseId === "template-use_first-question" && variableName === "topic",
  );
  assert.deepEqual({ value: topic?.value, source: topic?.source }, { value: "", source: "case" });
});

test("a variable with no value at any level is reported as unresolved with no source", () => {
  let project = createProjectFile({
    name: "Unfilled",
    idSuffix: "unfilled",
    createdAt: "2026-08-01T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "http://localhost:4010/v1",
      model: "fixture",
      messages: [{ role: "user", content: "Hello" }],
    },
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "question",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    idSuffix: "question-use",
  });

  const resolution = resolveEvaluationCase(
    project,
    project.conversationRevisions[0]!,
    { inputBindings: [] },
    { values: {} },
  );
  assert.equal(resolution.ok, false);
  const topic = resolution.variables.find(({ variableName }) => variableName === "topic");
  assert.ok(topic);
  // Visible as a setup error rather than silently rendered as blank.
  assert.equal(topic.value, undefined);
  assert.equal(topic.source, undefined);
  assert.equal(topic.templateName, "Question");
});

test("a binding the revision cannot satisfy contributes no override and never throws", () => {
  const base = fixture();
  const { project, suite, inputIds } = suiteBoundTo(base, [
    { templateUseId: "template-use_first-question", variableName: "topic" },
  ]);
  // A revision that does not contain the bound use at all.
  const otherRevision = {
    ...project.conversationRevisions[0]!,
    items: project.conversationRevisions[0]!.items.filter(
      (item) => item.kind !== "template-use" || item.use.id !== "template-use_first-question",
    ),
  };

  const resolution = resolveEvaluationCase(project, otherRevision, suite, {
    values: { [inputIds[0]!]: "database migrations" },
  });
  assert.deepEqual(resolution.unresolvedBindings, [{
    inputBindingId: inputIds[0],
    inputName: "topic",
    templateUseId: "template-use_first-question",
    variableName: "topic",
    reason: "missing-template-use",
  }]);
  assert.deepEqual(resolution.caseValues, {});
  assert.ok(resolution.ok);
});

test("the focused-case preview and the frozen plan resolve identically", () => {
  const base = fixture();
  const { project: bound, suite, inputIds } = suiteBoundTo(base, [
    { templateUseId: "template-use_first-question", variableName: "topic" },
    { templateUseId: "template-use_second-question", variableName: "audience" },
  ]);
  let project = bound;
  const added = addEvaluationCase(project, suite.id, () => "first");
  project = updateEvaluationCase(added.project, suite.id, added.caseId, {
    name: "Migrations",
    values: { [inputIds[0]!]: "database migrations", [inputIds[1]!]: "executives" },
  });
  project = {
    ...project,
    evaluationSuites: project.evaluationSuites.map((item) => ({
      ...item,
      cases: item.cases.map((evaluationCase) => ({
        ...evaluationCase,
        checks: [{ checkId: "check_contains" as const, kind: "contains" as const, value: "rollback" }],
      })),
    })),
  };

  const authoredSuite = project.evaluationSuites[0]!;
  const preview = resolveEvaluationCase(
    project,
    project.conversationRevisions[0]!,
    authoredSuite,
    authoredSuite.cases[0]!,
  );
  assert.ok(preview.ok);

  const plan = createEvaluationExperimentPlan({
    project,
    suiteId: authoredSuite.id,
    selectedCaseIds: [added.caseId],
    runtimeTarget: {
        profileId: "profile_fixture",
        protocol: "openai-compatible-chat-completions",
        endpoint: "http://localhost:4010/v1",
        capabilities: {
          chatCompletions: true,
          responsesApi: false,
          streaming: true,
          modelDiscovery: false,
          tools: false,
          parallelToolCalls: false,
          structuredOutput: false,
          vision: false,
          embeddings: false,
        },
    },
    createdAt: "2026-08-02T09:00:00.000Z",
    createSuffix: () => "plan",
  });

  const planned = plan.suite.cases[0]!.input;
  assert.deepEqual(planned.messages, preview.messages);
  assert.deepEqual(planned.templateResolutions, preview.templateResolutions);
});

test("composer run-only overrides cannot enter evaluation resolution", () => {
  const base = fixture();
  const { project, suite, inputIds } = suiteBoundTo(base, [
    { templateUseId: "template-use_first-question", variableName: "topic" },
  ]);
  const evaluationCase = { values: { [inputIds[0]!]: "database migrations" } };

  // The boundary takes no run-override parameter at all, so exclusion is
  // structural. Passing one is a type error; passing one at runtime is ignored.
  const resolveWithExtra = resolveEvaluationCase as unknown as (
    ...args: [unknown, unknown, unknown, unknown, unknown]
  ) => ReturnType<typeof resolveEvaluationCase>;
  const smuggled = resolveWithExtra(
    project,
    project.conversationRevisions[0]!,
    suite,
    evaluationCase,
    { "template-use_first-question": { topic: "COMPOSER ONLY" } },
  );
  const honest = resolveEvaluationCase(project, project.conversationRevisions[0]!, suite, evaluationCase);

  if (!smuggled.ok || !honest.ok) throw new Error("Both resolutions should succeed.");
  assert.deepEqual(smuggled.messages, honest.messages);
  assert.ok(
    smuggled.messages.every((message) =>
      message.content.every(({ text }) => !text.includes("COMPOSER ONLY")),
    ),
  );
});

test("describes an unrenderable revision instead of throwing, keeping provenance", () => {
  const base = fixture();
  const { project, suite, inputIds } = suiteBoundTo(base, [
    { templateUseId: "template-use_first-question", variableName: "topic" },
  ]);
  // A pinned immutable revision goes missing, which is the shape a hand-edited
  // or partially restored project arrives in. Resolution must stay describable:
  // an exception here would take the whole evaluation editor down.
  const damaged: ProjectFile = {
    ...project,
    promptTemplates: project.promptTemplates.map((template) =>
      template.id === "template_safety"
        ? { ...template, revisions: [] }
        : template,
    ),
  };

  const resolution = resolveEvaluationCase(
    damaged,
    damaged.conversationRevisions[0]!,
    suite,
    { values: { [inputIds[0]!]: "database migrations" } },
  );

  assert.equal(resolution.ok, false);
  if (resolution.ok) throw new Error("unreachable");
  assert.match(resolution.unresolvable ?? "", /invalid pinned revision/i);
  assert.doesNotMatch(resolution.unresolvable ?? "", /undefined/);
  // The uses that are still intact keep reporting their own provenance.
  assert.deepEqual(
    resolution.variables.map(({ templateUseId, variableName }) => `${templateUseId} ${variableName}`),
    [
      "template-use_first-question topic",
      "template-use_first-question audience",
      "template-use_second-question topic",
      "template-use_second-question audience",
    ],
  );
});
