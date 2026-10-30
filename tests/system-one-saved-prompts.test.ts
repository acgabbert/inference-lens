import assert from "node:assert/strict";
import test from "node:test";
import { createProjectFile, parseProjectFile, parseProjectJson, serializeProjectFile, PROJECT_SCHEMA_VERSION } from "../packages/core/src/project.ts";
import { resolveProjectDecisionRequestRevision, prepareDecisionRequestRun } from "../packages/core/src/decision-request.ts";
import type { DecisionInput } from "../packages/core/src/decision.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";

const createdAt = "2026-10-25T12:00:00.000Z";
const decision: DecisionInput = {
  state: { z: "{{ticket}}", a: "\\{{literal}}" },
  questions: {
    zeta: { type: "score", instructions: "{{team}}", criteria: ["high", "low"] },
    alpha: { type: "choice", instructions: "Route", criteria: { urgent: "Now", later: null } },
  },
};
function base() {
  return createProjectFile({ name: "Saved decisions", idSuffix: "saved", createdAt, request: {
    provider: "openai-compatible", endpoint: "http://127.0.0.1:24028/v1", model: "chat",
    messages: [{ role: "user", content: "Hi" }], capabilities: resolveProviderCapabilities("openai-compatible"),
  } });
}
function document() {
  return { ...base(), schemaVersion: 15,
    promptTemplates: [{ kind: "decision", id: "template_decision", name: "Triage", currentRevisionId: "template-revision_old",
      revisions: [{ id: "template-revision_old", createdAt, decision, variableDefaults: { ticket: "default", team: "ops" } }] }],
    decisionRequests: [{ id: "decision-request_use", name: "Use" }],
    decisionRequestRevisions: [{ kind: "template-use", id: "decision-revision_use", decisionRequestId: "decision-request_use", createdAt,
      templateId: "template_decision", templateRevisionId: "template-revision_old", overrides: { ticket: "" } }],
  };
}

test("a v15 document opens as v18 and round-trips decision template pins with ordered authored content", () => {
  const opened = parseProjectFile(document());
  assert.equal(opened.schemaVersion, 18);
  assert.deepEqual(parseProjectJson(serializeProjectFile(opened)), opened);
  const resolved = resolveProjectDecisionRequestRevision(opened, "decision-revision_use")!;
  assert.deepEqual(resolved.decision, decision);
  assert.deepEqual(Object.keys(resolved.decision.questions), ["zeta", "alpha"]);
  assert.deepEqual(resolved.values, { ticket: "", team: "ops" });
  assert.deepEqual(resolved.source, { kind: "template-use", decisionRequestId: "decision-request_use", decisionRequestRevisionId: "decision-revision_use", templateId: "template_decision", templateRevisionId: "template-revision_old" });
  assert.equal(prepareDecisionRequestRun(resolved.decision, resolved.values).ok, true);
  resolved.values.team = "mutated";
  resolved.decision.questions.zeta!.instructions = "mutated";
  assert.deepEqual(resolveProjectDecisionRequestRevision(opened, "decision-revision_use")!.decision, decision);
});

test("v14 migration adds chat and inline discriminators without changing content", () => {
  const legacy = { ...base(), schemaVersion: 14,
    promptTemplates: [{ id: "template_chat", name: "Chat", currentRevisionId: "template-revision_chat", archivedAt: createdAt,
      draft: { sourceRevisionId: "template-revision_chat", messages: [{ role: "user", content: "Draft {{x}}" }], variableDefaults: { x: "draft" } },
      revisions: [{ id: "template-revision_chat", createdAt, messages: [{ role: "user", content: "{{x}}" }], variableDefaults: { x: "a" } }] }],
    decisionRequests: [{ id: "decision-request_inline", name: "Inline" }],
    decisionRequestRevisions: [{ id: "decision-revision_inline", decisionRequestId: "decision-request_inline", createdAt, decision, values: { ticket: "" } }],
  };
  const opened = parseProjectFile(legacy);
  assert.equal(opened.schemaVersion, 18);
  assert.deepEqual(opened.promptTemplates[0], { ...legacy.promptTemplates[0], kind: "chat" });
  assert.deepEqual(opened.decisionRequestRevisions[0], { ...legacy.decisionRequestRevisions[0], kind: "inline" });
  assert.equal(PROJECT_SCHEMA_VERSION, 18);
});

