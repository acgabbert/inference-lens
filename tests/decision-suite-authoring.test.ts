import assert from "node:assert/strict";
import test from "node:test";

import { updateDecisionRequestDraft } from "../packages/core/src/decision-request.ts";
import {
  addDecisionEvaluationInput,
  addEvaluationCase,
  createDecisionEvaluationSuite,
  decisionBindingCandidates,
  updateDecisionEvaluationVariant,
  updateDecisionSuiteExecution,
  updateDecisionSuiteInput,
  updateEvaluationSuiteExecution,
} from "../packages/core/src/evaluation-suite-authoring.ts";
import { isDecisionEvaluationSuite } from "../packages/core/src/evaluation-suites.ts";
import type { DecisionEvaluationSuite } from "../packages/core/src/evaluation-suites.ts";
import { parseProjectFile, ProjectValidationError } from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import type { EvaluationSuiteId } from "../packages/core/src/run-kernel/index.ts";
import { decision, decisionProject } from "./fixtures/decision-evaluation.ts";

/** The fixture's request and revision, with no suite yet. */
function withRequest(): ProjectFile {
  return parseProjectFile({ ...decisionProject(), evaluationSuites: [] });
}

function counter(prefix: string) {
  let next = 0;
  return () => `${prefix}${++next}`;
}

function decisionSuite(project: ProjectFile, suiteId: EvaluationSuiteId): DecisionEvaluationSuite {
  const suite = project.evaluationSuites.find(({ id }) => id === suiteId);
  assert.ok(suite && isDecisionEvaluationSuite(suite));
  return suite;
}

test("a decision suite starts pinned to a revision, on the project's connection, with one configuration", () => {
  const project = withRequest();
  const created = createDecisionEvaluationSuite(project, {
    decisionRequestRevisionId: "decision-revision_one",
    model: "local-decision",
  }, counter("new"));
  const suite = decisionSuite(created.project, created.suiteId);
  assert.equal(suite.name, "Decision request evaluation");
  assert.deepEqual(suite.input, { kind: "decision-request-revision", decisionRequestRevisionId: "decision-revision_one" });
  assert.deepEqual(suite.execution, {
    target: {
      connectionRequirementId: project.defaults.target.connectionRequirementId,
      model: "local-decision",
      protocol: "systemone",
    },
    repetitions: 1,
  });
  assert.deepEqual(suite.variants.map(({ name, overrides }) => ({ name, overrides })), [{ name: "Default", overrides: {} }]);
  assert.deepEqual(suite.inputBindings, []);
  assert.deepEqual(suite.cases, []);
});

test("a decision suite needs a model", () => {
  assert.throws(
    () => createDecisionEvaluationSuite(withRequest(), { decisionRequestRevisionId: "decision-revision_one", model: "" }),
    ProjectValidationError,
  );
});

test("creating a decision suite for a revision that does not exist is refused", () => {
  assert.throws(
    () => createDecisionEvaluationSuite(withRequest(), { decisionRequestRevisionId: "decision-revision_missing", model: "local-decision" }),
    ProjectValidationError,
  );
});

test("binding candidates are the pinned revision's variables that no input fills yet", () => {
  const created = createDecisionEvaluationSuite(withRequest(), { decisionRequestRevisionId: "decision-revision_one", model: "local-decision" }, counter("a"));
  assert.deepEqual(decisionBindingCandidates(created.project, decisionSuite(created.project, created.suiteId)), ["ticket", "plan"]);

  const withCase = addEvaluationCase(created.project, created.suiteId, counter("case"));
  const bound = addDecisionEvaluationInput(withCase.project, created.suiteId, "ticket", counter("input"));
  const suite = decisionSuite(bound.project, created.suiteId);
  assert.deepEqual(suite.inputBindings, [{
    id: bound.inputId,
    name: "ticket",
    target: { kind: "decision-variable", variableName: "ticket" },
  }]);
  // Every existing case gains an empty value for the new input.
  assert.deepEqual(suite.cases[0]?.values, { [bound.inputId]: "" });
  assert.deepEqual(decisionBindingCandidates(bound.project, suite), ["plan"]);
});

test("a decision input for a variable the revision does not use is refused", () => {
  const created = createDecisionEvaluationSuite(withRequest(), { decisionRequestRevisionId: "decision-revision_one", model: "local-decision" });
  assert.throws(
    () => addDecisionEvaluationInput(created.project, created.suiteId, "customer"),
    (error: unknown) => error instanceof ProjectValidationError && /does not use variable "customer"/.test(error.message),
  );
});

test("a decision suite repins to another revision and edits its own execution", () => {
  const created = createDecisionEvaluationSuite(withRequest(), { decisionRequestRevisionId: "decision-revision_one", model: "local-decision" });
  const branched = updateDecisionRequestDraft(created.project, {
    decision: { ...decision, state: "Ticket {{ticket}}" },
    values: { ticket: "Charged twice" },
    branch: true,
    idSuffix: "two",
  });
  const repinned = updateDecisionSuiteInput(branched, created.suiteId, "decision-revision_two");
  assert.equal(decisionSuite(repinned, created.suiteId).input.decisionRequestRevisionId, "decision-revision_two");

  const edited = updateDecisionSuiteExecution(repinned, created.suiteId, {
    target: { ...decisionSuite(repinned, created.suiteId).execution.target, model: "big-decision" },
    repetitions: 3,
  });
  assert.equal(decisionSuite(edited, created.suiteId).execution.target.model, "big-decision");
  assert.equal(decisionSuite(edited, created.suiteId).execution.repetitions, 3);
});

test("a decision configuration overrides its model, and chat edits refuse a decision suite", () => {
  const created = createDecisionEvaluationSuite(withRequest(), { decisionRequestRevisionId: "decision-revision_one", model: "local-decision" });
  const [variant] = decisionSuite(created.project, created.suiteId).variants;
  const renamed = updateDecisionEvaluationVariant(created.project, created.suiteId, variant!.id, {
    name: "Big",
    overrides: { target: { model: "big-decision" } },
  });
  assert.deepEqual(decisionSuite(renamed, created.suiteId).variants[0], {
    id: variant!.id,
    name: "Big",
    overrides: { target: { model: "big-decision" } },
  });
  assert.throws(
    () => updateEvaluationSuiteExecution(renamed, created.suiteId, {} as never),
    (error: unknown) => error instanceof ProjectValidationError && /chat suites only/.test(error.message),
  );
});
