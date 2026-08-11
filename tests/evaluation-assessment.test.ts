import assert from "node:assert/strict";
import test from "node:test";

import {
  EVALUATION_ASSESSMENT_NAME_MAX_LENGTH,
  EvaluationAssessmentError,
  evaluationAssessmentFileName,
  parseEvaluationAssessmentJson,
  serializeEvaluationAssessment,
} from "../packages/core/src/evaluation-assessment.ts";
import type { EvaluationAssessmentV1 } from "../packages/core/src/evaluation-assessment.ts";
import { CHECK_SCHEMA_VERSION } from "../packages/core/src/checks.ts";
import { createEvaluationExperimentPlan } from "../packages/core/src/evaluation-execution.ts";
import type {
  EvaluationExperimentPlanV3,
  RepeatedExperimentPlanV3,
} from "../packages/core/src/experiment.ts";
import { createProjectFile, parseProjectFile } from "../packages/core/src/project.ts";
import { createResolvedRunInput } from "../packages/core/src/run-kernel/run-execution.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

function evaluationPlan(): EvaluationExperimentPlanV3 {
  const initial = createProjectFile({
    name: "Assessment fixture",
    idSuffix: "assessment-fixture",
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
        repetitions: 1,
        toolIds: [],
      },
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
      inputBindings: [],
      cases: [{
        id: "evaluation-case_migrations",
        name: "Migrations",
        values: {},
        checks: [{
          checkId: "check_mentions-migrations",
          kind: "contains",
          value: "migration",
          caseSensitive: false,
        }],
      }],
    }],
  });
  let suffix = 0;
  return createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    selectedCaseIds: ["evaluation-case_migrations"],
    createdAt: "2026-08-07T12:10:00.000Z",
    createSuffix: () => `assessment-${++suffix}`,
    runtimeTarget: {
      profileId: "profile_confirmed",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://provider.example.test/v1",
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
  });
}

function assessment(plan: EvaluationExperimentPlanV3): EvaluationAssessmentV1 {
  return {
    schemaVersion: 1,
    assessmentId: "evaluation-assessment_corrected",
    experimentId: plan.experimentId,
    name: "Corrected regex",
    createdAt: "2026-08-07T13:00:00.000Z",
    checkSchemaVersion: CHECK_SCHEMA_VERSION,
    scoringPolicy: "strict",
    cases: [{
      caseId: "evaluation-case_migrations",
      checks: [{
        checkId: "check_mentions-migrations",
        kind: "contains",
        value: "migrat",
        caseSensitive: false,
      }],
    }],
  };
}

function repeatedPlan(): RepeatedExperimentPlanV3 {
  const input = createResolvedRunInput(
    {
      provider: "openai-compatible",
      endpoint: "https://provider.example.test/v1",
      model: "example-model",
      messages: [{ role: "user", content: "Say hello" }],
    },
    {
      conversationId: "conversation_repeated",
      conversationRevisionId: "revision_repeated",
    },
    [],
    [],
    "source",
    "2026-08-07T12:00:00.000Z",
  );
  const { runId: sourceRunId, ...commonInput } = input;
  assert.equal(sourceRunId, "run_source");
  return {
    schemaVersion: 4,
    experimentId: "experiment_repeated",
    kind: "repeated-request",
    createdAt: "2026-08-07T12:00:01.000Z",
    commonInput,
    cells: [
      { cellId: "experiment-cell_first", ordinal: 1, runId: "run_first" },
      { cellId: "experiment-cell_second", ordinal: 2, runId: "run_second" },
    ],
  };
}

test("names a reassessment by its own identity and refuses an unsafe one", () => {
  assert.equal(
    evaluationAssessmentFileName("evaluation-assessment_corrected"),
    "evaluation-assessment_corrected.assessment.json",
  );
  assert.throws(
    // The name carries no experiment ID on purpose; the artifact's own
    // `experimentId` field is the single source of truth.
    () => evaluationAssessmentFileName("experiment_first" as never),
    EvaluationAssessmentError,
  );
  assert.throws(
    () => evaluationAssessmentFileName("evaluation-assessment_../secret" as never),
    EvaluationAssessmentError,
  );
});

test("round-trips a reassessment deterministically", () => {
  const plan = evaluationPlan();
  const source = assessment(plan);
  const serialized = serializeEvaluationAssessment(source, plan);
  const parsed = parseEvaluationAssessmentJson(serialized, plan);

  assert.deepEqual(parsed, source);
  assert.equal(serializeEvaluationAssessment(parsed, plan), serialized);
});