test("decision request pins and transitive suites are reported as library usages", async () => {
  const { findPromptTemplateUsages } = await import("../packages/core/src/project.ts");
  const { createDecisionEvaluationSuite } = await import("../packages/core/src/evaluation-suite-authoring.ts");
  const project = createDecisionEvaluationSuite(parseProjectFile(document()), {
    decisionRequestRevisionId: "decision-revision_use", model: "all-types",
  }).project;
  const usages = findPromptTemplateUsages(project, "template_decision", "template-revision_old");
  assert.equal(usages.length, 2);
  assert.deepEqual(usages.map((usage) => usage.kind), ["decision-request", "evaluation-suite"]);
});

test("strict schemas reject mixed content, missing pins, wrong kinds, and invalid assignments", () => {
  const valid = document();
  const template = valid.promptTemplates[0]!;
  const revision = template.revisions[0]!;
  const use = valid.decisionRequestRevisions[0]!;
  const invalid: unknown[] = [
    { ...valid, promptTemplates: [{ ...template, kind: "chat" }] },
    { ...valid, promptTemplates: [{ ...template, revisions: [{ ...revision, messages: [{ role: "user", content: "Hi" }] }] }] },
    { ...valid, promptTemplates: [{ ...template, draft: { sourceRevisionId: revision.id, messages: [{ role: "user", content: "Hi" }], variableDefaults: {} } }] },
    { ...valid, decisionRequestRevisions: [{ ...use, templateId: "template_missing" }] },
    { ...valid, decisionRequestRevisions: [{ ...use, templateRevisionId: "template-revision_missing" }] },
    { ...valid, decisionRequestRevisions: [{ ...use, decision, values: {} }] },
    { ...valid, decisionRequestRevisions: [{ ...use, overrides: { unused: "x" } }] },
    { ...valid, promptTemplates: [{ ...template, revisions: [{ ...revision, variableDefaults: { unused: "x" } }] }] },
    { ...valid, promptTemplates: [{ ...template, revisions: [{ ...revision, decision: { ...decision, state: "{{api_key}}" }, variableDefaults: { api_key: "secret" } }] }] },
  ];
  for (const value of invalid) assert.throws(() => parseProjectFile(value), /Invalid Inference Lens project/);
  const wrongKind = { ...use, templateId: "template_chat", templateRevisionId: "template-revision_chat" };
  assert.throws(() => parseProjectFile({ ...valid, promptTemplates: [{ kind: "chat", id: "template_chat", name: "Chat", currentRevisionId: "template-revision_chat", revisions: [{ id: "template-revision_chat", createdAt, messages: [{ role: "user", content: "Hi" }], variableDefaults: {} }] }], decisionRequestRevisions: [wrongKind] }), /Decision request uses require a decision template/);
});

test("a supplied empty decision case value overrides template defaults and request overrides", async () => {
  const { createDecisionEvaluationSuite } = await import("../packages/core/src/evaluation-suite-authoring.ts");
  const { evaluationSuitePreflight } = await import("../packages/core/src/evaluation-suites.ts");
  const { createDecisionEvaluationExperimentPlan } = await import("../packages/core/src/evaluation-execution.ts");
  const { decisionProject, decisionRuntimeTarget } = await import("./fixtures/decision-evaluation.ts");
  const fixture = decisionProject();
  const made = createDecisionEvaluationSuite(parseProjectFile(document()), { decisionRequestRevisionId: "decision-revision_use", model: "all-types" });
  const suite = fixture.evaluationSuites[0]!;
  assert.ok(suite.input.kind === "decision-request-revision");
  const evaluationCase = { ...suite.cases[0]!, values: { "evaluation-input_ticket": "" }, checks: [] };
  // Use a deterministic check against a question the saved template actually defines.
  const check = { ...suite.cases[0]!.checks[0]!, kind: "decision-choice", questionId: "alpha", option: "urgent" };
  const project = parseProjectFile({ ...made.project, evaluationSuites: [{ ...made.project.evaluationSuites[0]!,
    inputBindings: [suite.inputBindings[0]], cases: [{ ...evaluationCase, checks: [check] }] }] });
  assert.deepEqual(evaluationSuitePreflight(project, made.suiteId, project.defaults.conversationRevisionId), []);
  const plan = createDecisionEvaluationExperimentPlan({ project, suiteId: made.suiteId, selectedCaseIds: [evaluationCase.id], runtimeTargets: Object.fromEntries(project.evaluationSuites[0]!.variants.map(({ id }) => [id, decisionRuntimeTarget("saved")])) });
  assert.deepEqual(plan.suite.cases[0]!.input.decision.state, { z: "", a: "{{literal}}" });
});

