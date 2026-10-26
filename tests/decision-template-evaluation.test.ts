import assert from "node:assert/strict";
import test from "node:test";
import { createDecisionPromptTemplate, appendDecisionPromptTemplateRevision } from "../packages/core/src/decision-template.ts";
import { resolveProjectDecisionRequestRevision } from "../packages/core/src/decision-request.ts";
import { createDecisionTemplateEvaluation, decisionTemplateEvaluationSuites, previewDecisionTemplateEvaluationRetarget, retargetDecisionTemplateEvaluation } from "../packages/core/src/decision-template-evaluation.ts";
import { addDecisionEvaluationInput, addEvaluationCase, updateEvaluationCase, addEvaluationCheck, updateEvaluationCheck } from "../packages/core/src/evaluation-suite-authoring.ts";
import { evaluationSuitePreflight, isDecisionEvaluationSuite } from "../packages/core/src/evaluation-suites.ts";
import { createDecisionEvaluationExperimentPlan } from "../packages/core/src/evaluation-execution.ts";
import { parseExperimentPlanJson, serializeExperimentPlan } from "../packages/core/src/experiment.ts";
import { parseProjectFile, serializeProjectFile, parseProjectJson, archivePromptTemplate } from "../packages/core/src/project.ts";
import { decision, decisionProject, decisionRuntimeTarget } from "./fixtures/decision-evaluation.ts";

function fixture() {
  return createDecisionPromptTemplate({ ...decisionProject(), evaluationSuites: [] }, {
    name: "Routing", decision, variableDefaults: { ticket: "default ticket", plan: "pro" }, idSuffix: "routing", revisionIdSuffix: "one",
  });
}
let next = 0;
const suffix = () => `eval${++next}`;
function withCases() {
  const created = createDecisionTemplateEvaluation(fixture(), { templateId: "template_routing", templateRevisionId: "template-revision_one" }, suffix);
  const input = addDecisionEvaluationInput(created.project, created.suiteId, "ticket", suffix);
  const added = addEvaluationCase(input.project, created.suiteId, suffix);
  let project = updateEvaluationCase(added.project, created.suiteId, added.caseId, { values: { [input.inputId]: "Case ticket" } });
  project = addEvaluationCheck(project, created.suiteId, added.caseId, { kind: "decision-choice" }, suffix);
  const checkId = project.evaluationSuites[0]!.cases[0]!.checks[0]!.checkId;
  project = updateEvaluationCheck(project, created.suiteId, added.caseId, { checkId, kind: "decision-choice", questionId: "intent", option: "refund" });
  return { project, suiteId: created.suiteId, caseId: added.caseId };
}

test("evaluation creates an inactive template use and leaves both Compose and chat defaults alone", () => {
  const project = fixture();
  const before = structuredClone(project);
  const created = createDecisionTemplateEvaluation(project, { templateId: "template_routing", templateRevisionId: "template-revision_one" }, suffix);
  assert.deepEqual(project, before);
  assert.deepEqual(created.project.defaults, before.defaults);
  assert.deepEqual(created.project.conversationRevisions, before.conversationRevisions);
  const suite = created.project.evaluationSuites[0]!;
  assert.ok(isDecisionEvaluationSuite(suite));
  assert.equal(suite.execution.target.model, before.defaults.target.model);
  assert.equal(suite.execution.target.protocol, "systemone");
  const resolved = resolveProjectDecisionRequestRevision(created.project, suite.input.decisionRequestRevisionId)!;
  assert.deepEqual(resolved.decision, decision);
  assert.deepEqual(resolved.values, { ticket: "default ticket", plan: "pro" });
  assert.deepEqual(decisionTemplateEvaluationSuites(created.project, "template_routing").map(({ suite, pinnedRevisionId }) => [suite.id, pinnedRevisionId]), [[created.suiteId, "template-revision_one"]]);
  assert.deepEqual(parseProjectJson(serializeProjectFile(created.project)), created.project);
});