test("carries criteria only — never execution, evidence, or output", () => {
  const plan = evaluationPlan();
  const source = assessment(plan);
  for (const smuggled of ["suite", "variants", "repetitions", "cells", "turnCeiling", "outputs"]) {
    const widened = JSON.parse(serializeEvaluationAssessment(source, plan));
    widened[smuggled] = {};
    assert.throws(
      () => parseEvaluationAssessmentJson(JSON.stringify(widened), plan),
      EvaluationAssessmentError,
      `${smuggled} should be refused`,
    );
  }

  const smuggledCaseValues = JSON.parse(serializeEvaluationAssessment(source, plan));
  smuggledCaseValues.cases[0].values = {};
  assert.throws(
    () => parseEvaluationAssessmentJson(JSON.stringify(smuggledCaseValues), plan),
    EvaluationAssessmentError,
  );
});

test("aligns cases against the execution, not against the authored suite", () => {
  const plan = evaluationPlan();
  const unknownCase = structuredClone(assessment(plan));
  unknownCase.cases[0]!.caseId = "evaluation-case_added-later";
  assert.throws(
    () => serializeEvaluationAssessment(unknownCase, plan),
    /which the execution did not run/,
  );

  const otherExperiment = structuredClone(assessment(plan));
  otherExperiment.experimentId = "experiment_other";
  assert.throws(
    () => serializeEvaluationAssessment(otherExperiment, plan),
    /belongs to a different experiment/,
  );

  assert.throws(
    () => serializeEvaluationAssessment(assessment(plan), repeatedPlan()),
    /has no checks/,
  );
});

test("refuses a duplicate case, a duplicate check, and an emptied case", () => {
  const plan = evaluationPlan();

  const duplicateCase = structuredClone(assessment(plan));
  duplicateCase.cases.push(structuredClone(duplicateCase.cases[0]!));
  assert.throws(() => serializeEvaluationAssessment(duplicateCase, plan), /repeats case/);

  const duplicateCheck = structuredClone(assessment(plan));
  duplicateCheck.cases[0]!.checks.push(structuredClone(duplicateCheck.cases[0]!.checks[0]!));
  assert.throws(() => serializeEvaluationAssessment(duplicateCheck, plan), /repeats check/);

  // Strict scoring over zero checks has no meaning, so a reassessment cannot
  // blank a case; omitting the case entirely keeps the execution's own checks.
  const emptied = structuredClone(assessment(plan));
  emptied.cases[0]!.checks = [];
  assert.throws(() => serializeEvaluationAssessment(emptied, plan), EvaluationAssessmentError);

  const noCases = structuredClone(assessment(plan));
  noCases.cases = [];
  assert.throws(() => serializeEvaluationAssessment(noCases, plan), EvaluationAssessmentError);
});

test("pins the check vocabulary and the scoring policy as literals", () => {
  const plan = evaluationPlan();
  const source = assessment(plan);

  const olderVocabulary = JSON.parse(serializeEvaluationAssessment(source, plan));
  olderVocabulary.checkSchemaVersion = CHECK_SCHEMA_VERSION - 1;
  assert.throws(
    () => parseEvaluationAssessmentJson(JSON.stringify(olderVocabulary), plan),
    EvaluationAssessmentError,
  );

  const otherPolicy = JSON.parse(serializeEvaluationAssessment(source, plan));
  otherPolicy.scoringPolicy = "lenient";
  assert.throws(
    () => parseEvaluationAssessmentJson(JSON.stringify(otherPolicy), plan),
    EvaluationAssessmentError,
  );

  const staleFile = JSON.parse(serializeEvaluationAssessment(source, plan));
  staleFile.schemaVersion = 2;
  assert.throws(
    () => parseEvaluationAssessmentJson(JSON.stringify(staleFile), plan),
    /Version 2 is unsupported; expected Version 1/,
  );
});

test("requires a usable name", () => {
  const plan = evaluationPlan();

  const blank = structuredClone(assessment(plan));
  blank.name = "   ";
  assert.throws(() => serializeEvaluationAssessment(blank, plan), EvaluationAssessmentError);

  const tooLong = structuredClone(assessment(plan));
  tooLong.name = "c".repeat(EVALUATION_ASSESSMENT_NAME_MAX_LENGTH + 1);
  assert.throws(() => serializeEvaluationAssessment(tooLong, plan), EvaluationAssessmentError);
});

test("is not valid JSON is reported as such", () => {
  assert.throws(
    () => parseEvaluationAssessmentJson("{", evaluationPlan()),
    /not valid JSON/,
  );
});