// New lifecycle entry points cannot be exercised before they exist; the schema,
// usage, and empty-case regressions above were run red against existing APIs.
test("capture, draft, save, update, and detach preserve pins and absent assignments", async () => {
  const { createDecisionPromptTemplate, appendDecisionPromptTemplateRevision, updateDecisionPromptTemplateDraft } = await import("../packages/core/src/decision-template.ts");
  const { useDecisionPromptTemplateRevision, updateDecisionRequestTemplateRevision, detachDecisionRequestTemplate } = await import("../packages/core/src/decision-request.ts");
  const start = base();
  const before = serializeProjectFile(start);
  const saved = createDecisionPromptTemplate(start, { name: "Reusable", decision, variableDefaults: { team: "ops" }, idSuffix: "reusable", revisionIdSuffix: "first", createdAt });
  assert.equal(saved.defaults.decisionRequestRevisionId, undefined, "capture does not adopt a use");
  assert.equal(serializeProjectFile(start), before);
  const used = useDecisionPromptTemplateRevision(saved, { templateId: "template_reusable", overrides: { ticket: "", team: "mine" }, idSuffix: "use", createdAt });
  assert.equal(used.defaults.decisionRequestRevisionId, "decision-revision_use");
  const useBefore = serializeProjectFile(used);
  const changed: DecisionInput = { state: "{{new_value}}", questions: { q: { type: "noul", instructions: "{{team}}" } } };
  const drafted = updateDecisionPromptTemplateDraft(used, { templateId: "template_reusable", sourceRevisionId: "template-revision_first", decision: changed, variableDefaults: { team: "new default" }, revisionName: "Working" });
  assert.deepEqual(resolveProjectDecisionRequestRevision(drafted, "decision-revision_use")!.decision, decision);
  const revised = appendDecisionPromptTemplateRevision(drafted, { templateId: "template_reusable", decision: changed, variableDefaults: { team: "new default" }, idSuffix: "second", createdAt, name: "New questions" });
  assert.equal(revised.promptTemplates[0]!.draft, undefined);
  assert.deepEqual(resolveProjectDecisionRequestRevision(revised, "decision-revision_use")!.values, { team: "mine", ticket: "" });
  assert.equal(serializeProjectFile(used), useBefore);
  const updated = updateDecisionRequestTemplateRevision(revised, { decisionRequestRevisionId: "decision-revision_use", idSuffix: "updated", createdAt });
  const child = updated.decisionRequestRevisions.at(-1)!;
  assert.ok(child.kind === "template-use");
  assert.equal(child.parentRevisionId, "decision-revision_use");
  assert.deepEqual(child.overrides, { team: "mine" });
  const resolved = resolveProjectDecisionRequestRevision(updated, child.id)!;
  assert.deepEqual(resolved.values, { team: "mine" });
  assert.deepEqual(resolved.diagnostics.map(({ name }) => name), ["new_value"]);
  const detached = detachDecisionRequestTemplate(updated, { decisionRequestRevisionId: child.id, idSuffix: "detached", createdAt });
  const inline = detached.decisionRequestRevisions.at(-1)!;
  assert.ok(inline.kind === "inline");
  assert.equal(inline.parentRevisionId, child.id);
  assert.deepEqual(inline.decision, changed);
  assert.deepEqual(inline.values, { team: "mine" });
  assert.equal(prepareDecisionRequestRun(inline.decision, inline.values).ok, false);
  assert.equal(serializeProjectFile(parseProjectJson(serializeProjectFile(detached))), serializeProjectFile(detached));
  assert.equal(appendDecisionPromptTemplateRevision(revised, { templateId: "template_reusable", decision: changed, variableDefaults: { team: "new default" } }), revised);
});

