import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

async function render(modulePath, component, props) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    logLevel: "warn",
  });
  try {
    const [module, { renderToStaticMarkup }, { createElement }] = await Promise.all([
      server.ssrLoadModule(modulePath),
      import("react-dom/server"),
      import("react"),
    ]);
    return renderToStaticMarkup(createElement(module[component], props));
  } finally {
    await server.close();
  }
}

function plan() {
  return {
    schemaVersion: 1,
    experimentId: "experiment_render",
    kind: "repeated-request",
    createdAt: "2026-07-30T12:00:00.000Z",
    commonInput: {
      conversationId: "conversation_render",
      conversationRevisionId: "revision_render",
      target: {
        profileId: "profile_render",
        protocol: "openai-compatible-chat-completions",
        endpoint: "https://provider.example.test/v1",
        model: "render-model",
        capabilities: {
          chatCompletions: true, responsesApi: false, streaming: true,
          modelDiscovery: true, tools: true, parallelToolCalls: false,
          structuredOutput: false, vision: false, embeddings: false,
        },
      },
      messages: [{ id: "message_render", role: "user", content: [{ type: "text", text: "Render this" }] }],
      templateResolutions: [],
      responseMode: "streaming",
      options: {},
      tools: [],
      resolvedAt: "2026-07-30T12:00:00.000Z",
    },
    cells: [
      { cellId: "experiment-cell_render-1", ordinal: 1, runId: "run_render-1" },
      { cellId: "experiment-cell_render-2", ordinal: 2, runId: "run_render-2" },
    ],
  };
}

function assertNoBrokenValues(html) {
  for (const marker of ["NaN", "Infinity", "undefined", "[object Object]"]) {
    assert.doesNotMatch(html, new RegExp(marker.replace(/[[\]]/g, "\\$&")));
  }
}

function completedState(runId, text) {
  return {
    runId,
    status: { kind: "completed", completedAt: "2026-07-30T12:00:10.000Z" },
    events: [],
    turns: [{
      turnId: "turn_render",
      attempts: [{
        attempt: 1,
        exchangeId: "exchange_render",
        status: "completed",
        text,
        reasoning: "",
        toolCalls: [],
      }],
    }],
    exchanges: {},
    toolResults: [],
    lastSequence: 0,
  };
}

test("repeat confirmation exposes the frozen request, exact count, and sequential cost", async () => {
  const frozenPlan = plan();
  const html = await render(
    "/app/run/repeated-experiment-dialog.client.tsx",
    "RepeatedExperimentDialog",
    {
      draft: {
        plan: frozenPlan,
        targetName: "Fixture connection",
        requestSummary: "1 message · streaming response",
        repetitionCount: 5,
        commitPreparation() {},
      },
      onCountChange() {},
      onCancel() {},
      onConfirm() {},
    },
  );

  assert.match(html, /Frozen request/);
  assert.match(html, /Fixture connection · render-model/);
  assert.match(html, /Runs sequentially/);
  assert.match(html, /Minimum provider calls: 5/);
  assert.match(html, /Start 5 repetitions/);
  assertNoBrokenValues(html);
});

test("repeated workspace renders unsaved state, exact aggregate text, and ordinary trace rows", async () => {
  const frozenPlan = plan();
  const html = await render(
    "/app/run/repeated-experiment-workspace.client.tsx",
    "RepeatedExperimentWorkspace",
    {
      execution: {
        plan: frozenPlan,
        storage: "unsaved",
        startedAtMs: Date.now(),
        workspace: null,
        progress: { status: "completed", requested: 2, finished: 2, states: new Map() },
        result: {
          schemaVersion: 1,
          experimentId: frozenPlan.experimentId,
          status: "completed",
          endedAt: "2026-07-30T12:01:00.000Z",
          cells: [
            { cellId: "experiment-cell_render-1", runId: "run_render-1", status: "completed" },
            { cellId: "experiment-cell_render-2", runId: "run_render-2", status: "failed" },
          ],
        },
        traces: new Map([["run_render-1", { runId: "run_render-1" }]]),
        selectedRunId: "run_render-1",
      },
      placement: "request",
      onStop() {},
      onOpenTrace() {},
      onReturnToRequest() {},
    },
  );

  assert.match(html, /Unsaved session experiment/);
  assert.match(html, /lost when this session closes/);
  assert.match(html, /0 completed · 0 failed · 0 cancelled/);
  assert.match(html, /0 not run · 2 missing trace/);
  assert.match(html, /Repetition 1/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /Open Response &amp; Inspect/);
  assert.match(html, /Repetition 2/);
  assert.match(html, /Back to request/);
  assert.match(html, /experiment-context-pane/);
  assertNoBrokenValues(html);
});

