import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluationExperimentAggregate,
  materializeExperimentCellInput,
  parseExperimentPlanJson,
  serializeExperimentPlan,
} from "../packages/core/src/experiment.ts";
import { createEvaluationExperimentPlan, EvaluationSetupError } from "../packages/core/src/evaluation-execution.ts";
import { evaluationSuitePreflight } from "../packages/core/src/evaluation-suites.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectFile,
  updatePromptTemplateUseValues,
} from "../packages/core/src/project.ts";
import { RunCoordinator } from "../packages/core/src/run-kernel/coordinator.ts";
import type { EvaluationCaseId, ResolvedRunInput } from "../packages/core/src/run-kernel/types.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import type { ProviderTurnTransport } from "../packages/contracts/src/inference.ts";
import { SequentialExperimentController } from "../app/run/sequential-experiment-controller.client.ts";

function projectFixture(withChecks = true) {
  let project = createProjectFile({
    name: "Evaluation execution",
    idSuffix: "evaluation-execution",
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
    messages: [{ role: "user", content: "Explain {{topic}} in a {{style}} style." }],
    variableDefaults: { style: "plain" },
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
    values: { style: "authored" },
  });
  return parseProjectFile({
    ...project,
    evaluationSuites: [{
      id: "evaluation-suite_topics",
      name: "Topics",
      inputBindings: [{
        id: "evaluation-input_topic",
        name: "Topic",
        target: {
          kind: "template-variable",
          templateUseId: "template-use_question-use",
          variableName: "topic",
        },
      }],
      cases: [{
        id: "evaluation-case_migrations",
        name: "Migrations",
        values: { "evaluation-input_topic": "database migrations" },
        checks: withChecks ? [{
          checkId: "check_mentions-migrations",
          kind: "contains",
          value: "migration",
          caseSensitive: false,
        }] : [],
      }],
    }],
  });
}

function planFixture(repetitions = 2) {
  const project = projectFixture();
  let suffix = 0;
  return createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    conversationRevisionId: project.defaults.conversationRevisionId,
    selectedCaseIds: ["evaluation-case_migrations"],
    repetitions,
    createdAt: "2026-08-01T12:10:00.000Z",
    createSuffix: () => `fixture-${++suffix}`,
    execution: {
      target: {
        profileId: "profile_confirmed",
        protocol: "openai-compatible-chat-completions",
        endpoint: "https://confirmed.example.test/v1",
        model: "confirmed-model",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      responseMode: "buffered",
      options: { temperature: 0.2, seed: 7 },
      tools: [],
    },
  });
}

function completed(input: ResolvedRunInput, text: string, usage?: { inputTokens: number; outputTokens: number; totalTokens: number }) {
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({
    type: "text_delta",
    text,
    source: { exchangeId: execution.exchangeId },
  });
  if (usage) coordinator.accept({ type: "usage", usage, source: { exchangeId: execution.exchangeId } });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop" },
    source: { exchangeId: execution.exchangeId },
  });
  coordinator.finishTurnStream();
  return coordinator.state;
}

test("rejects selected zero-check cases before an evaluation plan exists", () => {
  const project = projectFixture(false);
  assert.deepEqual(
    evaluationSuitePreflight(
      project,
      "evaluation-suite_topics",
      project.defaults.conversationRevisionId,
      ["evaluation-case_migrations"],
    ).map(({ code }) => code),
    ["no-checks"],
  );
  assert.throws(
    () => createEvaluationExperimentPlan({
      project,
      suiteId: "evaluation-suite_topics",
      conversationRevisionId: project.defaults.conversationRevisionId,
      selectedCaseIds: ["evaluation-case_migrations"],
      repetitions: 1,
      execution: {
        target: {
          profileId: "profile_test",
          protocol: "openai-compatible-chat-completions",
          endpoint: "https://provider.example.test/v1",
          model: "test",
          capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
        },
        responseMode: "streaming",
        options: {},
        tools: [],
      },
    }),
    EvaluationSetupError,
  );
});