test("overrides freeze when loaded/executed or suite-pinned; inline mutation cannot detach implicitly", async () => {
  const { updateDecisionRequestOverrides, updateDecisionRequestDraft } = await import("../packages/core/src/decision-request.ts");
  const { createDecisionEvaluationSuite } = await import("../packages/core/src/evaluation-suite-authoring.ts");
  const project = parseProjectFile(document());
  const changed = updateDecisionRequestOverrides(project, { decisionRequestRevisionId: "decision-revision_use", overrides: { team: "sales" }, branch: false });
  assert.equal(changed.decisionRequestRevisions.length, 1);
  assert.deepEqual(resolveProjectDecisionRequestRevision(changed, "decision-revision_use")!.values, { ticket: "default", team: "sales" });
  const pinned = createDecisionEvaluationSuite(changed, { decisionRequestRevisionId: "decision-revision_use", model: "all-types" }).project;
  for (const [input, branch] of [[changed, true], [pinned, false]] as const) {
    const child = updateDecisionRequestOverrides(input, { decisionRequestRevisionId: "decision-revision_use", overrides: { team: "" }, branch, idSuffix: "child", createdAt });
    assert.equal(child.decisionRequestRevisions.length, 2);
    assert.equal(child.decisionRequestRevisions[1]!.parentRevisionId, "decision-revision_use");
    assert.deepEqual(resolveProjectDecisionRequestRevision(child, "decision-revision_use")!.values, { ticket: "default", team: "sales" });
    assert.deepEqual(resolveProjectDecisionRequestRevision(child, "decision-revision_child")!.values, { ticket: "default", team: "" });
  }
  const active = { ...project, defaults: { ...project.defaults, decisionRequestRevisionId: "decision-revision_use" as const } };
  assert.throws(() => updateDecisionRequestDraft(active, { decision, values: {}, branch: false }), /Detach the pinned decision template/);
  assert.throws(() => updateDecisionRequestOverrides(project, { decisionRequestRevisionId: "decision-revision_use", overrides: { unused: "x" }, branch: false }), /Decision request override "unused" names a variable/);
});

test("archive keeps historical resolution and detach; usage protects noncurrent revisions", async () => {
  const { archivePromptTemplate, restorePromptTemplate, removePromptTemplateRevision, setPromptTemplateCurrentRevision, renamePromptTemplate } = await import("../packages/core/src/project.ts");
  const { appendDecisionPromptTemplateRevision } = await import("../packages/core/src/decision-template.ts");
  const { useDecisionPromptTemplateRevision, detachDecisionRequestTemplate } = await import("../packages/core/src/decision-request.ts");
  const revised = appendDecisionPromptTemplateRevision(parseProjectFile(document()), { templateId: "template_decision", decision: { ...decision, state: "{{ticket}}!" }, variableDefaults: { team: "ops" }, idSuffix: "new", createdAt });
  assert.throws(() => removePromptTemplateRevision(revised, "template_decision", "template-revision_old"), /referenced template revision/);
  const archived = archivePromptTemplate(revised, "template_decision", createdAt);
  assert.deepEqual(resolveProjectDecisionRequestRevision(archived, "decision-revision_use")!.decision, decision);
  assert.throws(() => useDecisionPromptTemplateRevision(archived, { templateId: "template_decision" }), /Archived templates/);
  assert.ok(detachDecisionRequestTemplate(archived, { decisionRequestRevisionId: "decision-revision_use", idSuffix: "detached", createdAt }));
  const restored = restorePromptTemplate(archived, "template_decision");
  const renamed = renamePromptTemplate(restored, "template_decision", "Renamed");
  const selected = setPromptTemplateCurrentRevision(renamed, "template_decision", "template-revision_old");
  assert.equal(selected.promptTemplates[0]!.name, "Renamed");
  const removed = removePromptTemplateRevision(selected, "template_decision", "template-revision_new");
  assert.equal(removed.promptTemplates[0]!.revisions.length, 1);
  const evaluated = useDecisionPromptTemplateRevision(removed, { templateId: "template_decision", activate: false, idSuffix: "evaluation", createdAt });
  assert.deepEqual(evaluated.defaults, removed.defaults, "evaluation request creation leaves Compose alone");
});