test("running workspace exposes determinate activity, the active repetition, and elapsed time", async () => {
  const frozenPlan = plan();
  const html = await render(
    "/app/run/repeated-experiment-workspace.client.tsx",
    "RepeatedExperimentWorkspace",
    {
      execution: {
        plan: frozenPlan,
        storage: "durable",
        startedAtMs: Date.now(),
        workspace: {},
        progress: {
          status: "running",
          requested: 2,
          finished: 1,
          currentOrdinal: 2,
          states: new Map(),
        },
        traces: new Map(),
        selectedRunId: null,
      },
      onStop() {},
      onOpenTrace() {},
    },
  );

  assert.match(html, /aria-busy="true"/);
  assert.match(html, /1 of 2 finished/);
  assert.match(html, /Running repetition 2/);
  assert.match(html, /\d+:\d{2} elapsed/);
  assert.match(html, /experiment-elapsed/);
  assert.match(html, /<progress[^>]+max="2"[^>]+value="1"/);
  assert.match(html, /repeated-experiment-row active/);
  assert.match(html, /experiment-row-activity-dot/);
  assert.doesNotMatch(html, /experiment-activity-dot/);
  assert.match(html, /Stop remaining/);
  assertNoBrokenValues(html);
});

test("completed experiment rows show a brief normalized output preview", async () => {
  const frozenPlan = plan();
  const longOutput = `A finished answer.\n\n${"More detail. ".repeat(30)}`;
  const html = await render(
    "/app/run/repeated-experiment-workspace.client.tsx",
    "RepeatedExperimentWorkspace",
    {
      execution: {
        plan: frozenPlan,
        storage: "durable",
        startedAtMs: Date.now(),
        workspace: {},
        progress: {
          status: "completed",
          requested: 2,
          finished: 2,
          states: new Map([
            ["run_render-1", completedState("run_render-1", longOutput)],
            ["run_render-2", completedState("run_render-2", "   ")],
          ]),
        },
        result: {
          schemaVersion: 1,
          experimentId: frozenPlan.experimentId,
          status: "completed",
          endedAt: "2026-07-30T12:01:00.000Z",
          cells: frozenPlan.cells.map(({ cellId, runId }) => ({ cellId, runId, status: "completed" })),
        },
        traces: new Map(),
        selectedRunId: null,
      },
      onStop() {},
      onOpenTrace() {},
    },
  );

  assert.equal((html.match(/Output ready/g) ?? []).length, 2);
  assert.match(html, /A finished answer\. More detail\./);
  assert.match(html, /More detail\. …/);
  assert.match(html, /No text output/);
  assert.doesNotMatch(html, /A finished answer\.\n/);
  assertNoBrokenValues(html);
});

test("workbench shell can expose Experiment as the contextual mobile pane", async () => {
  const html = await render(
    "/app/workbench-shell.client.tsx",
    "WorkbenchShell",
    {
      request: "Experiment summary",
      response: "Selected response",
      inspect: "Selected inspection",
      view: "request",
      onViewChange() {},
      requestLabel: "Experiment",
    },
  );

  assert.match(html, /<button[^>]+class="active"[^>]*>Experiment<\/button>/);
  assert.match(html, /Experiment summary/);
  assertNoBrokenValues(html);
});
