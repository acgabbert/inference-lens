import assert from "node:assert/strict";
import test from "node:test";

import {
  finishedBatchToast,
  runsIndicator,
} from "../app/run/batch-completion.ts";
import type { FinishedEvaluation } from "../app/run/batch-completion.ts";
import { createEvaluationExperimentPlan } from "../packages/core/src/evaluation-execution.ts";
import { materializeExperimentCellInput } from "../packages/core/src/experiment.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectFile,
} from "../packages/core/src/project.ts";
import { RunCoordinator } from "../packages/core/src/run-kernel/coordinator.ts";
import type { ResolvedRunInput } from "../packages/core/src/run-kernel/types.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

/** One case, one repetition, passing when the answer mentions a migration. */
function planFixture() {
  let project = createProjectFile({
    name: "Batch completion",
    idSuffix: "batch-completion",
    createdAt: "2026-10-08T12:00:00.000Z",
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
    createdAt: "2026-10-08T12:00:01.000Z",
  });
  const revisionId = project.defaults.conversationRevisionId;
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: revisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });
  project = parseProjectFile({
    ...project,
    evaluationSuites: [{
      id: "evaluation-suite_topics",
      name: "Topics",
      input: { kind: "conversation-revision", conversationRevisionId: revisionId },
      execution: {
        target: { ...project.defaults.target },
        responseMode: "buffered",
        options: {},
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
      cases: [{
        id: "evaluation-case_migrations",
        name: "Migrations",
        values: { "evaluation-input_topic": "database migrations" },
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
    createdAt: "2026-10-08T12:10:00.000Z",
    createSuffix: () => `fixture-${++suffix}`,
    runtimeTarget: {
      profileId: "profile_confirmed",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://confirmed.example.test/v1",
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
  });
}

function completed(input: ResolvedRunInput, text: string) {
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

function finishedEvaluation(answer: string): FinishedEvaluation {
  const plan = planFixture();
  const cell = plan.cells[0]!;
  const state = completed(materializeExperimentCellInput(plan, cell.cellId), answer);
  return {
    plan,
    result: {
      schemaVersion: 5,
      experimentId: plan.experimentId,
      status: "completed",
      endedAt: "2026-10-08T12:11:00.000Z",
      cells: [{ cellId: cell.cellId, runId: cell.runId, status: "completed" }],
    },
    states: new Map([[state.runId, state]]),
  };
}

const UNREAD = "finished, not yet viewed";

test("a running batch outranks an unread one", () => {
  assert.deepEqual(
    runsIndicator({ running: true, unread: true, evaluation: finishedEvaluation("migration") }),
    { tone: "running", label: "running" },
  );
});

test("nothing unread and nothing running leaves no indicator", () => {
  assert.equal(runsIndicator({ running: false, unread: false }), undefined);
});

test("an unread repeated experiment stays neutral", () => {
  assert.deepEqual(runsIndicator({ running: false, unread: true }), { tone: "neutral", label: UNREAD });
});

test("an unread evaluation is coloured by its pass rate", () => {
  assert.deepEqual(
    runsIndicator({ running: false, unread: true, evaluation: finishedEvaluation("A migration.") }),
    { tone: "passed", label: "finished, 1/1 case passed, not yet viewed" },
  );
  assert.deepEqual(
    runsIndicator({ running: false, unread: true, evaluation: finishedEvaluation("Nothing relevant.") }),
    { tone: "failed", label: "finished, 0/1 case passed, not yet viewed" },
  );
});

test("an interrupted or underivable evaluation does not borrow a verdict", () => {
  const evaluation = finishedEvaluation("A migration.");
  assert.deepEqual(
    runsIndicator({ running: false, unread: true, evaluation: { ...evaluation, error: "Stopped" } }),
    { tone: "neutral", label: UNREAD },
  );
  assert.deepEqual(
    runsIndicator({
      running: false,
      unread: true,
      evaluation: { ...evaluation, plan: { ...evaluation.plan, cells: undefined } } as never,
    }),
    { tone: "neutral", label: UNREAD },
  );
});

const viewResults = { label: "View results", onSelect() {} };

test("a repeated experiment's toast counts its repetitions", () => {
  assert.deepEqual(
    finishedBatchToast({ kind: "repeated", experimentId: "experiment_a", repetitions: 3 }, undefined, viewResults),
    {
      key: "batch-finished:experiment_a",
      title: "Repeated experiment finished",
      detail: "3 repetitions completed.",
      action: viewResults,
      durableHome: "the Runs mode indicator, until the results are opened",
    },
  );
  assert.equal(
    finishedBatchToast({ kind: "repeated", experimentId: "experiment_a", repetitions: 1 }, undefined, viewResults).detail,
    "1 repetition completed.",
  );
});

test("an evaluation's toast summarizes each variant when it is still the open execution", () => {
  const evaluation = finishedEvaluation("A migration.");
  const toast = finishedBatchToast(
    { kind: "evaluation", experimentId: evaluation.plan.experimentId },
    evaluation,
    viewResults,
  );
  assert.deepEqual(toast, {
    key: `batch-finished:${evaluation.plan.experimentId}`,
    title: "Evaluation finished",
    detail: "Default: 1/1 case passed.",
    action: viewResults,
    durableHome: "the Runs mode indicator, which also carries the pass rate",
  });
});

test("an evaluation's toast falls back when its execution is gone or unreadable", () => {
  const evaluation = finishedEvaluation("A migration.");
  const fallback = "Every selected case has a verdict.";
  assert.equal(
    finishedBatchToast({ kind: "evaluation", experimentId: "experiment_other" }, evaluation, viewResults).detail,
    fallback,
  );
  assert.equal(
    finishedBatchToast({ kind: "evaluation", experimentId: "experiment_other" }, undefined, viewResults).detail,
    fallback,
  );
  assert.equal(
    finishedBatchToast(
      { kind: "evaluation", experimentId: evaluation.plan.experimentId },
      { ...evaluation, plan: { ...evaluation.plan, cells: undefined } } as never,
      viewResults,
    ).detail,
    fallback,
  );
});
