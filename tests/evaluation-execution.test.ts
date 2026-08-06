import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluationExperimentAggregate,
  experimentExposedTools,
  evaluationParsedExperimentAggregate,
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
      input: { kind: "conversation-revision", conversationRevisionId: revisionId },
      execution: {
        target: { ...project.defaults.target },
        responseMode: "buffered",
        options: { temperature: 0.2, seed: 7 },
        repetitions: 2,
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
  const initial = projectFixture();
  const project = parseProjectFile({
    ...initial,
    evaluationSuites: initial.evaluationSuites.map((suite) => ({
      ...suite,
      execution: {
        ...suite.execution,
        target: { ...suite.execution.target, model: "confirmed-model" },
        responseMode: "buffered",
        options: { temperature: 0.2, seed: 7 },
        repetitions,
      },
    })),
  });
  let suffix = 0;
  return createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    selectedCaseIds: ["evaluation-case_migrations"],
    createdAt: "2026-08-01T12:10:00.000Z",
    createSuffix: () => `fixture-${++suffix}`,
    runtimeTarget: {
        profileId: "profile_confirmed",
        protocol: "openai-compatible-chat-completions",
        endpoint: "https://confirmed.example.test/v1",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
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
      selectedCaseIds: ["evaluation-case_migrations"],
      runtimeTarget: {
          profileId: "profile_test",
          protocol: "openai-compatible-chat-completions",
          endpoint: "https://provider.example.test/v1",
          capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
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
  assert.equal(parsed.suite.variants[0]?.target.model, "confirmed-model");
  assert.equal(parsed.suite.variants[0]?.responseMode, "buffered");
  assert.deepEqual(parsed.suite.variants[0]?.options, { seed: 7, temperature: 0.2 });
  assert.equal(parsed.suite.cases[0]?.input.templateResolutions[0]?.values.style, "authored");
  assert.equal(parsed.suite.cases[0]?.input.templateResolutions[0]?.values.topic, "database migrations");
  assert.equal(parsed.suite.cases[0]?.input.messages.at(-1)?.content[0]?.text, "Explain database migrations in a authored style.");
  const first = materializeExperimentCellInput(parsed, parsed.cells[0]!.cellId);
  assert.equal(first.runId, parsed.cells[0]?.runId);
  assert.deepEqual(
    { ...first, runId: undefined },
    { ...parsed.suite.cases[0]!.input, ...parsed.suite.variants[0]!, tools: parsed.suite.tools, runId: undefined },
  );
});

test("a suite's exposed tools are snapshotted into every case, with its turn ceiling", () => {
  const initial = projectFixture();
  const project = parseProjectFile({
    ...initial,
    tools: [
      {
        id: "tool_weather",
        name: "get_weather",
        description: "Current conditions",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        id: "tool_unused",
        name: "query_db",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    evaluationSuites: initial.evaluationSuites.map((suite) => ({
      ...suite,
      execution: { ...suite.execution, toolIds: ["tool_weather"], turnCeiling: 3 },
    })),
  });
  const plan = createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    selectedCaseIds: ["evaluation-case_migrations"],
    createdAt: "2026-08-01T12:10:00.000Z",
    createSuffix: (() => { let n = 0; return () => `tools-${++n}`; })(),
    runtimeTarget: {
      profileId: "profile_confirmed",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://provider.example.test/v1",
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
  });
  const parsed = parseExperimentPlanJson(serializeExperimentPlan(plan));
  if (parsed.kind !== "evaluation") throw new Error("Expected evaluation plan.");
  // Only the exposed descriptor, and the whole descriptor: the plan is what the
  // provider will be sent, so a partial snapshot would be a different request.
  assert.deepEqual(parsed.suite.tools, [{
    id: "tool_weather",
    name: "get_weather",
    description: "Current conditions",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }]);
  assert.equal(parsed.turnCeiling, 3);
  assert.deepEqual(
    experimentExposedTools(parsed).map(({ name }) => name),
    ["get_weather"],
  );
});

test("a suite that exposes nothing produces a plan with no tools and no ceiling", () => {
  const plan = planFixture();
  assert.deepEqual(plan.suite.tools, []);
  assert.equal(plan.turnCeiling, undefined);
  assert.deepEqual(experimentExposedTools(plan), []);
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
    schemaVersion: 4 as const,
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

test("live evaluations do not report unstarted cases as failed", () => {
  const plan = planFixture();
  const aggregate = evaluationParsedExperimentAggregate(plan, undefined, new Map());
  assert.deepEqual(aggregate.caseCounts, { total: 1, passed: 0, failed: 0 });
});

test("missing traces and cancellation remain separate non-passing classifications", () => {
  const plan = planFixture();
  const firstInput = materializeExperimentCellInput(plan, plan.cells[0]!.cellId);
  const firstCoordinator = new RunCoordinator(firstInput);
  firstCoordinator.start();
  firstCoordinator.cancel("Stopped");
  const result = {
    schemaVersion: 4 as const,
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

test("the controller prepares each configuration target before deterministic execution", async () => {
  const initial = projectFixture();
  const secondRequirement = {
    ...initial.connectionRequirements[0]!,
    id: "connection_second" as const,
    name: "Second provider",
    endpoint: "https://second.example.test/v1",
  };
  const project = parseProjectFile({
    ...initial,
    connectionRequirements: [...initial.connectionRequirements, secondRequirement],
    evaluationSuites: initial.evaluationSuites.map((suite) => ({
      ...suite,
      execution: { ...suite.execution, repetitions: 1 },
      variants: [
        { id: "evaluation-variant_first", name: "First", overrides: { target: { model: "first-model" } } },
        { id: "evaluation-variant_second", name: "Second", overrides: { target: { connectionRequirementId: secondRequirement.id, model: "second-model" } } },
      ],
    })),
  });
  let suffix = 0;
  const plan = createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    selectedCaseIds: ["evaluation-case_migrations"],
    selectedVariantIds: ["evaluation-variant_first", "evaluation-variant_second"],
    createSuffix: () => `multi-${++suffix}`,
    runtimeTargets: {
      "evaluation-variant_first": {
        profileId: "profile_first",
        protocol: "openai-compatible-chat-completions",
        endpoint: "https://first.example.test/v1",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      "evaluation-variant_second": {
        profileId: "profile_second",
        protocol: "openai-compatible-chat-completions",
        endpoint: secondRequirement.endpoint,
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
    },
  });
  const prepared: string[] = [];
  const started: string[] = [];
  const models: string[] = [];
  const transport: ProviderTurnTransport = {
    async discoverModels() { return { models: [] }; },
    async executeTurn({ execution }) {
      started.push(execution.runId);
      models.push(execution.input.target.model);
      return {
        status: 200,
        headers: new Headers(),
        events: (async function* () {
          yield { type: "text_delta" as const, text: "migration" };
          yield { type: "completed" as const, finishReason: { normalized: "stop" as const } };
        })(),
      };
    },
  };
  await new SequentialExperimentController({
    plan,
    transport,
    async prepareCredential(target) {
      prepared.push(`${target.profileId} ${target.endpoint}`);
      return { kind: "none" };
    },
  }).run();

  assert.deepEqual(prepared, [
    "profile_first https://first.example.test/v1",
    "profile_second https://second.example.test/v1",
  ]);
  assert.deepEqual(started, plan.cells.map(({ runId }) => runId));
  assert.deepEqual(models, ["first-model", "second-model"]);
});

test("an unservable configuration refuses the whole batch before credentials, persistence, or traffic", async () => {
  const source = planFixture(1);
  const plan = structuredClone(source);
  plan.suite.variants[0]!.responseMode = "streaming";
  plan.suite.variants[0]!.target.capabilities.streaming = false;
  let credentialCalls = 0;
  let saved = false;
  let providerCalls = 0;
  await assert.rejects(() => new SequentialExperimentController({
    plan,
    transport: {
      async discoverModels() { return { models: [] }; },
      async executeTurn() { providerCalls += 1; throw new Error("should not run"); },
    },
    async prepareCredential() { credentialCalls += 1; return { kind: "none" }; },
    async savePlan() { saved = true; },
  }).run(), /does not support streaming/);
  assert.equal(credentialCalls, 0);
  assert.equal(saved, false);
  assert.equal(providerCalls, 0);
});
