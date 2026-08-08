import assert from "node:assert/strict";
import test from "node:test";

import {
  createEvaluationAssessment,
  EvaluationAssessmentError,
  evaluationAssessmentCriteria,
  parseEvaluationAssessmentJson,
  serializeEvaluationAssessment,
} from "../packages/core/src/evaluation-assessment.ts";
import { diffEvaluationOutcomes } from "../packages/core/src/evaluation-outcome-diff.ts";
import {
  currentSuiteCriteria,
  planSuiteAdoption,
} from "../packages/core/src/evaluation-reassessment.ts";
import { createEvaluationExperimentPlan } from "../packages/core/src/evaluation-execution.ts";
import {
  ExperimentValidationError,
  evaluationParsedExperimentAggregate,
  materializeExperimentCellInput,
} from "../packages/core/src/experiment.ts";
import type {
  EvaluationCriteriaOverride,
  EvaluationExperimentPlanV4,
  ExperimentResultV4,
} from "../packages/core/src/experiment.ts";
import type { CheckDefinition } from "../packages/core/src/checks.ts";
import { createProjectFile, parseProjectFile } from "../packages/core/src/project.ts";
import { RunCoordinator } from "../packages/core/src/run-kernel/coordinator.ts";
import type {
  EvaluationCaseId,
  ResolvedRunInput,
  RunId,
  RunState,
} from "../packages/core/src/run-kernel/types.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const CASE_ID = "evaluation-case_migrations" as EvaluationCaseId;

/**
 * The acceptance scenario's wrong check, verbatim: a Safe regex that never
 * matches because it was written against capitalized sample output.
 */
const AS_RUN_CHECK: CheckDefinition = {
  checkId: "check_mentions-migrations",
  kind: "regex",
  syntax: "re2",
  pattern: "Database migrations",
};

const CORRECTED_CHECK: CheckDefinition = { ...AS_RUN_CHECK, flags: "i" };

function planFixture(): EvaluationExperimentPlanV4 {
  const initial = createProjectFile({
    name: "Reassessment fixture",
    idSuffix: "reassessment-fixture",
    createdAt: "2026-08-07T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "https://provider.example.test/v1",
      model: "authored-model",
      messages: [{ role: "user", content: "Explain database migrations." }],
    },
  });
  const project = parseProjectFile({
    ...initial,
    evaluationSuites: [{
      id: "evaluation-suite_topics",
      name: "Topics",
      input: {
        kind: "conversation-revision",
        conversationRevisionId: initial.defaults.conversationRevisionId,
      },
      execution: {
        target: { ...initial.defaults.target },
        responseMode: "buffered",
        options: {},
        repetitions: 2,
        toolIds: [],
      },
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
      inputBindings: [],
      cases: [{ id: CASE_ID, name: "Migrations", values: {}, checks: [AS_RUN_CHECK] }],
    }],
  });
  let suffix = 0;
  return createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    selectedCaseIds: [CASE_ID],
    createdAt: "2026-08-07T12:10:00.000Z",
    createSuffix: () => `reassessment-${++suffix}`,
    runtimeTarget: {
      profileId: "profile_confirmed",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://provider.example.test/v1",
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
  });
}

function completed(input: ResolvedRunInput, text: string): RunState {
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({ type: "text_delta", text, source: { exchangeId: execution.exchangeId } });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop" },
    source: { exchangeId: execution.exchangeId },
  });
  coordinator.finishTurnStream();
  return coordinator.state;
}

/** Both repetitions say the right thing in the wrong case, so As run reads all-failed. */
function executionFixture(): {
  plan: EvaluationExperimentPlanV4;
  result: ExperimentResultV4;
  states: ReadonlyMap<RunId, RunState>;
} {
  const plan = planFixture();
  const states = new Map<RunId, RunState>();
  for (const cell of plan.cells) {
    const state = completed(
      materializeExperimentCellInput(plan, cell.cellId),
      "database migrations need a rollback plan.",
    );
    states.set(state.runId, state);
  }
  return {
    plan,
    result: {
      schemaVersion: 4,
      experimentId: plan.experimentId,
      status: "completed",
      endedAt: "2026-08-07T12:11:00.000Z",
      cells: plan.cells.map((cell) => ({
        cellId: cell.cellId,
        runId: cell.runId,
        status: "completed" as const,
      })),
    },
    states,
  };
}

function corrected(): EvaluationCriteriaOverride {
  return new Map([[CASE_ID, [CORRECTED_CHECK]]]);
}

