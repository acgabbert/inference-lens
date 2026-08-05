import assert from "node:assert/strict";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

async function renderTemplateProvenance(resolutions) {
  const [
    { TemplateProvenance },
    { renderToStaticMarkup },
    { createElement },
  ] = await Promise.all([
    ssrLoadModule("/app/run-trace-panel.client.tsx"),
    import("react-dom/server"),
    import("react"),
  ]);
  return renderToStaticMarkup(
    createElement(TemplateProvenance, { resolutions }),
  );
}

async function renderComponent(component, props) {
  const [
    module,
    { renderToStaticMarkup },
    { createElement },
  ] = await Promise.all([
    ssrLoadModule("/app/run-trace-panel.client.tsx"),
    import("react-dom/server"),
    import("react"),
  ]);
  return renderToStaticMarkup(createElement(module[component], props));
}

test("renders self-contained template provenance in the evidence inspector", async () => {
  const html = await renderTemplateProvenance([
    {
      templateUseId: "template-use_question",
      templateId: "template_question",
      templateRevisionId: "template-revision_question-2",
      templateName: "Question",
      messages: [{ role: "user", content: "Explain {{topic}}." }],
      variableDefaults: { topic: "branching" },
      values: { topic: "atomic branches" },
      outputMessageIds: ["message_question"],
    },
  ]);

  assert.match(html, /Question/);
  assert.match(html, /template-revision_question-2/);
  assert.match(html, /atomic branches/);
  assert.match(html, /message_question/);
  for (const marker of ["undefined", "NaN", "Infinity", "[object Object]"]) {
    assert.doesNotMatch(html, new RegExp(marker.replace(/[[\]]/g, "\\$&")));
  }
});

test("omits template evidence when an older trace has no captured resolutions", async () => {
  const html = await renderComponent("RunTracePanel", {
    open: true,
    runState: {
      runId: "run_without_template_evidence",
      status: { kind: "starting" },
      input: { templateResolutions: [] },
      events: [],
      turns: [],
      exchanges: {},
      toolResults: [],
      lastSequence: -1,
    },
    parentTrace: { status: "idle" },
    onLoadParentTrace() {},
    onOpenChange() {},
  });

  assert.doesNotMatch(html, /run-details-resolution-tab/);
  assert.doesNotMatch(html, /run-details-compare-tab/);
  assert.doesNotMatch(html, /project-template provenance/i);
  assert.match(html, /run-details-events-panel/);
});

test("attempt diff selection defaults only to a retry or parent/current pair", async () => {
  const { defaultAttemptDiffSelection, validAttemptDiffKeys } =
    await ssrLoadModule("/app/run-trace-panel.client.tsx");
  const candidate = (runId, turnId, turnIndex, attempt, status) => ({
    runId,
    runLabel: runId === "parent" ? "Parent run" : "Current run",
    turnId,
    turnIndex,
    attempt,
    exchangeId: `${runId}-${turnId}-${attempt}`,
    status,
  });
  const ordinaryTurns = [
    candidate("current", "one", 1, 1, "completed"),
    candidate("current", "two", 2, 1, "completed"),
  ];
  assert.deepEqual(defaultAttemptDiffSelection(ordinaryTurns, []), {});

  const retry = [
    candidate("current", "one", 1, 1, "failed"),
    candidate("current", "one", 1, 2, "completed"),
  ];
  assert.deepEqual(defaultAttemptDiffSelection(retry, []), {
    left: "current:current-one-1",
    right: "current:current-one-2",
  });

  const parent = [candidate("parent", "one", 1, 1, "completed")];
  const current = [candidate("current", "one", 1, 1, "completed")];
  assert.deepEqual(defaultAttemptDiffSelection(current, parent), {
    left: "parent:parent-one-1",
    right: "current:current-one-1",
  });
  assert.deepEqual(
    validAttemptDiffKeys(
      { left: "current:current-one-1", right: "current:current-one-1" },
      current,
    ),
    { left: "current:current-one-1", right: undefined },
  );
});

test("formats the compact terminal summary and omits absent metrics", async () => {
  const html = await renderComponent("RunInspectionSummary", {
    summary: {
      phase: "terminal",
      status: "completed",
      totalDurationMs: 1650,
      ttfoMs: 500,
      totalTokens: 30,
      outputTokensPerSecond: 20,
    },
  });

  assert.match(html, /Completed/);
  assert.match(html, /Duration/);
  assert.match(html, /1\.65 s/);
  assert.match(html, /First output/);
  assert.match(html, /500 ms/);
  assert.match(html, />30</);
  assert.match(html, /20\.0 tok\/s/);
  for (const marker of ["undefined", "NaN", "Infinity", "—"]) {
    assert.doesNotMatch(html, new RegExp(marker));
  }
});

test("announces the run status without reading the streamed measurements", async () => {
  const html = await renderComponent("RunTracePanel", {
    open: false,
    runState: {
      runId: "run_summary_live",
      status: { kind: "running" },
      events: [],
      turns: [],
      exchanges: {},
      toolResults: [],
      lastSequence: -1,
    },
    parentTrace: { status: "idle" },
    onLoadParentTrace() {},
    onOpenChange() {},
  });

  // The measurements beside the status change on every streamed event, so the
  // collapsed summary must expose exactly one live region: the status itself.
  assert.equal(html.match(/aria-live/g)?.length, 1);
  assert.match(
    html,
    /aria-live="polite"[^>]*>\s*<span class="run-inspection-status running">\s*Running/,
  );
});

test("idle run details stay hidden until run evidence exists", async () => {
  const html = await renderComponent("RunTracePanel", {
    open: true,
    runState: null,
    parentTrace: { status: "idle" },
    onLoadParentTrace() {},
    onOpenChange() {},
  });

  assert.equal(html, "");
});
