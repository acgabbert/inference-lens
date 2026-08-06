import assert from "node:assert/strict";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

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
  const [{ RunHistoryDrawer }, { renderToStaticMarkup }, { createElement }] =
    await Promise.all([
      ssrLoadModule("/app/run-history-drawer.client.tsx"),
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

test("an evaluation row reports its strict pass rate, not its run status", async () => {
  // Every run completed. Under strict scoring the suite still failed, and the
  // row must say so: "2 completed" would describe the provider calls and hide
  // the only outcome an author opened history to find.
  const experiment = {
    experimentId: "experiment_eval",
    kind: "evaluation",
    planFileName: "experiment_eval.plan.json",
    resultFileName: "experiment_eval.result.json",
    createdAt: "2026-07-25T14:00:00.000Z",
    endedAt: "2026-07-25T14:01:00.000Z",
    lifecycle: "completed",
    requested: 4,
    completed: 4,
    failed: 0,
    cancelled: 0,
    notRun: 0,
    missingTrace: 0,
    cells: [],
    evaluation: {
      suiteId: "evaluation-suite_topics",
      suiteName: "Topics",
      conversationRevisionId: "revision_one",
      variants: [{
        variantId: "evaluation-variant_default",
        name: "Default",
        model: "eval-model",
        passed: false,
        caseCounts: { total: 3, passed: 1, failed: 2, incomplete: 0 },
      }],
    },
  };
  const html = await renderDrawer({
    history: historyState({ experiments: [experiment] }),
  });

  assert.match(html, /Evaluation · Topics/);
  assert.match(html, /1\/3 cases passed/);
  assert.match(html, /3 cases · 4 planned runs · eval-model/);
  assert.doesNotMatch(html, /4 completed/);
  assertNoBrokenNumbers(html);
});

test("an evaluation that could not be scored says so rather than reporting zero passes", async () => {
  const html = await renderDrawer({
    history: historyState({
      experiments: [{
        experimentId: "experiment_unscored",
        kind: "evaluation",
        planFileName: "experiment_unscored.plan.json",
        createdAt: "2026-07-25T15:00:00.000Z",
        lifecycle: "interrupted",
        requested: 2,
        completed: 0,
        failed: 0,
        cancelled: 0,
        notRun: 2,
        missingTrace: 0,
        cells: [],
        evaluation: {
          suiteId: "evaluation-suite_topics",
          suiteName: "Topics",
          conversationRevisionId: "revision_one",
          variants: [],
        },
      }],
    }),
  });

  assert.match(html, /not scored/);
  assert.doesNotMatch(html, /0\/0 cases passed/);
  assertNoBrokenNumbers(html);
});

test("the kind filter is offered with every entry shown by default", async () => {
  const html = await renderDrawer({
    history: historyState({ items: [{ fileName: "run_alpha.json", summary: summary() }] }),
  });

  for (const label of ["All", "Runs", "Repeated", "Evaluations"]) {
    assert.match(html, new RegExp(`>${label}</button>`));
  }
  assert.match(html, /aria-pressed="true"[^>]*>All</);
  assert.match(html, /1 saved entry/);
});
