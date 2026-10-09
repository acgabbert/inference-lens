import assert from "node:assert/strict";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

async function fixture() {
  const [projectCore, executionCore, experimentCore, kernel, types, component, reactServer, reactModule] = await Promise.all([
    ssrLoadModule("/packages/core/src/project.ts"),
    ssrLoadModule("/packages/core/src/evaluation-execution.ts"),
    ssrLoadModule("/packages/core/src/experiment.ts"),
    ssrLoadModule("/packages/core/src/run-kernel/index.ts"),
    ssrLoadModule("/packages/core/src/types.ts"),
    ssrLoadModule("/app/evaluations/evaluation-results-workspace.client.tsx"),
    import("react-dom/server"),
    import("react"),
  ]);
  let project = projectCore.createProjectFile({
    name: "Evaluation results", idSuffix: "evaluation-results", createdAt: "2026-08-01T12:00:00.000Z",
    request: { provider: "openai-compatible", endpoint: "https://provider.example.test/v1", model: "authored-model", messages: [{ role: "system", content: "System" }] },
  });
  project = projectCore.createPromptTemplate(project, {
    name: "Question", messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "question", revisionIdSuffix: "question-1", createdAt: "2026-08-01T12:00:01.000Z",
  });
  project = projectCore.insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question", itemIndex: 1, idSuffix: "question-use", outputMessageIdSuffixes: ["question-output"],
  });
  project = projectCore.parseProjectFile({ ...project, evaluationSuites: [{
    id: "evaluation-suite_topics", name: "Topic quality",
    input: { kind: "conversation-revision", conversationRevisionId: project.defaults.conversationRevisionId },
    execution: { target: { ...project.defaults.target, model: "fixture-model" }, responseMode: "buffered", options: {}, repetitions: 2, toolIds: [] },
    variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
    inputBindings: [{ id: "evaluation-input_topic", name: "Topic", target: { kind: "template-variable", templateUseId: "template-use_question-use", variableName: "topic" } }],
    cases: [{ id: "evaluation-case_migrations", name: "Migrations", values: { "evaluation-input_topic": "database migrations" }, checks: [{ checkId: "check_mentions-rollback", kind: "contains", value: "rollback", label: "Mentions rollback" }] }],
  }] });
  let suffix = 0;
  const plan = executionCore.createEvaluationExperimentPlan({
    project, suiteId: "evaluation-suite_topics",
    selectedCaseIds: ["evaluation-case_migrations"], createdAt: "2026-08-01T12:10:00.000Z", createSuffix: () => `render-${++suffix}`,
    runtimeTarget: { profileId: "profile_fixture", protocol: "openai-compatible-chat-completions", endpoint: "https://provider.example.test/v1", capabilities: types.OPENAI_COMPATIBLE_CAPABILITIES },
  });
  return { plan, experimentCore, kernel, ...component, ...reactServer, ...reactModule };
}

function completedState(fx, cell, text, usage) {
  const input = fx.experimentCore.materializeExperimentCellInput(fx.plan, cell.cellId);
  const coordinator = new fx.kernel.RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({ type: "text_delta", text, source: { exchangeId: execution.exchangeId } });
  if (usage) coordinator.accept({ type: "usage", usage, source: { exchangeId: execution.exchangeId } });
  coordinator.accept({ type: "completed", finishReason: { normalized: "stop" }, source: { exchangeId: execution.exchangeId } });
  coordinator.finishTurnStream();
  return coordinator.state;
}

function runningState(fx, cell) {
  const coordinator = new fx.kernel.RunCoordinator(fx.experimentCore.materializeExperimentCellInput(fx.plan, cell.cellId));
  coordinator.start();
  return coordinator.state;
}