test("retarget review reports removed variables, question changes and invalid checks before preserving every authored case", () => {
  const { project: base, suiteId } = withCases();
  const project = appendDecisionPromptTemplateRevision(base, { templateId: "template_routing", idSuffix: "two", decision: {
    state: "{{new_input}}", questions: { intent: { type: "noul", instructions: "Now boolean" }, extra: { type: "noul", instructions: "Extra" } },
  } });
  const before = structuredClone(project);
  const preview = previewDecisionTemplateEvaluationRetarget(project, { suiteId, templateId: "template_routing", templateRevisionId: "template-revision_two" });
  assert.ok(preview.changes.some((message) => message.includes('Removed variable "ticket"')));
  assert.ok(preview.changes.some((message) => message.includes('Removed question "severity"')));
  assert.ok(preview.changes.some((message) => message.includes('"intent" changed from choice to noul')));
  assert.ok(preview.diagnostics.some(({ code }) => code === "wrong-question-type"));
  assert.ok(preview.diagnostics.some(({ code }) => code === "missing-decision-variable"));
  assert.ok(preview.diagnostics.some(({ code }) => code === "unresolved-template-variable"));
  assert.deepEqual(project, before, "review is read-only");
  const updated = retargetDecisionTemplateEvaluation(project, { suiteId, templateId: "template_routing", templateRevisionId: "template-revision_two", idSuffix: "retarget" });
  assert.deepEqual(updated.defaults, project.defaults);
  assert.deepEqual(updated.evaluationSuites[0]!.cases, project.evaluationSuites[0]!.cases);
  assert.deepEqual(updated.evaluationSuites[0]!.inputBindings, project.evaluationSuites[0]!.inputBindings);
  assert.deepEqual(updated.evaluationSuites[0]!.execution, project.evaluationSuites[0]!.execution);
  assert.deepEqual(updated.decisionRequestRevisions.slice(0, -1), project.decisionRequestRevisions);
  assert.equal(updated.decisionRequestRevisions.at(-1)!.parentRevisionId, project.evaluationSuites[0]!.input.kind === "decision-request-revision" ? project.evaluationSuites[0]!.input.decisionRequestRevisionId : undefined);
  assert.ok(evaluationSuitePreflight(updated, suiteId, updated.defaults.conversationRevisionId).some(({ code }) => code === "wrong-question-type"));
  assert.deepEqual(parseProjectJson(serializeProjectFile(updated)), JSON.parse(JSON.stringify(updated)));
});

test("changed options are diagnosed, old experiment snapshots retain their original input, and same-pin open is a no-op", () => {
  const { project: base, suiteId, caseId } = withCases();
  const suite = base.evaluationSuites[0]!;
  assert.ok(isDecisionEvaluationSuite(suite));
  const plan = createDecisionEvaluationExperimentPlan({ project: base, suiteId, selectedCaseIds: [caseId], runtimeTargets: { [suite.variants[0]!.id]: decisionRuntimeTarget("local") } });
  const serialized = serializeExperimentPlan(plan);
  const project = appendDecisionPromptTemplateRevision(base, { templateId: "template_routing", idSuffix: "two", decision: {
    ...decision, questions: { ...decision.questions, intent: { type: "choice", instructions: "Route", criteria: { billing: "Bill" } } },
  }, variableDefaults: { ticket: "new ticket", plan: "new plan" } });
  const options = { suiteId, templateId: "template_routing" as const, templateRevisionId: "template-revision_two" as const };
  assert.ok(previewDecisionTemplateEvaluationRetarget(project, options).diagnostics.some(({ code }) => code === "unknown-decision-option"));
  const updated = retargetDecisionTemplateEvaluation(project, options);
  assert.deepEqual(parseExperimentPlanJson(serialized), plan);
  assert.equal(retargetDecisionTemplateEvaluation(updated, options), updated);
  // An existing historical pin remains discoverable even when the source is archived.
  const archived = archivePromptTemplate(project, "template_routing");
  assert.equal(decisionTemplateEvaluationSuites(archived, "template_routing").length, 1);
  assert.throws(() => createDecisionTemplateEvaluation(archived, options), /Archived/);
  assert.throws(() => retargetDecisionTemplateEvaluation(archived, options), /archived/i);
  assert.throws(() => retargetDecisionTemplateEvaluation(parseProjectFile(project), { ...options, templateId: "template_missing" }), /decision template/i);
});

test("retarget retains surviving overrides including empty strings and reports checks on removed questions", () => {
  const { project: base, suiteId } = withCases();
  const parent = base.decisionRequestRevisions.at(-1)!;
  const overridden = parseProjectFile({ ...base, decisionRequestRevisions: base.decisionRequestRevisions.map((revision) => revision.id === parent.id
    ? { ...revision, overrides: { ticket: "request ticket", plan: "" } } : revision) });
  const project = appendDecisionPromptTemplateRevision(overridden, { templateId: "template_routing", idSuffix: "two", decision: {
    state: "{{plan}}", questions: { severity: decision.questions.severity! },
  }, variableDefaults: { plan: "new default" } });
  const options = { suiteId, templateId: "template_routing" as const, templateRevisionId: "template-revision_two" as const };
  assert.ok(previewDecisionTemplateEvaluationRetarget(project, options).diagnostics.some(({ code }) => code === "missing-decision-question"));
  const updated = retargetDecisionTemplateEvaluation(project, options);
  const revision = updated.decisionRequestRevisions.at(-1)!;
  assert.ok(revision.kind === "template-use");
  assert.deepEqual(revision.overrides, { plan: "" });
  assert.deepEqual(resolveProjectDecisionRequestRevision(updated, revision.id)!.values, { plan: "" });
  assert.deepEqual(project.decisionRequestRevisions.at(-1), parent.kind === "template-use" ? { ...parent, overrides: { ticket: "request ticket", plan: "" } } : undefined);
});