test("a corrected regex flips exactly the outcomes it should, and only those", () => {
  const { plan, result, states } = executionFixture();
  const asRun = evaluationParsedExperimentAggregate(plan, result, states);
  const reassessed = evaluationParsedExperimentAggregate(plan, result, states, corrected());

  assert.deepEqual(asRun.variants[0]?.caseCounts, { total: 1, passed: 0, failed: 1, incomplete: 0 });
  assert.deepEqual(
    reassessed.variants[0]?.caseCounts,
    { total: 1, passed: 1, failed: 0, incomplete: 0 },
  );

  const diff = diffEvaluationOutcomes(asRun, reassessed);
  assert.equal(diff.unchanged, false);
  assert.deepEqual(
    diff.checks.map(({ checkId, repetition, from, to }) => ({ checkId, repetition, from, to })),
    [
      { checkId: "check_mentions-migrations", repetition: 1, from: "failed", to: "passed" },
      { checkId: "check_mentions-migrations", repetition: 2, from: "failed", to: "passed" },
    ],
  );
  assert.deepEqual(
    diff.repetitions.map(({ repetition, from, to }) => ({ repetition, from, to })),
    [
      { repetition: 1, from: "check-failed", to: "passed" },
      { repetition: 2, from: "check-failed", to: "passed" },
    ],
  );
  assert.deepEqual(
    diff.cases.map(({ caseId, from, to }) => ({ caseId, from, to })),
    [{ caseId: CASE_ID, from: false, to: true }],
  );
  assert.deepEqual(
    diff.variants.map(({ from, to }) => ({ from, to })),
    [{ from: false, to: true }],
  );
});

test("a reinterpretation that changes nothing reports no flips", () => {
  const { plan, result, states } = executionFixture();
  const asRun = evaluationParsedExperimentAggregate(plan, result, states);
  const restated = evaluationParsedExperimentAggregate(
    plan,
    result,
    states,
    new Map([[CASE_ID, [AS_RUN_CHECK]]]),
  );
  const diff = diffEvaluationOutcomes(asRun, restated);
  assert.equal(diff.unchanged, true);
  assert.deepEqual(diff, { checks: [], repetitions: [], cases: [], variants: [], unchanged: true });
});

test("an added check reports as a flip from absent, and a removed one to absent", () => {
  const { plan, result, states } = executionFixture();
  const asRun = evaluationParsedExperimentAggregate(plan, result, states);
  const added: CheckDefinition = {
    checkId: "check_rollback",
    kind: "contains",
    value: "rollback",
    caseSensitive: false,
  };
  const replaced = evaluationParsedExperimentAggregate(
    plan,
    result,
    states,
    new Map([[CASE_ID, [added]]]),
  );
  const diff = diffEvaluationOutcomes(asRun, replaced);
  assert.deepEqual(
    diff.checks
      .filter(({ repetition }) => repetition === 1)
      .map(({ checkId, from, to }) => ({ checkId, from, to })),
    [
      { checkId: "check_rollback", from: "absent", to: "passed" },
      { checkId: "check_mentions-migrations", from: "failed", to: "absent" },
    ],
  );
});

test("As run is byte-stable across deriving, saving, and reopening a reassessment", () => {
  const { plan, result, states } = executionFixture();
  const before = JSON.stringify(evaluationParsedExperimentAggregate(plan, result, states));

  const assessment = createEvaluationAssessment(
    {
      assessmentId: "evaluation-assessment_corrected",
      name: "Corrected regex",
      createdAt: "2026-08-07T13:00:00.000Z",
      criteria: corrected(),
    },
    plan,
  );
  const reopened = parseEvaluationAssessmentJson(
    serializeEvaluationAssessment(assessment, plan),
    plan,
  );
  // The reinterpretation is derived, and it is not the As run reading.
  const underAssessment = evaluationParsedExperimentAggregate(
    plan,
    result,
    states,
    evaluationAssessmentCriteria(reopened),
  );
  assert.equal(underAssessment.variants[0]?.passed, true);

  // Falsification target: leaking the override into the default path breaks
  // this equality, because the plan's own checks never matched.
  const after = JSON.stringify(evaluationParsedExperimentAggregate(plan, result, states));
  assert.equal(after, before);
  assert.equal(evaluationParsedExperimentAggregate(plan, result, states).variants[0]?.passed, false);
});

test("reopening a saved reassessment reproduces the outcomes it was previewed with", () => {
  const { plan, result, states } = executionFixture();
  const previewed = evaluationParsedExperimentAggregate(plan, result, states, corrected());
  const assessment = createEvaluationAssessment(
    {
      assessmentId: "evaluation-assessment_corrected",
      name: "Corrected regex",
      createdAt: "2026-08-07T13:00:00.000Z",
      criteria: corrected(),
    },
    plan,
  );
  const reopened = parseEvaluationAssessmentJson(
    serializeEvaluationAssessment(assessment, plan),
    plan,
  );
  assert.equal(
    JSON.stringify(evaluationParsedExperimentAggregate(
      plan,
      result,
      states,
      evaluationAssessmentCriteria(reopened),
    )),
    JSON.stringify(previewed),
  );
});

test("editing the authored suite afterwards changes no historical score", () => {
  const { plan, result, states } = executionFixture();
  const before = JSON.stringify(evaluationParsedExperimentAggregate(plan, result, states));
  // The plan is the execution's own immutable snapshot. Authoring writes to
  // project.json, which this derivation never reads — asserted by mutating a
  // copy of the authored check and re-deriving from the same plan.
  const authoredNow: CheckDefinition = { ...AS_RUN_CHECK, pattern: "rollback", flags: "i" };
  assert.notEqual(JSON.stringify(authoredNow), JSON.stringify(plan.suite.cases[0]?.checks[0]));
  assert.equal(JSON.stringify(evaluationParsedExperimentAggregate(plan, result, states)), before);
});

