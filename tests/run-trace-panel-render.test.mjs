import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

async function renderTemplateProvenance(resolutions) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    logLevel: "warn",
  });
  try {
    const [
      { TemplateProvenance },
      { renderToStaticMarkup },
      { createElement },
    ] = await Promise.all([
      server.ssrLoadModule("/app/run-trace-panel.client.tsx"),
      import("react-dom/server"),
      import("react"),
    ]);
    return renderToStaticMarkup(
      createElement(TemplateProvenance, { resolutions }),
    );
  } finally {
    await server.close();
  }
}

async function renderComponent(component, props) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    logLevel: "warn",
  });
  try {
    const [
      module,
      { renderToStaticMarkup },
      { createElement },
    ] = await Promise.all([
      server.ssrLoadModule("/app/run-trace-panel.client.tsx"),
      import("react-dom/server"),
      import("react"),
    ]);
    return renderToStaticMarkup(createElement(module[component], props));
  } finally {
    await server.close();
  }
}

test("renders self-contained template provenance in the evidence inspector", async () => {
  const html = await renderTemplateProvenance([
    {
      templateUseId: "template-use_question",
      templateId: "template_question",
      templateRevisionId: "template-revision_question-2",
      templateName: "Question",
      content: { kind: "fragment", text: "Explain {{topic}}." },
      variableDefaults: { topic: "branching" },
      values: { topic: "atomic branches" },
      outputMessageIds: ["message_question"],
      fragmentRole: "user",
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
  assert.doesNotMatch(html, /project-template provenance/i);
  assert.match(html, /run-details-events-panel/);
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

test("idle run details cannot expose an empty inspector body", async () => {
  const html = await renderComponent("RunTracePanel", {
    open: true,
    runState: null,
    parentTrace: { status: "idle" },
    onLoadParentTrace() {},
    onOpenChange() {},
  });

  assert.match(html, /<button[^>]+disabled=""[^>]*>[\s\S]*Run details/);
  assert.doesNotMatch(html, /role="tabpanel"/);
  assert.doesNotMatch(html, /Normalized events will appear here/);

  // The idle toggle explains why it cannot be opened, by pointer and by AT.
  assert.match(html, /aria-describedby="trace-toggle-hint"/);
  assert.match(
    html,
    /<span class="visually-hidden" id="trace-toggle-hint">Run details become available once a run starts\./,
  );
  assert.match(html, /title="Run details become available once a run starts\./);
});
