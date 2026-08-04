import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { uniqueViteCacheDir } from "./support/vite-cache-dir.mjs";

async function fixture() {
  const server = await createServer({ configFile: false, cacheDir: uniqueViteCacheDir(), root: process.cwd(), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "warn" });
  const [projectCore, executionCore, experimentCore, kernel, types, component, reactServer, reactModule] = await Promise.all([
    server.ssrLoadModule("/packages/core/src/project.ts"),
    server.ssrLoadModule("/packages/core/src/evaluation-execution.ts"),
    server.ssrLoadModule("/packages/core/src/experiment.ts"),
    server.ssrLoadModule("/packages/core/src/run-kernel/index.ts"),
    server.ssrLoadModule("/packages/core/src/types.ts"),
    server.ssrLoadModule("/app/evaluations/evaluation-results-workspace.client.tsx"),
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
    inputBindings: [{ id: "evaluation-input_topic", name: "Topic", target: { kind: "template-variable", templateUseId: "template-use_question-use", variableName: "topic" } }],
    cases: [{ id: "evaluation-case_migrations", name: "Migrations", values: { "evaluation-input_topic": "database migrations" }, checks: [{ checkId: "check_mentions-rollback", kind: "contains", value: "rollback", label: "Mentions rollback" }] }],
  }] });
  let suffix = 0;
  const plan = executionCore.createEvaluationExperimentPlan({
    project, suiteId: "evaluation-suite_topics",
    selectedCaseIds: ["evaluation-case_migrations"], createdAt: "2026-08-01T12:10:00.000Z", createSuffix: () => `render-${++suffix}`,
    runtimeTarget: { profileId: "profile_fixture", protocol: "openai-compatible-chat-completions", endpoint: "https://provider.example.test/v1", capabilities: types.OPENAI_COMPATIBLE_CAPABILITIES },
  });
  return { server, plan, experimentCore, kernel, ...component, ...reactServer, ...reactModule };
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

test("renders live evaluation progress with the active case and repetition", async () => {
  const fx = await fixture();
  try {
    const html = fx.renderToStaticMarkup(fx.createElement(fx.EvaluationResultsWorkspace, {
      execution: { plan: fx.plan, storage: "unsaved", workspace: null, states: new Map(), live: { startedAtMs: Date.now(), requested: 2, finished: 0, currentOrdinal: 1 }, traces: new Map(), traceFileNames: new Map(), unreadableTraces: new Map(), selectedRunId: null },
      onStop() {}, onOpenTrace() {},
    }));
    assert.match(html, /0 of 2 finished · Migrations, repetition 1/);
    assert.match(html, /Evaluation progress/);
    assert.match(html, /Running…/);
    assert.match(html, /In progress/);
    assert.doesNotMatch(html, /Open when finished|Did not pass/);
    assert.match(html, /not saved and will be lost/);
    assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
  } finally { await fx.server.close(); }
});

test("renders strict as-run case, repetition, check, usage, and evidence results", async () => {
  const fx = await fixture();
  try {
    const first = completedState(fx, fx.plan.cells[0], "Include a rollback plan.", { inputTokens: 4, outputTokens: 5, totalTokens: 9 });
    const second = completedState(fx, fx.plan.cells[1], "Use backups.");
    const states = new Map([[first.runId, first], [second.runId, second]]);
    const result = { schemaVersion: 3, experimentId: fx.plan.experimentId, status: "completed", endedAt: "2026-08-01T12:11:00.000Z", cells: fx.plan.cells.map((cell) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed" })) };
    const html = fx.renderToStaticMarkup(fx.createElement(fx.EvaluationResultsWorkspace, {
      execution: { plan: fx.plan, result, storage: "durable", workspace: null, states, traces: new Map([[first.runId, {}], [second.runId, {}]]), traceFileNames: new Map(), unreadableTraces: new Map(), selectedRunId: null },
      onStop() {}, onOpenTrace() {},
    }));
    assert.match(html, /As run · 1 cases · 2 repetitions/);
    assert.match(html, /Did not pass/);
    assert.match(html, /1 \/ 1 passed|0 \/ 1 passed/);
    assert.match(html, /Mentions rollback/);
    assert.match(html, /check failed/);
    assert.match(html, /9 tokens · 1\/2 runs reported/);
    assert.equal((html.match(/Open Response &amp; Inspect/g) ?? []).length, 2);
    assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
  } finally { await fx.server.close(); }
});