test("snapshots authored values, case overrides, and confirmation-time execution settings", () => {
  const plan = planFixture();
  const parsed = parseExperimentPlanJson(serializeExperimentPlan(plan));
  assert.equal(parsed.kind, "evaluation");
  if (parsed.kind !== "evaluation") throw new Error("Expected evaluation plan.");
  assert.equal(parsed.cells.length, 2);
  assert.deepEqual(parsed.cells.map(({ repetition }) => repetition), [1, 2]);
  assert.equal(parsed.suite.cases[0]?.input.target.model, "confirmed-model");
  assert.equal(parsed.suite.cases[0]?.input.responseMode, "buffered");
  assert.deepEqual(parsed.suite.cases[0]?.input.options, { seed: 7, temperature: 0.2 });
  assert.equal(parsed.suite.cases[0]?.input.templateResolutions[0]?.values.style, "authored");
  assert.equal(parsed.suite.cases[0]?.input.templateResolutions[0]?.values.topic, "database migrations");
  assert.equal(parsed.suite.cases[0]?.input.messages.at(-1)?.content[0]?.text, "Explain database migrations in a authored style.");
  const first = materializeExperimentCellInput(parsed, parsed.cells[0]!.cellId);
  assert.equal(first.runId, parsed.cells[0]?.runId);
  assert.deepEqual(
    { ...first, runId: undefined },
    { ...parsed.suite.cases[0]!.input, runId: undefined },
  );
});

test("strict scoring keeps check failure distinct and fails the whole case and suite", () => {
  const plan = planFixture();
  const first = completed(
    materializeExperimentCellInput(plan, plan.cells[0]!.cellId),
    "Database migrations need a rollback plan.",
    { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  );
  const second = completed(
    materializeExperimentCellInput(plan, plan.cells[1]!.cellId),
    "Use backups.",
  );
  const result = {
    schemaVersion: 3 as const,
    experimentId: plan.experimentId,
    status: "completed" as const,
    endedAt: "2026-08-01T12:11:00.000Z",
    cells: plan.cells.map((cell) => ({
      cellId: cell.cellId,
      runId: cell.runId,
      status: "completed" as const,
    })),
  };
  const aggregate = evaluationExperimentAggregate(
    plan,
    result,
    new Map([[first.runId, first], [second.runId, second]]),
  );
  assert.equal(aggregate.passed, false);
  assert.deepEqual(aggregate.caseCounts, { total: 1, passed: 0, failed: 1 });
  assert.equal(aggregate.repetitionCounts.passed, 1);
  assert.equal(aggregate.repetitionCounts["check-failed"], 1);
  assert.deepEqual(aggregate.checkCounts, { total: 2, passed: 1, failed: 1, notEvaluated: 0 });
  assert.deepEqual(aggregate.totalTokens, { reportedRuns: 1, total: 30 });
  assert.deepEqual(aggregate.outputTokens, { reportedRuns: 1, total: 10 });
  assert.equal(aggregate.cases[0]?.caseId, "evaluation-case_migrations" as EvaluationCaseId);
});

test("missing traces and cancellation remain separate non-passing classifications", () => {
  const plan = planFixture();
  const firstInput = materializeExperimentCellInput(plan, plan.cells[0]!.cellId);
  const firstCoordinator = new RunCoordinator(firstInput);
  firstCoordinator.start();
  firstCoordinator.cancel("Stopped");
  const result = {
    schemaVersion: 3 as const,
    experimentId: plan.experimentId,
    status: "cancelled" as const,
    endedAt: "2026-08-01T12:11:00.000Z",
    cells: [
      { cellId: plan.cells[0]!.cellId, runId: plan.cells[0]!.runId, status: "cancelled" as const },
      { cellId: plan.cells[1]!.cellId, runId: plan.cells[1]!.runId, status: "completed" as const },
    ],
  };
  const aggregate = evaluationExperimentAggregate(
    plan,
    result,
    new Map([[firstInput.runId, firstCoordinator.state]]),
  );
  assert.equal(aggregate.repetitionCounts.cancelled, 1);
  assert.equal(aggregate.repetitionCounts["missing-trace"], 1);
  assert.equal(aggregate.checkCounts.notEvaluated, 2);
  assert.equal(aggregate.lifecycle, "cancelled");
});

test("the shared sequential controller executes evaluation cells as ordinary runs", async () => {
  const plan = planFixture();
  const started: string[] = [];
  const traces: string[] = [];
  const transport: ProviderTurnTransport = {
    async discoverModels() { return { models: [] }; },
    async executeTurn({ execution }) {
      started.push(execution.runId);
      return {
        status: 200,
        headers: new Headers(),
        events: (async function* () {
          yield { type: "text_delta" as const, text: `migration ${execution.runId}` };
          yield { type: "completed" as const, finishReason: { normalized: "stop" as const } };
        })(),
      };
    },
  };
  const result = await new SequentialExperimentController({
    plan,
    transport,
    async prepareCredential() { return { kind: "none" }; },
    onTerminalTrace(trace) { traces.push(trace.runId); },
  }).run();
  assert.equal(result.status, "completed");
  assert.deepEqual(started, plan.cells.map(({ runId }) => runId));
  assert.deepEqual(traces, started);
});
