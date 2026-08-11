import assert from "node:assert/strict";
import test from "node:test";

import {
  addEvaluationCase,
  addEvaluationCheck,
  addEvaluationInput,
  addEvaluationVariant,
  createEvaluationSuite,
  evaluationBindingCandidates,
  evaluationSuitePreflight,
  defaultCheck,
  removeEvaluationInput,
  removeEvaluationVariant,
  reorderEvaluationVariant,
  updateEvaluationCase,
  updateEvaluationCheck,
  updateEvaluationVariant,
} from "../packages/core/src/evaluation-suite-authoring.ts";
import { resolveEvaluationVariant } from "../packages/core/src/evaluation-suites.ts";
import { CHECK_KINDS } from "../packages/core/src/checks.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectFile,
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
    variableDefaults: { audience: "engineers" },
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

test("authors ordered sparse configurations with inherit, clear, and replacement semantics", () => {
  let project = fixture();
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  const defaultVariant = project.evaluationSuites[0]!.variants[0]!;
  assert.deepEqual(defaultVariant, { id: "evaluation-variant_evaluation-suite_topics-default", name: "Default", overrides: {} });

  const added = addEvaluationVariant(project, created.suiteId, () => "fast");
  project = updateEvaluationVariant(added.project, created.suiteId, added.variantId, {
    name: "Fast",
    overrides: { target: { model: "fast-model" }, options: { temperature: null, providerOptions: { tier: "fast" } } },
  });
  const suite = project.evaluationSuites[0]!;
  const resolved = resolveEvaluationVariant(suite, suite.variants[1]!);
  assert.equal(resolved.target.connectionRequirementId, suite.execution.target.connectionRequirementId);
  assert.equal(resolved.target.model, "fast-model");
  assert.equal(resolved.options.temperature, undefined);
  assert.deepEqual(resolved.options.providerOptions, { tier: "fast" });

  project = reorderEvaluationVariant(project, created.suiteId, added.variantId, 0);
  assert.deepEqual(project.evaluationSuites[0]!.variants.map(({ name }) => name), ["Fast", "Default"]);
  assert.throws(
    () => updateEvaluationVariant(project, created.suiteId, defaultVariant.id, { name: " fast ", overrides: {} }),
    /repeated within the suite/,
  );
  project = removeEvaluationVariant(project, created.suiteId, defaultVariant.id);
  assert.throws(() => removeEvaluationVariant(project, created.suiteId, added.variantId), /needs at least one configuration/);
  assert.throws(() => parseProjectFile({
    ...project,
    evaluationSuites: project.evaluationSuites.map((candidate) => ({
      ...candidate,
      variants: [{ ...candidate.variants[0]!, overrides: { target: { connectionRequirementId: "profile_local" as never } } }],
    })),
  }), /connection_/);
});

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
  project = addEvaluationCheck(project, created.suiteId, addedCase.caseId, { kind: "contains" }, () => "mentions-migrations");
  project = updateEvaluationCheck(project, created.suiteId, addedCase.caseId, {
    ...project.evaluationSuites[0]!.cases[0]!.checks[0]!,
    kind: "contains",
    value: "rollback",
  });
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

test("every offered check kind can actually be added to a case", () => {
  let project = fixture();
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  const addedCase = addEvaluationCase(project, created.suiteId, () => "first");
  project = addedCase.project;

  // Adding a check revalidates the whole project, so a default the parser
  // rejects makes that kind unreachable from the editor entirely.
  for (const kind of CHECK_KINDS) {
    const input = kind === "regex" ? { kind, pattern: "migration" } : { kind };
    project = addEvaluationCheck(project, created.suiteId, addedCase.caseId, input, () => kind);
  }
  assert.deepEqual(
    project.evaluationSuites[0]?.cases[0]?.checks.map(({ kind }) => kind),
    [...CHECK_KINDS],
  );
});

test("an empty regex enters authored state instead of being required by the add action", () => {
  const check = defaultCheck({ kind: "regex" }, () => "empty-regex");
  assert.equal(check.kind, "regex");
  assert.equal(check.kind === "regex" ? check.pattern : undefined, "");
});

test("a new regex check is case-insensitive unless the caller says otherwise", () => {
  const byDefault = defaultCheck({ kind: "regex" }, () => "default-flags");
  assert.equal(byDefault.kind === "regex" ? byDefault.flags : undefined, "i");
  const explicit = defaultCheck({ kind: "regex", flags: "m" }, () => "explicit-flags");
  assert.equal(explicit.kind === "regex" ? explicit.flags : undefined, "m");
  // An explicit empty string is a caller asking for none, not an omission.
  const none = defaultCheck({ kind: "regex", flags: "" }, () => "no-flags");
  assert.equal(none.kind === "regex" ? none.flags : undefined, undefined);
});

test("preflight reports unfinished checks and empty values for selected cases only", () => {
  let project = fixture();
  const revisionId = project.defaults.conversationRevisionId;
  const candidates = evaluationBindingCandidates(project, revisionId);
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  const input = addEvaluationInput(project, created.suiteId, candidates[0]!, () => "topic");
  project = input.project;
  const selected = addEvaluationCase(project, created.suiteId, () => "selected");
  project = selected.project;
  const ignored = addEvaluationCase(project, created.suiteId, () => "ignored");
  project = addEvaluationCheck(ignored.project, created.suiteId, selected.caseId, { kind: "contains" }, () => "unfinished");

  assert.deepEqual(
    evaluationSuitePreflight(project, created.suiteId, revisionId, [selected.caseId])
      .map(({ code }) => code),
    ["empty-case-value", "unfinished-check"],
  );

  // The unselected case's own empty value is not this run's problem.
  project = updateEvaluationCase(project, created.suiteId, selected.caseId, {
    values: { [input.inputId]: "database migrations" },
  });
  const unfinished = defaultCheck({ kind: "contains" }, () => "unfinished");
  assert.equal(unfinished.kind, "contains");
  project = updateEvaluationCheck(project, created.suiteId, selected.caseId, {
    ...unfinished,
    kind: "contains",
    value: "rollback",
  });
  assert.deepEqual(
    evaluationSuitePreflight(project, created.suiteId, revisionId, [selected.caseId]),
    [],
  );

  // Whitespace is not a value.
  project = updateEvaluationCase(project, created.suiteId, selected.caseId, {
    values: { [input.inputId]: "   " },
  });
  assert.deepEqual(
    evaluationSuitePreflight(project, created.suiteId, revisionId, [selected.caseId])
      .map(({ code }) => code),
    ["empty-case-value"],
  );
});

test("preflight blocks selected cases with unbound unresolved template variables", () => {
  let project = fixture();
  const revisionId = project.defaults.conversationRevisionId;
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  const addedCase = addEvaluationCase(project, created.suiteId, () => "first");
  project = addEvaluationCheck(addedCase.project, created.suiteId, addedCase.caseId, {
    kind: "contains",
  }, () => "contains");
  project = updateEvaluationCheck(project, created.suiteId, addedCase.caseId, {
    ...project.evaluationSuites[0]!.cases[0]!.checks[0]!,
    kind: "contains",
    value: "topic",
  });

  assert.deepEqual(
    evaluationSuitePreflight(project, created.suiteId, revisionId, [addedCase.caseId]),
    [{
      code: "unresolved-template-variable",
      caseId: addedCase.caseId,
      templateUseId: "template-use_question-use",
      variableName: "topic",
      message: 'Case "Untitled case" cannot resolve template variable "topic": Template variable "topic" has no value.',
    }],
  );
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