test("a replacement check set may not be empty", () => {
  const { plan, result, states } = executionFixture();
  assert.throws(
    () => evaluationParsedExperimentAggregate(plan, result, states, new Map([[CASE_ID, []]])),
    ExperimentValidationError,
  );
});

test("criteria naming a case the execution never ran are ignored, not applied", () => {
  const { plan, result, states } = executionFixture();
  const unknown = new Map([["evaluation-case_absent" as EvaluationCaseId, [CORRECTED_CHECK]]]);
  assert.equal(
    JSON.stringify(evaluationParsedExperimentAggregate(plan, result, states, unknown)),
    JSON.stringify(evaluationParsedExperimentAggregate(plan, result, states)),
  );
});

test("an assessment carries only the cases whose checks actually changed", () => {
  const plan = planFixture();
  const assessment = createEvaluationAssessment(
    {
      assessmentId: "evaluation-assessment_corrected",
      name: "Corrected regex",
      createdAt: "2026-08-07T13:00:00.000Z",
      criteria: new Map([[CASE_ID, [CORRECTED_CHECK]]]),
    },
    plan,
  );
  assert.deepEqual(assessment.cases.map(({ caseId }) => caseId), [CASE_ID]);
  assert.deepEqual(assessment.cases[0]?.checks, [CORRECTED_CHECK]);
});

function authoredSuite(checks: readonly CheckDefinition[], caseId: EvaluationCaseId = CASE_ID) {
  return { cases: [{ caseId, name: "Migrations", values: {}, checks }] };
}

test("the current-criteria preview replaces only the cases whose authored checks differ", () => {
  const plan = planFixture();
  const identical = currentSuiteCriteria(plan, authoredSuite([AS_RUN_CHECK]));
  assert.deepEqual(identical.cases, [
    { caseId: CASE_ID, name: "Migrations", status: "identical" },
  ]);
  assert.equal(identical.criteria.size, 0);

  const changed = currentSuiteCriteria(plan, authoredSuite([CORRECTED_CHECK]));
  assert.deepEqual(changed.cases, [
    { caseId: CASE_ID, name: "Migrations", status: "replaced" },
  ]);
  assert.deepEqual(changed.criteria.get(CASE_ID), [CORRECTED_CHECK]);
});

test("the preview names drift in both directions instead of scoring through it", () => {
  const plan = planFixture();
  const deleted = currentSuiteCriteria(plan, {
    cases: [{
      caseId: "evaluation-case_new" as EvaluationCaseId,
      name: "Added since",
      values: {},
      checks: [CORRECTED_CHECK],
    }],
  });
  assert.deepEqual(
    deleted.cases.map(({ caseId, status }) => ({ caseId, status })),
    [
      { caseId: CASE_ID, status: "absent-from-suite" },
      { caseId: "evaluation-case_new", status: "absent-from-execution" },
    ],
  );
  // Neither direction of drift may reach the aggregate: the deleted case keeps
  // the execution's own checks, and the new one has no evidence at all.
  assert.equal(deleted.criteria.size, 0);

  assert.deepEqual(
    currentSuiteCriteria(plan, undefined).cases.map(({ status }) => status),
    ["absent-from-suite"],
  );
});

test("an unfinished authored check is reported unusable, not scored", () => {
  const plan = planFixture();
  const projection = currentSuiteCriteria(
    plan,
    authoredSuite([{ ...AS_RUN_CHECK, pattern: "" }]),
  );
  assert.equal(projection.cases[0]?.status, "unusable");
  assert.match(projection.cases[0]?.reason ?? "", /pattern/i);
  assert.equal(projection.criteria.size, 0);
});

test("adoption writes aligned cases and names the ones the author deleted", () => {
  const plan = planFixture();
  const criteria = corrected();
  assert.deepEqual(
    planSuiteAdoption(criteria, plan, authoredSuite([AS_RUN_CHECK])),
    {
      adopt: [{ caseId: CASE_ID, name: "Migrations", checks: [CORRECTED_CHECK] }],
      skipped: [],
    },
  );
  assert.deepEqual(
    planSuiteAdoption(criteria, plan, { cases: [] }),
    { adopt: [], skipped: [{ caseId: CASE_ID, name: "Migrations" }] },
  );
});

test("an assessment identical to the execution's own criteria is refused", () => {
  const plan = planFixture();
  assert.throws(
    () => createEvaluationAssessment(
      {
        assessmentId: "evaluation-assessment_noop",
        name: "No change",
        createdAt: "2026-08-07T13:00:00.000Z",
        criteria: new Map([[CASE_ID, [AS_RUN_CHECK]]]),
      },
      plan,
    ),
    EvaluationAssessmentError,
  );
});
