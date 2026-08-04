import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { uniqueViteCacheDir } from "./support/vite-cache-dir.mjs";

async function render(modulePath, component, props) {
  const server = await createServer({
    configFile: false, cacheDir: uniqueViteCacheDir(),
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
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
    schemaVersion: 3,
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

function completedMetricState(runId, text, {
  totalDurationMs,
  ttfoMs,
  outputSpanMs,
  outputTokens,
  totalTokens,
}) {
  const state = completedState(runId, text);
  const turnId = `turn_${runId}`;
  const exchangeId = `exchange_${runId}`;
  const requestedAtMs = 100;
  const firstOutputAtMs = requestedAtMs + ttfoMs;
  const completedAtMs = firstOutputAtMs + outputSpanMs;
  state.turns[0].turnId = turnId;
  state.turns[0].attempts[0].exchangeId = exchangeId;
  state.turns[0].attempts[0].usage = { outputTokens, totalTokens };
  state.events = [
    { type: "exchange.requested", turnId, attempt: 1, exchangeId, elapsedMs: requestedAtMs },
    { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, elapsedMs: firstOutputAtMs },
    { type: "assistant.completed", turnId, attempt: 1, exchangeId, elapsedMs: completedAtMs },
    { type: "run.completed", elapsedMs: totalDurationMs },
  ];
  return state;
}

function streamingState(runId) {
  return {
    runId,
    status: { kind: "streaming", startedAt: "2026-07-30T12:00:01.000Z" },
    events: [],
    turns: [{
      turnId: "turn_render",
      attempts: [{
        attempt: 1,
        exchangeId: "exchange_render",
        status: "streaming",
        text: "partial",
        reasoning: "",
        toolCalls: [],
      }],
    }],
    exchanges: {},
    toolResults: [],
    lastSequence: 0,
  };
}

/** Reads the reason each traceless repetition gives for not being openable. */
function pendingLabels(html) {
  return [...html.matchAll(/repeated-experiment-row-pending"[^>]*>([^<]*)</g)]
    .map((match) => match[1]);
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
        requestSummary: "1 message",
        repetitionCount: 5,
        toolBindings: [],
        commitPreparation() {},
      },
      settings: {
        streamingAvailable: true,
        modelDiscovery: null,
        favoriteModels: [],
        onLoadModels() {},
        onToggleFavoriteModel() {},
      },
      onCountChange() {},
      onTurnCeilingChange() {},
      onSettingsChange() {},
      onCancel() {},
      onConfirm() {},
    },
  );

  assert.match(html, /Frozen request/);
  assert.match(html, /Fixture connection/);
  assert.match(html, /Runs sequentially/);
  assert.match(html, /Minimum provider calls: 5/);
  assert.match(html, /Start 5 repetitions/);
  // The dialog is where the plan's options are still editable, so its panel
  // starts expanded with the real controls rather than only their summary.
  assert.match(html, /aria-label="Repeated experiment settings"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /class="model-combobox"/);
  // Readiness routing names exactly one model field, and it is the composer's.
  assert.doesNotMatch(html, /data-readiness-control="model"/);
  assert.match(html, /Override temperature/);
  assert.match(html, /Stream response/);
  assert.match(html, /render-model/);
  assertNoBrokenValues(html);
});

test("a tool-exposing confirmation names what will run and quotes a range, not a floor", async () => {
  const frozenPlan = plan();
  const weather = {
    id: "tool_weather",
    name: "get_weather",
    description: "Looks up weather.",
    inputSchema: { type: "object", properties: {} },
  };
  const lookup = {
    id: "tool_lookup",
    name: "lookup_city",
    description: "Resolves a city.",
    inputSchema: { type: "object", properties: {} },
  };
  frozenPlan.commonInput.tools = [weather, lookup];
  frozenPlan.turnCeiling = 4;
  const html = await render(
    "/app/run/repeated-experiment-dialog.client.tsx",
    "RepeatedExperimentDialog",
    {
      draft: {
        plan: frozenPlan,
        targetName: "Fixture connection",
        requestSummary: "1 message",
        repetitionCount: 5,
        toolBindings: [
          {
            tool: weather,
            binding: {
              toolId: "tool_weather",
              kind: "command",
              executorId: "weather-script",
              label: "Local weather script",
              grantedAt: "2026-08-04T12:00:00.000Z",
            },
          },
          {
            tool: lookup,
            binding: {
              toolId: "tool_lookup",
              kind: "mock",
              executorId: "mock_city",
              label: "sunny default",
              result: { content: [{ type: "text", text: "Chicago" }] },
            },
          },
        ],
        commitPreparation() {},
      },
      settings: {
        streamingAvailable: true,
        modelDiscovery: null,
        favoriteModels: [],
        onLoadModels() {},
        onToggleFavoriteModel() {},
      },
      onCountChange() {},
      onTurnCeilingChange() {},
      onSettingsChange() {},
      onCancel() {},
      onConfirm() {},
    },
  );

  // The listing is the point: a grant survives a project re-import, and this is
  // the last moment before it executes without anyone being asked again.
  assert.match(html, /Tools served automatically/);
  assert.match(html, /get_weather/);
  assert.match(html, /command &quot;Local weather script&quot;/);
  assert.match(html, /lookup_city/);
  assert.match(html, /mock &quot;sunny default&quot;/);
  // The old copy claimed 5 calls was the exact minimum. With tools it is a
  // floor, and the ceiling is what bounds the other end.
  assert.match(html, /Provider calls: 5–20/);
  assert.doesNotMatch(html, /Minimum provider calls/);
  assert.match(html, /aria-label="Max turns per repetition"/);
  assertNoBrokenValues(html);
});

test("a started experiment reports its frozen settings as a record, not as controls", async () => {
  const html = await render(
    "/app/run/repeated-experiment-workspace.client.tsx",
    "RepeatedExperimentWorkspace",
    {
      execution: {
        plan: plan(),
        storage: "unsaved",
        workspace: null,
        states: new Map(),
        traces: new Map(),
        traceFileNames: new Map(),
        unreadableTraces: new Map(),
        selectedRunId: null,
      },
      onStop() {},
      onOpenTrace() {},
    },
  );

  // Collapsed, so the values reach the reader as the summary the panel shows
  // everywhere else — including the repetition count the plan allocated.
  assert.match(html, /Frozen by this plan/);
  assert.match(html, /render-model/);
  assert.match(html, /Provider default temp/);
  assert.match(html, /Streaming/);
  assert.match(html, /2 reps/);
  // Nothing here may invite an edit: these calls have already been planned.
  assert.doesNotMatch(html, /Override temperature|Stream response/);
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
        workspace: null,
        states: new Map(),
        unreadableTraces: new Map(),
        result: {
          schemaVersion: 3,
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
  assert.match(html, /2 missing trace/);
  assert.doesNotMatch(html, /0 not run/);
  assert.match(html, />Outcomes</);
  assert.match(html, />Consistency</);
  assert.doesNotMatch(html, />Latency</);
  assert.doesNotMatch(html, />Usage</);
  assert.doesNotMatch(html, /More metrics/);
  assert.doesNotMatch(html, /—/);
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
        workspace: {},
        states: new Map(),
        unreadableTraces: new Map(),
        live: { startedAtMs: Date.now(), requested: 2, finished: 1, currentOrdinal: 2 },
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

test("successful experiment consolidates primary evidence and collapses secondary metrics", async () => {
  const frozenPlan = plan();
  const states = new Map([
    ["run_render-1", completedMetricState("run_render-1", "Hello", {
      totalDurationMs: 1_650,
      ttfoMs: 500,
      outputSpanMs: 1_000,
      outputTokens: 20,
      totalTokens: 30,
    })],
    ["run_render-2", completedMetricState("run_render-2", "Longer", {
      totalDurationMs: 2_350,
      ttfoMs: 700,
      outputSpanMs: 1_000,
      outputTokens: 30,
      totalTokens: 50,
    })],
  ]);
  const html = await render(
    "/app/run/repeated-experiment-workspace.client.tsx",
    "RepeatedExperimentWorkspace",
    {
      execution: {
        plan: frozenPlan,
        storage: "durable",
        workspace: {},
        states,
        unreadableTraces: new Map(),
        result: {
          schemaVersion: 3,
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

  const primary = html.slice(
    html.indexOf('<div class="repeated-experiment-summary"'),
    html.indexOf('<details class="repeated-experiment-more-metrics">'),
  );
  assert.match(primary, />Outcomes</);
  assert.match(primary, /2 completed · 0 failed · 0 cancelled/);
  assert.doesNotMatch(primary, /Unstarted \/ missing/);
  assert.match(primary, />Consistency</);
  assert.match(primary, />Latency</);
  assert.match(primary, /Total duration/);
  assert.match(primary, /Time to first output/);
  assert.match(primary, />Usage</);
  assert.match(primary, /Per-run total tokens/);
  assert.match(primary, /Experiment total<\/dt><dd>80 across 2 runs/);
  assert.doesNotMatch(primary, /output tokens|Output throughput|Output characters/);

  assert.match(html, /<details class="repeated-experiment-more-metrics">/);
  assert.match(html, /Per-run output tokens/);
  assert.match(html, /Experiment output tokens<\/dt><dd>50 across 2 runs/);
  assert.match(html, /Output throughput/);
  assert.match(html, /Output characters/);
  assert.doesNotMatch(html, /—/);
  assertNoBrokenValues(html);
});

test("a live repetition is never described as having lost its trace", async () => {
  const frozenPlan = plan();
  // Repetition 1 is mid-stream and repetition 2 has not started. Neither has a
  // trace yet, and neither has lost one.
  const streaming = await render(
    "/app/run/repeated-experiment-workspace.client.tsx",
    "RepeatedExperimentWorkspace",
    {
      execution: {
        plan: frozenPlan,
        storage: "durable",
        workspace: {},
        states: new Map([["run_render-1", streamingState("run_render-1")]]),
        live: { startedAtMs: Date.now(), requested: 2, finished: 0, currentOrdinal: 1 },
        traces: new Map(),
        traceFileNames: new Map(),
        unreadableTraces: new Map(),
        selectedRunId: null,
      },
      onStop() {},
      onOpenTrace() {},
    },
  );

  // Both labels name a state. "Running…" is the same word the evaluation
  // results workspace uses for this state, into the same markup slot.
  assert.deepEqual(pendingLabels(streaming), ["Running…", "Waiting"]);
  assert.doesNotMatch(streaming, /Trace missing/);
  assertNoBrokenValues(streaming);

  // Repetition 1 has reached a terminal status, but the controller emits that
  // progress before awaiting the trace write, so `states` leads `traces` for as
  // long as persistence takes. That window is a save in flight, not data loss.
  const persisting = await render(
    "/app/run/repeated-experiment-workspace.client.tsx",
    "RepeatedExperimentWorkspace",
    {
      execution: {
        plan: frozenPlan,
        storage: "durable",
        workspace: {},
        states: new Map([["run_render-1", completedState("run_render-1", "Answer")]]),
        live: { startedAtMs: Date.now(), requested: 2, finished: 1, currentOrdinal: 1 },
        traces: new Map(),
        traceFileNames: new Map(),
        unreadableTraces: new Map(),
        selectedRunId: null,
      },
      onStop() {},
      onOpenTrace() {},
    },
  );

  assert.deepEqual(pendingLabels(persisting), ["Saving trace…", "Waiting"]);
  assert.doesNotMatch(persisting, /Trace missing/);
  assertNoBrokenValues(persisting);
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
        workspace: {},
        states: new Map([
          ["run_render-1", completedState("run_render-1", longOutput)],
          ["run_render-2", completedState("run_render-2", "   ")],
        ]),
        unreadableTraces: new Map(),
        result: {
          schemaVersion: 3,
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
  assert.match(html, /<details class="repeated-experiment-more-metrics">/);
  assert.match(html, /<summary>More metrics<\/summary>/);
  assert.match(html, /Output characters/);
  assert.doesNotMatch(html, /Per-run output tokens/);
  assert.doesNotMatch(html, /Output throughput/);
  assert.match(html, /A finished answer\. More detail\./);
  assert.match(html, /More detail\. …/);
  assert.match(html, /No text output/);
  assert.doesNotMatch(html, /A finished answer\.\n/);
  assertNoBrokenValues(html);
});

test("a saved interrupted experiment reads as interrupted and shows no live progress", async () => {
  const frozenPlan = plan();
  const html = await render(
    "/app/run/repeated-experiment-workspace.client.tsx",
    "RepeatedExperimentWorkspace",
    {
      execution: {
        plan: frozenPlan,
        storage: "durable",
        workspace: {},
        // No result artifact and no live progress: the session that produced
        // this experiment ended before it could finish.
        states: new Map([["run_render-1", completedState("run_render-1", "Only answer")]]),
        traces: new Map([["run_render-1", { runId: "run_render-1" }]]),
        traceFileNames: new Map([["run_render-1", "run_render-1.json"]]),
        unreadableTraces: new Map(),
        selectedRunId: null,
      },
      onStop() {},
      onOpenTrace() {},
    },
  );

  // The experiment-level badge, not a repetition's own status.
  const header = html.slice(0, html.indexOf("</header>"));
  assert.match(header, /run-history-status interrupted">interrupted</);
  assert.doesNotMatch(header, /completed|cancelled|running/);
  assert.match(html, /2 requested repetitions/);
  assert.doesNotMatch(html, /elapsed/);
  assert.doesNotMatch(html, /<progress/);
  assert.doesNotMatch(html, /Stop remaining/);
  assert.doesNotMatch(html, /aria-busy="true"/);
  // The cell that never started must not be described as a queued repetition.
  assert.match(html, /1 completed · 0 failed · 0 cancelled/);
  assert.match(html, /1 not run/);
  assert.doesNotMatch(html, /0 missing trace/);
  assert.doesNotMatch(html, /Waiting/);
  assert.match(html, /Not run/);
  assertNoBrokenValues(html);
});

test("a referenced trace that cannot be read is distinguished from one that never ran", async () => {
  const frozenPlan = plan();
  const html = await render(
    "/app/run/repeated-experiment-workspace.client.tsx",
    "RepeatedExperimentWorkspace",
    {
      execution: {
        plan: frozenPlan,
        storage: "durable",
        workspace: {},
        states: new Map(),
        result: {
          schemaVersion: 3,
          experimentId: frozenPlan.experimentId,
          status: "completed",
          endedAt: "2026-07-30T12:01:00.000Z",
          cells: frozenPlan.cells.map(({ cellId, runId }) => ({ cellId, runId, status: "completed" })),
        },
        traces: new Map(),
        traceFileNames: new Map(),
        unreadableTraces: new Map([["run_render-1", "run_render-1.json is not valid JSON."]]),
        selectedRunId: null,
      },
      onStop() {},
      onOpenTrace() {},
    },
  );

  assert.match(html, /Trace could not be read/);
  assert.match(html, /run_render-1\.json is not valid JSON\./);
  // The other cell completed and its trace is simply gone.
  assert.match(html, /Trace missing/);
  assertNoBrokenValues(html);
});

/**
 * The panes used to be renamed by whatever had claimed them — Experiment,
 * Evaluation, Preview. Results live in the Runs mode now, so each pane has one
 * occupant and one name, and the shell offers no way to say otherwise.
 */
test("the Compose shell names its panes the same regardless of what they hold", async () => {
  const html = await render(
    "/app/workbench-shell.client.tsx",
    "WorkbenchShell",
    {
      request: "Experiment summary",
      response: "Selected response",
      inspect: "Selected inspection",
      view: "request",
      onViewChange() {},
    },
  );

  assert.match(html, /<button[^>]+class="active"[^>]*>Request<\/button>/);
  assert.match(html, /<button type="button">Response<\/button>/);
  assert.doesNotMatch(html, /Experiment<\/button>/);
  assert.match(html, /Experiment summary/);
  assertNoBrokenValues(html);
});