test("renders live evaluation progress with the active case and repetition", async () => {
  const fx = await fixture();
  const html = fx.renderToStaticMarkup(fx.createElement(fx.EvaluationResultsWorkspace, {
    execution: { plan: fx.plan, storage: "unsaved", workspace: null, states: new Map(), live: { startedAtMs: Date.now(), requested: 2, finished: 0, runningOrdinals: [1], pausedConnections: [] }, traces: new Map(), traceFileNames: new Map(), unreadableTraces: new Map(), selectedRunId: null },
    onStop() {}, onOpenTrace() {},
  }));
  assert.match(html, /0 of 2 finished · Migrations, Default, repetition 1/);
  assert.match(html, /Evaluation progress/);
  assert.match(html, /Pending while this run is active/);
  assert.match(html, /Pending until this run starts/);
  assert.match(html, /run-history-status running">In progress/);
  assert.match(html, /run-history-status queued">queued/);
  assert.doesNotMatch(html, /Open when finished|Did not pass/);
  assert.match(html, /not saved and will be lost/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
});

test("renders strict as-run case, repetition, check, usage, and evidence results", async () => {
  const fx = await fixture();
  const first = completedState(fx, fx.plan.cells[0], "Include a rollback plan.", { inputTokens: 4, outputTokens: 5, totalTokens: 9 });
  const second = completedState(fx, fx.plan.cells[1], "Use backups.");
  const states = new Map([[first.runId, first], [second.runId, second]]);
  const result = { schemaVersion: 4, experimentId: fx.plan.experimentId, status: "completed", endedAt: "2026-08-01T12:11:00.000Z", cells: fx.plan.cells.map((cell) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed" })) };
  const html = fx.renderToStaticMarkup(fx.createElement(fx.EvaluationResultsWorkspace, {
    execution: { plan: fx.plan, result, storage: "durable", workspace: null, states, traces: new Map([[first.runId, {}], [second.runId, {}]]), traceFileNames: new Map(), unreadableTraces: new Map(), selectedRunId: null },
    onStop() {}, onOpenTrace() {},
  }));
  assert.match(html, /As run · 1 cases · 2 repetitions/);
  assert.match(html, /did not pass/);
  assert.match(html, /<strong>0 \/ 1 passed<\/strong><small>0%/);
  assert.match(html, /Mentions rollback/);
  assert.match(html, /check failed/);
  assert.match(html, /<strong>9 tokens · 1\/2 runs reported<\/strong>/);
  assert.equal((html.match(/Response and trace available/g) ?? []).length, 2);
  assert.equal((html.match(/Open Response &amp; Inspect/g) ?? []).length, 2);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
});

test("a rate-limited repetition reads as rate limited and leaves its case incomplete, not failed", async () => {
  const fx = await fixture();
  const first = completedState(fx, fx.plan.cells[0], "Include a rollback plan.");
  const coordinator = new fx.kernel.RunCoordinator(fx.experimentCore.materializeExperimentCellInput(fx.plan, fx.plan.cells[1].cellId));
  coordinator.start();
  const error = { code: "provider_error", message: "Too many requests", retryable: true, providerStatus: 429 };
  coordinator.accept({ type: "failed", error });
  coordinator.finishTurnStream();
  coordinator.fail(error);
  const second = coordinator.state;
  const states = new Map([[first.runId, first], [second.runId, second]]);
  const result = { schemaVersion: 4, experimentId: fx.plan.experimentId, status: "completed", endedAt: "2026-08-01T12:11:00.000Z", cells: fx.plan.cells.map((cell) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed" })) };
  const html = fx.renderToStaticMarkup(fx.createElement(fx.EvaluationResultsWorkspace, {
    execution: { plan: fx.plan, result, storage: "durable", workspace: null, states, traces: new Map([[first.runId, {}], [second.runId, {}]]), traceFileNames: new Map(), unreadableTraces: new Map(), selectedRunId: null },
    onStop() {}, onOpenTrace() {},
  }));
  assert.match(html, /<span class="run-history-status rate-limited">rate limited<\/span>/);
  assert.doesNotMatch(html, /run failed/);
  assert.match(html, /0 failed · 1 incomplete/);
});

test("projects readable, unreadable, absent, and not-created evidence independently", async () => {
  const fx = await fixture();
  const cell = fx.plan.cells[0];
  const state = completedState(fx, cell, "Include a rollback plan.");
  const base = { runId: cell.runId, classification: "passed" };

  assert.equal(fx.evaluationEvidenceReachability(base, {
    states: new Map([[cell.runId, state]]),
    traces: new Map([[cell.runId, {}]]),
    unreadableTraces: new Map(),
  }).kind, "readable");
  assert.deepEqual(fx.evaluationEvidenceReachability(base, {
    states: new Map(), traces: new Map(), unreadableTraces: new Map([[cell.runId, "invalid JSON"]]),
  }), { kind: "unreadable", reason: "invalid JSON" });
  assert.deepEqual(fx.evaluationEvidenceReachability(base, {
    states: new Map(), traces: new Map(), unreadableTraces: new Map(),
  }), { kind: "absent" });
  assert.deepEqual(fx.evaluationEvidenceReachability({ ...base, classification: "not-run" }, {
    states: new Map(), traces: new Map(), unreadableTraces: new Map(),
  }), { kind: "not-created" });
});

test("live evaluation progress marks every running repetition and counts them", async () => {
  const fx = await fixture();
  const [first, second] = fx.plan.cells;
  const html = fx.renderToStaticMarkup(fx.createElement(fx.EvaluationResultsWorkspace, {
    execution: {
      plan: fx.plan, storage: "unsaved", workspace: null,
      states: new Map([first, second].map((cell) => [cell.runId, runningState(fx, cell)])),
      live: { startedAtMs: Date.now(), requested: 2, finished: 0, runningOrdinals: [1, 2], pausedConnections: [] },
      traces: new Map(), traceFileNames: new Map(), unreadableTraces: new Map(), selectedRunId: null,
    },
    onStop() {}, onOpenTrace() {},
  }));
  assert.match(html, /0 of 2 finished · 2 running/);
  assert.equal((html.match(/Pending while this run is active/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Pending until this run starts/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
});

test("live evaluation progress names the configurations a rate-limit pause holds back", async () => {
  const fx = await fixture();
  const [first] = fx.plan.cells;
  const variant = fx.plan.suite.variants[0];
  const html = fx.renderToStaticMarkup(fx.createElement(fx.EvaluationResultsWorkspace, {
    execution: {
      plan: fx.plan, storage: "unsaved", workspace: null,
      states: new Map([[first.runId, completedState(fx, first, "Answer")]]),
      live: {
        startedAtMs: Date.now(), requested: 2, finished: 1, runningOrdinals: [],
        pausedConnections: [{ profileId: variant.target.profileId, endpoint: variant.target.endpoint, until: Date.now() + 5_000 }],
      },
      traces: new Map(), traceFileNames: new Map(), unreadableTraces: new Map(), selectedRunId: null,
    },
    onStop() {}, onOpenTrace() {},
  }));
  assert.match(html, /1 of 2 finished · Paused after a rate limit/);
  assert.match(html, /role="status"><strong[^>]*>Rate limited</);
  assert.match(html, /New repetitions for Default resume in [45] s/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
});

test("a result that ran cells at once says so beside its latency", async () => {
  const fx = await fixture();
  const states = new Map(fx.plan.cells.map((cell) => {
    const state = completedState(fx, cell, "Include a rollback plan.");
    return [state.runId, state];
  }));
  const variant = fx.plan.suite.variants[0];
  const result = (maxInFlight) => ({
    schemaVersion: 6, experimentId: fx.plan.experimentId, status: "completed", endedAt: "2026-08-01T12:11:00.000Z",
    concurrency: { maxInFlight, connections: [{ profileId: variant.target.profileId, endpoint: variant.target.endpoint, limit: maxInFlight }] },
    retryPolicy: { rateLimited: { maxRetries: 0 } },
    cells: fx.plan.cells.map((cell, index) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed", startOrder: index + 1 })),
  });
  const render = (maxInFlight) => fx.renderToStaticMarkup(fx.createElement(fx.EvaluationResultsWorkspace, {
    execution: { plan: fx.plan, result: result(maxInFlight), storage: "durable", workspace: null, states, traces: new Map(), traceFileNames: new Map(), unreadableTraces: new Map(), selectedRunId: null },
    onStop() {}, onOpenTrace() {},
  }));
  assert.match(render(4), /As run · 1 cases · 2 repetitions · up to 4 at once/);
  assert.doesNotMatch(render(1), /at once/);
});

test("a result that allowed retries says so, and counts the repetitions that needed them", async () => {
  const fx = await fixture();
  const [first, second] = fx.plan.cells;
  const retried = (() => {
    const coordinator = new fx.kernel.RunCoordinator(fx.experimentCore.materializeExperimentCellInput(fx.plan, first.cellId));
    coordinator.start();
    coordinator.accept({ type: "failed", error: { code: "provider_error", message: "Too many requests", retryable: true, providerStatus: 429 } });
    coordinator.finishTurnStream();
    const { execution } = coordinator.retry();
    coordinator.accept({ type: "text_delta", text: "Include a rollback plan.", source: { exchangeId: execution.exchangeId } });
    coordinator.accept({ type: "completed", finishReason: { normalized: "stop" }, source: { exchangeId: execution.exchangeId } });
    coordinator.finishTurnStream();
    return coordinator.state;
  })();
  const states = new Map([[retried.runId, retried], [second.runId, completedState(fx, second, "Include a rollback plan.")]]);
  const variant = fx.plan.suite.variants[0];
  const html = fx.renderToStaticMarkup(fx.createElement(fx.EvaluationResultsWorkspace, {
    execution: {
      plan: fx.plan, storage: "durable", workspace: null, states, traces: new Map(), traceFileNames: new Map(), unreadableTraces: new Map(), selectedRunId: null,
      result: {
        schemaVersion: 6, experimentId: fx.plan.experimentId, status: "completed", endedAt: "2026-08-01T12:11:00.000Z",
        concurrency: { maxInFlight: 1, connections: [{ profileId: variant.target.profileId, endpoint: variant.target.endpoint, limit: 1 }] },
        retryPolicy: { rateLimited: { maxRetries: 2 } },
        cells: fx.plan.cells.map((cell, index) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed", startOrder: index + 1 })),
      },
    },
    onStop() {}, onOpenTrace() {},
  }));

  assert.match(html, /As run · 1 cases · 2 repetitions · rate-limited requests retried up to 2 times/);
  assert.match(html, /0 incomplete · 1 retried after rate limiting/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
});
