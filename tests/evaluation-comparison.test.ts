import assert from "node:assert/strict";
import test from "node:test";

import { createEvaluationExperimentPlan } from "../packages/core/src/evaluation-execution.ts";
import { alignSuiteSnapshots } from "../packages/core/src/evaluation-suite-alignment.ts";
import { compareEvaluationExecutions } from "../packages/core/src/evaluation-comparison.ts";
import type { EvaluationComparisonInput } from "../packages/core/src/evaluation-comparison.ts";
import {
  materializeExperimentCellInput,
  type EvaluationExperimentPlanV3,
  type ExperimentResultV3,
} from "../packages/core/src/experiment.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectFile,
  updatePromptTemplateUseValues,
  type ProjectFile,
} from "../packages/core/src/project.ts";
import { RunCoordinator } from "../packages/core/src/run-kernel/coordinator.ts";
import type { CheckDefinition } from "../packages/core/src/checks.ts";
import type { ResolvedRunInput, RunId, RunState } from "../packages/core/src/run-kernel/types.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

interface CaseFixture {
  id: string;
  name: string;
  topic: string;
  checks: CheckDefinition[];
}

const containsCheck = (checkId: string, value: string): CheckDefinition => ({
  checkId: checkId as CheckDefinition["checkId"],
  kind: "contains",
  value,
  caseSensitive: false,
});

function projectFixture(cases: CaseFixture[], model = "confirmed-model"): ProjectFile {
  let project = createProjectFile({
    name: "Comparison",
    idSuffix: "comparison",
    createdAt: "2026-08-01T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "https://provider.example.test/v1",
      model: "authored-model",
      messages: [{ role: "system", content: "System context" }],
    },
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "question",
    revisionIdSuffix: "question-1",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
  const revisionId = project.defaults.conversationRevisionId;
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: revisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
    outputMessageIdSuffixes: ["question-output"],
  });
  project = updatePromptTemplateUseValues(project, {
    conversationRevisionId: revisionId,
    templateUseId: "template-use_question-use",
    values: {},
  });
  return parseProjectFile({
    ...project,
    evaluationSuites: [{
      id: "evaluation-suite_topics",
      name: "Topics",
      input: { kind: "conversation-revision", conversationRevisionId: revisionId },
      execution: {
        target: { ...project.defaults.target, model },
        responseMode: "buffered",
        options: { temperature: 0.2 },
        repetitions: 1,
        toolIds: [],
      },
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
      inputBindings: [{
        id: "evaluation-input_topic",
        name: "Topic",
        target: {
          kind: "template-variable",
          templateUseId: "template-use_question-use",
          variableName: "topic",
        },
      }],
      cases: cases.map((item) => ({
        id: item.id,
        name: item.name,
        values: { "evaluation-input_topic": item.topic },
        checks: item.checks,
      })),
    }],
  });
}

let planSuffix = 0;