test("decision template revisions can be renamed without touching content", async () => {
  const { renamePromptTemplateRevision } = await import("../packages/core/src/project.ts");
  const project = parseProjectFile(document());
  const renamed = renamePromptTemplateRevision(project, "template_decision", "template-revision_old", "Launch");
  assert.deepEqual(renamed.promptTemplates[0]!.revisions[0], { ...project.promptTemplates[0]!.revisions[0]!, name: "Launch" });
});

test("decision diffs detect state, type, instructions, question and criterion ordering, and defaults", async () => {
  const { diffDecisionPromptTemplateRevisions: diff } = await import("../packages/core/src/decision-template-revision-diff.ts");
  const before = { id: "template-revision_before" as const, createdAt, decision, variableDefaults: { team: "a", ticket: "b" } };
  assert.equal(diff(before, { ...before, variableDefaults: { ticket: "b", team: "a" } }).identical, true);
  const reorder = diff(before, { ...before, decision: { ...decision, questions: { alpha: decision.questions.alpha!, zeta: decision.questions.zeta! } } });
  assert.equal(reorder.questionOrderChanged, true);
  assert.equal(reorder.identical, false);
  // Order is reported once; a moved question with unchanged content is not itself a change.
  assert.deepEqual(reorder.questions.map(({ id, status, beforeIndex, afterIndex }) => ({ id, status, beforeIndex, afterIndex })), [
    { id: "zeta", status: "identical", beforeIndex: 0, afterIndex: 1 },
    { id: "alpha", status: "identical", beforeIndex: 1, afterIndex: 0 },
  ]);
  const inserted = diff(before, { ...before, decision: { ...decision, questions: { first: { type: "noul", instructions: "New" }, ...decision.questions } } });
  assert.deepEqual(inserted.questions.map(({ status }) => status), ["identical", "identical", "added"]);
  const criteria = diff(before, { ...before, decision: { ...decision, questions: { ...decision.questions, zeta: { type: "score", instructions: "{{team}}", criteria: ["low", "high"] } } } });
  assert.equal(criteria.identical, false);
  assert.equal(criteria.questions[0]!.criteria.identical, false);
  assert.equal(criteria.questionOrderChanged, false);
  const changed = diff(before, { ...before, decision: { state: "New", questions: { zeta: { type: "noul", instructions: "Changed" }, added: { type: "noul", instructions: "New" } } }, variableDefaults: {} });
  assert.equal(changed.state.identical, false);
  assert.equal(changed.questions[0]!.typeChanged, true);
  assert.equal(changed.questions[0]!.instructions.identical, false);
  assert.deepEqual(changed.questions.map(({ status }) => status), ["changed", "removed", "added"]);
  assert.deepEqual(changed.variableDefaults.map(({ status }) => status), ["removed", "removed"]);
});

test("malformed decision template content reports project validation errors", () => {
  const valid = document();
  for (const decision of [null, {}, { state: "x", questions: {} }, { state: "x", questions: { q: null } }]) {
    const template = valid.promptTemplates[0]!;
    assert.throws(() => parseProjectFile({ ...valid, promptTemplates: [{ ...template, revisions: [{ ...template.revisions[0], decision }] }] }), /Invalid Inference Lens project/);
    assert.throws(() => parseProjectFile({ ...valid, promptTemplates: [{ ...template, draft: { sourceRevisionId: "template-revision_old", decision, variableDefaults: {} } }] }), /Invalid Inference Lens project/);
  }
});

test("a v15 decision case may leave an input unfilled, and preflight blocks it", async () => {
  // A chat case missing a value is still rejected; see project.test.ts.
  const { decisionProject } = await import("./fixtures/decision-evaluation.ts");
  const { evaluationSuitePreflight } = await import("../packages/core/src/evaluation-suites.ts");
  const project = decisionProject();
  const parsed = parseProjectFile({ ...project, evaluationSuites: project.evaluationSuites.map((suite) => ({ ...suite,
    cases: suite.cases.slice(0, 1).map((evaluationCase) => ({ ...evaluationCase, values: {} })) })) });
  assert.deepEqual(parsed.evaluationSuites[0]!.cases[0]!.values, {});
  const diagnostics = evaluationSuitePreflight(parsed, parsed.evaluationSuites[0]!.id, parsed.defaults.conversationRevisionId);
  assert.deepEqual(diagnostics.flatMap((diagnostic) => diagnostic.code === "empty-case-value" ? [diagnostic.inputBindingId] : []), ["evaluation-input_ticket"]);
});
