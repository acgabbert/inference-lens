import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * Renders the real drawer through Vite's SSR pipeline rather than asserting on
 * the projection alone. A green summary test proves the numbers are right; it
 * cannot prove they reach the screen, and it passes an absent duration or an
 * empty usage record straight through to whatever the formatter does with it.
 *
 * The summaries here are written by hand instead of derived from traces so the
 * cases a healthy provider will not produce on demand — a run that reported no
 * usage, one with no turns, one with no measured duration — are all covered.
 */
async function renderDrawer(props) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  try {
    const [{ RunHistoryDrawer }, { renderToStaticMarkup }, { createElement }] =
      await Promise.all([
        server.ssrLoadModule("/app/run-history-drawer.client.tsx"),
        import("react-dom/server"),
        import("react"),
      ]);
    return renderToStaticMarkup(
      createElement(RunHistoryDrawer, {
        open: true,
        projectName: "demo-project",
        onClose() {},
        async onSelect() {},
        async onSelectExperiment() {},
        ...props,
      }),
    );
  } finally {
    await server.close();
  }
}

function historyState(overrides = {}) {
  const state = {
    status: "loaded",
    entries: [],
    items: [],
    experiments: [],
    failures: [],
    artifactCount: 0,
    largeHistory: false,
    async refresh() {},
    async readTrace() {
      throw new Error("not used");
    },
    ...overrides,
  };
  if (!("entries" in overrides)) {
    state.entries = [
      ...state.items.map((item) => ({ kind: "run", item })),
      ...state.experiments.map((item) => ({ kind: "experiment", item })),
    ];
  }
  return state;
}

function summary(overrides) {
  return {
    runId: "run_example",
    startedAt: "2026-07-25T12:00:00.000Z",
    endedAt: "2026-07-25T12:00:00.550Z",
    status: "completed",
    model: "example-model",
    durationMs: 550,
    usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    turnCount: 1,
    attemptCount: 1,
    retryCount: 0,
    messageCount: 1,
    ...overrides,
  };
}

/** The failure modes a numeric UI leaks when a value is absent. */
function assertNoBrokenNumbers(html) {
  for (const marker of ["NaN", "Infinity", "undefined", "[object Object]"]) {
    assert.doesNotMatch(
      html,
      new RegExp(marker.replace(/[[\]]/g, "\\$&")),
      `rendered history contains ${marker}`,
    );
  }
}

test("renders each saved run's model, status, and measured numbers", async () => {
  const html = await renderDrawer({
    history: historyState({
      items: [
        {
          fileName: "run_alpha.json",
          summary: summary({
            runId: "run_alpha",
            model: "alpha-model",
            durationMs: 1650,
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            turnCount: 2,
          }),
        },
      ],
    }),
  });

  assert.match(html, /alpha-model/);
  assert.match(html, /completed/);
  // 1650 ms crosses the formatter's second boundary.
  assert.match(html, /1\.65 s/);
  assert.match(html, /30 tokens/);
  assert.match(html, /2 turns/);
  assert.match(html, /run_alpha\.json/);
  assertNoBrokenNumbers(html);
});

test("renders absent measurements as a dash rather than as zero", async () => {
  const html = await renderDrawer({
    history: historyState({
      items: [
        {
          fileName: "run_cancelled.json",
          summary: summary({
            runId: "run_cancelled",
            status: "cancelled",
            durationMs: undefined,
            usage: {},
            turnCount: 0,
          }),
        },
      ],
    }),
  });

  assert.match(html, /cancelled/);
  // Both the duration and the token count are unmeasured, not zero.
  assert.match(html, /—\s*·\s*—\s*tokens/);
  assert.match(html, /0 turns/);
  assertNoBrokenNumbers(html);
});

test("labels a retried run with its retry count", async () => {
  const html = await renderDrawer({
    history: historyState({
      items: [
        {
          fileName: "run_retried.json",
          summary: summary({
            runId: "run_retried",
            status: "failed",
            attemptCount: 2,
            retryCount: 1,
          }),
        },
      ],
    }),
  });

  assert.match(html, /failed/);
  assert.match(html, /1 retry/);
  assertNoBrokenNumbers(html);
});

test("a listing that has not been attempted does not render as an empty project", async () => {
  const idle = await renderDrawer({ history: historyState({ status: "idle" }) });

  assert.match(idle, /Loading…/);
  assert.doesNotMatch(idle, /No saved runs yet/);

  const loaded = await renderDrawer({ history: historyState() });

  assert.match(loaded, /No saved evidence yet/);
  assert.match(loaded, /0 saved entries/);
});

test("surfaces a failed listing and the artifacts it skipped", async () => {
  const html = await renderDrawer({
    history: historyState({
      status: "loaded",
      items: [{ fileName: "run_ok.json", summary: summary() }],
      failures: [
        { fileName: "torn.json", message: "Run trace is not valid JSON." },
      ],
    }),
  });

  assert.match(html, /1 saved entry/);
  assert.match(html, /1 invalid history artifact was skipped/);
  assert.match(html, /torn\.json/);
  assert.match(html, /not valid JSON/);
  // One damaged artifact must not hide the runs that are readable.
  assert.match(html, /run_ok\.json/);
  assertNoBrokenNumbers(html);
});

test("renders repeated experiments as one grouped history entry", async () => {
  const experiment = {
    experimentId: "experiment_grouped",
    planFileName: "experiment_grouped.plan.json",
    resultFileName: "experiment_grouped.result.json",
    createdAt: "2026-07-25T13:00:00.000Z",
    endedAt: "2026-07-25T13:01:00.000Z",
    model: "grouped-model",
    lifecycle: "completed",
    requested: 5,
    completed: 4,
    failed: 1,
    cancelled: 0,
    notRun: 0,
    missingTrace: 0,
    cells: [],
  };
  const html = await renderDrawer({
    selectedExperimentId: experiment.experimentId,
    history: historyState({ experiments: [experiment] }),
  });

  assert.match(html, /1 saved entry/);
  assert.match(html, /Repeated experiment · grouped-model/);
  assert.match(html, /5 repetitions · 4 completed · 1 failed/);
  assert.match(html, /experiment_grouped\.plan\.json/);
  assert.match(html, /aria-current="true"/);
  assertNoBrokenNumbers(html);
});

test("warns about large immutable history without implying deletion", async () => {
  const html = await renderDrawer({
    history: historyState({ artifactCount: 500, largeHistory: true }),
  });
  assert.match(html, /Large project history/);
  assert.match(html, /500 immutable artifacts/);
  assert.match(html, /Nothing was deleted/);
});