function planFixture(cases: CaseFixture[], model?: string): EvaluationExperimentPlanV3 {
  const project = projectFixture(cases, model);
  const batch = ++planSuffix;
  let suffix = 0;
  return createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    selectedCaseIds: cases.map((item) => item.id as never),
    createdAt: `2026-08-01T12:${String(10 + batch).padStart(2, "0")}:00.000Z`,
    createSuffix: () => `p${batch}-${++suffix}`,
    runtimeTarget: {
      profileId: "profile_confirmed",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://confirmed.example.test/v1",
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

/** Runs every cell, taking each case's output from `outputs` by case id. */
function execute(
  plan: EvaluationExperimentPlanV3,
  outputs: Record<string, string>,
  options: { skipRunIds?: readonly RunId[] } = {},
): { result: ExperimentResultV3; states: Map<RunId, RunState> } {
  const skipped = new Set(options.skipRunIds ?? []);
  const states = new Map<RunId, RunState>();
  for (const cell of plan.cells) {
    const input = materializeExperimentCellInput(plan, cell.cellId);
    const state = completed(input, outputs[cell.caseId] ?? "");
    if (!skipped.has(cell.runId)) states.set(cell.runId, state);
  }
  return {
    result: {
      schemaVersion: 4,
      experimentId: plan.experimentId,
      status: "completed",
      endedAt: "2026-08-01T12:30:00.000Z",
      cells: plan.cells.map((cell) => ({
        cellId: cell.cellId,
        runId: cell.runId,
        status: "completed" as const,
      })),
    },
    states,
  };
}

function comparisonInput(
  plan: EvaluationExperimentPlanV3,
  run: { result: ExperimentResultV3; states: Map<RunId, RunState> },
): EvaluationComparisonInput {
  return {
    experimentId: plan.experimentId,
    plan,
    variantId: plan.suite.variants[0]!.variantId,
    ...run,
  };
}

const migrations: CaseFixture = {
  id: "evaluation-case_migrations",
  name: "Migrations",
  topic: "database migrations",
  checks: [containsCheck("check_migrations", "migration")],
};
const backups: CaseFixture = {
  id: "evaluation-case_backups",
  name: "Backups",
  topic: "backups",
  checks: [containsCheck("check_backups", "backup")],
};

test("alignment classifies added, removed, and incompatible cases by stable identity", () => {
  const baseline = planFixture([migrations, backups]);
  const candidate = planFixture([
    { ...migrations, checks: [containsCheck("check_migrations", "rollback")] },
    { id: "evaluation-case_indexes", name: "Indexes", topic: "indexes", checks: [containsCheck("check_indexes", "index")] },
  ]);
  const alignment = alignSuiteSnapshots(baseline.suite, candidate.suite);
  assert.deepEqual(
    alignment.cases.map(({ caseId, status }) => [caseId, status]),
    [
      ["evaluation-case_migrations", "incompatible"],
      ["evaluation-case_backups", "removed"],
      ["evaluation-case_indexes", "added"],
    ],
  );
  assert.deepEqual(alignment.cases[0]?.reasons, ["checks-changed"]);
  assert.deepEqual(alignment.counts, { aligned: 0, incompatible: 1, added: 1, removed: 1 });
});

test("a changed input value is an incompatible case, not a regression", () => {
  const baseline = planFixture([migrations]);
  const candidate = planFixture([{ ...migrations, topic: "schema migrations" }]);
  const baselineRun = execute(baseline, { [migrations.id]: "Plan the migration." });
  const candidateRun = execute(candidate, { [migrations.id]: "Nothing relevant." });
  const comparison = compareEvaluationExecutions(
    comparisonInput(baseline, baselineRun),
    comparisonInput(candidate, candidateRun),
  );
  assert.equal(comparison.cases[0]?.alignment, "incompatible");
  assert.deepEqual(comparison.cases[0]?.reasons, ["values-changed"]);
  assert.equal(comparison.cases[0]?.delta, "incomparable");
  assert.equal(comparison.counts.regressed, 0);
});

test("a flipped case reads as a regression and its counterpart as a fix", () => {
  const baseline = planFixture([migrations, backups]);
  const candidate = planFixture([migrations, backups]);
  const baselineRun = execute(baseline, {
    [migrations.id]: "Plan the migration.",
    [backups.id]: "Nothing relevant.",
  });
  const candidateRun = execute(candidate, {
    [migrations.id]: "Nothing relevant.",
    [backups.id]: "Keep a backup.",
  });
  const comparison = compareEvaluationExecutions(
    comparisonInput(baseline, baselineRun),
    comparisonInput(candidate, candidateRun),
  );
  assert.deepEqual(
    comparison.cases.map(({ name, delta }) => [name, delta]),
    [["Migrations", "regressed"], ["Backups", "fixed"]],
  );
  assert.equal(comparison.counts.regressed, 1);
  assert.equal(comparison.counts.fixed, 1);
  assert.equal(comparison.counts.aligned, 2);
  assert.equal(comparison.baseline.caseCounts.passed, 1);
  assert.equal(comparison.candidate.caseCounts.passed, 1);
  assert.equal(comparison.drift.any, false);
});

test("a missing trace is reported on its side rather than dropped from the denominator", () => {
  const baseline = planFixture([migrations, backups]);
  const candidate = planFixture([migrations, backups]);
  const baselineRun = execute(baseline, {
    [migrations.id]: "Plan the migration.",
    [backups.id]: "Keep a backup.",
  });
  const missingRunId = candidate.cells.find(
    ({ caseId }) => caseId === backups.id,
  )!.runId;
  const candidateRun = execute(
    candidate,
    { [migrations.id]: "Plan the migration.", [backups.id]: "Keep a backup." },
    { skipRunIds: [missingRunId] },
  );
  const comparison = compareEvaluationExecutions(
    comparisonInput(baseline, baselineRun),
    comparisonInput(candidate, candidateRun),
  );
  const backupsCase = comparison.cases.find(({ name }) => name === "Backups");
  assert.equal(backupsCase?.candidate?.missingTrace, 1);
  assert.equal(backupsCase?.candidate?.passed, false);
  assert.equal(backupsCase?.delta, "regressed");
  // The case is still counted on both sides: two cases in, two cases out.
  assert.equal(comparison.candidate.caseCounts.total, 2);
  assert.equal(comparison.candidate.repetitionCounts["trace-unavailable"], 1);
  // Its checks are not evaluated rather than silently absent.
  assert.equal(backupsCase?.candidate?.checkCounts.total, 1);
  assert.equal(backupsCase?.candidate?.checkCounts.notEvaluated, 1);
});

test("a changed target model is drift context, not case incompatibility", () => {
  const baseline = planFixture([migrations], "model-a");
  const candidate = planFixture([migrations], "model-b");
  const baselineRun = execute(baseline, { [migrations.id]: "Plan the migration." });
  const candidateRun = execute(candidate, { [migrations.id]: "Nothing relevant." });
  const comparison = compareEvaluationExecutions(
    comparisonInput(baseline, baselineRun),
    comparisonInput(candidate, candidateRun),
  );
  assert.deepEqual(comparison.drift.model, { baseline: "model-a", candidate: "model-b" });
  assert.equal(comparison.drift.any, true);
  assert.equal(comparison.cases[0]?.alignment, "aligned");
  assert.equal(comparison.cases[0]?.delta, "regressed");
});

test("comparison selects explicit variant slices from one bakeoff", () => {
  const project = projectFixture([migrations], "model-a");
  const suite = project.evaluationSuites[0]!;
  suite.variants = [
    { id: "evaluation-variant_a", name: "Model A", overrides: {} },
    { id: "evaluation-variant_b", name: "Model B", overrides: { target: { model: "model-b" } } },
  ];
  const plan = createEvaluationExperimentPlan({
    project,
    suiteId: suite.id,
    selectedCaseIds: [migrations.id as never],
    selectedVariantIds: ["evaluation-variant_a", "evaluation-variant_b"],
    createdAt: "2026-08-01T16:00:00.000Z",
    createSuffix: (() => { let index = 0; return () => `multi-${++index}`; })(),
    runtimeTargets: {
      "evaluation-variant_a": {
        profileId: "profile_a", protocol: "openai-compatible-chat-completions",
        endpoint: "https://confirmed.example.test/v1", capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      "evaluation-variant_b": {
        profileId: "profile_b", protocol: "openai-compatible-chat-completions",
        endpoint: "https://confirmed.example.test/v1", capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
    },
  });
  const run = execute(plan, { [migrations.id]: "Plan the migration." });
  const comparison = compareEvaluationExecutions(
    { experimentId: plan.experimentId, plan, variantId: "evaluation-variant_a", ...run },
    { experimentId: plan.experimentId, plan, variantId: "evaluation-variant_b", ...run },
  );
  assert.equal(comparison.baseline.variantName, "Model A");
  assert.equal(comparison.candidate.variantName, "Model B");
  assert.deepEqual(comparison.drift.model, { baseline: "model-a", candidate: "model-b" });
});

test("per-check tallies align by check identity across both sides", () => {
  const baseline = planFixture([migrations]);
  const candidate = planFixture([migrations]);
  const baselineRun = execute(baseline, { [migrations.id]: "Plan the migration." });
  const candidateRun = execute(candidate, { [migrations.id]: "Nothing relevant." });
  const comparison = compareEvaluationExecutions(
    comparisonInput(baseline, baselineRun),
    comparisonInput(candidate, candidateRun),
  );
  const check = comparison.cases[0]?.checks[0];
  assert.equal(check?.status, "aligned");
  assert.deepEqual(check?.baseline, { passed: 1, failed: 0, notEvaluated: 0 });
  assert.deepEqual(check?.candidate, { passed: 0, failed: 1, notEvaluated: 0 });
});

test("repetition evidence preserves a regression that occurs only in repetition two", () => {
  const project = projectFixture([migrations]);
  project.evaluationSuites[0]!.execution.repetitions = 2;
  const createPlan = (suffix: string) => createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    selectedCaseIds: [migrations.id as never],
    createdAt: "2026-08-01T17:00:00.000Z",
    createSuffix: (() => { let index = 0; return () => `${suffix}-${++index}`; })(),
    runtimeTarget: {
      profileId: "profile_confirmed",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://confirmed.example.test/v1",
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
  });
  const baseline = createPlan("baseline-repetition");
  const candidate = createPlan("candidate-repetition");
  const run = (plan: EvaluationExperimentPlanV3, output: (repetition: number) => string) => {
    const states = new Map<RunId, RunState>();
    for (const cell of plan.cells) {
      states.set(cell.runId, completed(materializeExperimentCellInput(plan, cell.cellId), output(cell.repetition)));
    }
    return {
      result: {
        schemaVersion: 4 as const, experimentId: plan.experimentId, status: "completed" as const,
        endedAt: "2026-08-01T17:01:00.000Z",
        cells: plan.cells.map((cell) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed" as const })),
      },
      states,
    };
  };
  const comparison = compareEvaluationExecutions(
    comparisonInput(baseline, run(baseline, () => "Plan the migration.")),
    comparisonInput(candidate, run(candidate, (repetition) => repetition === 2 ? "Nothing relevant." : "Plan the migration.")),
  );
  assert.deepEqual(
    comparison.cases[0]?.repetitions.map(({ repetition, delta }) => [repetition, delta]),
    [[1, "unchanged-pass"], [2, "regressed"]],
  );
});
