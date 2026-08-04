import assert from "node:assert/strict";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { uniqueViteCacheDir } from "./support/vite-cache-dir.mjs";
import { evaluationFixture } from "./fixtures/evaluation-suite-authoring.mjs";

async function render(authoring, execution, history) {
  const server = await createServer({ configFile: false, cacheDir: uniqueViteCacheDir(), root: process.cwd(), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "warn" });
  try {
    const [{ EvaluationSuiteEditor }, { renderToStaticMarkup }, { createElement }] = await Promise.all([
      server.ssrLoadModule("/app/evaluations/evaluation-suite-editor.client.tsx"),
      import("react-dom/server"), import("react"),
    ]);
    return renderToStaticMarkup(createElement(EvaluationSuiteEditor, { authoring, execution, history }));
  } finally { await server.close(); }
}

/** The preview is the response pane's occupant, so it renders on its own. */
async function renderPreview(authoring, execution) {
  const server = await createServer({ configFile: false, cacheDir: uniqueViteCacheDir(), root: process.cwd(), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "warn" });
  try {
    const [{ EvaluationPreviewWorkspace }, { renderToStaticMarkup }, { createElement }] = await Promise.all([
      server.ssrLoadModule("/app/evaluations/evaluation-case-preview.client.tsx"),
      import("react-dom/server"), import("react"),
    ]);
    return renderToStaticMarkup(createElement(EvaluationPreviewWorkspace, { authoring, execution }));
  } finally { await server.close(); }
}

test("renders compact preflight and the focused case workspace", async () => {
  const html = await render(evaluationFixture(), { storage: "durable", running: false, onStart() {} });
  assert.match(html, /Topic quality/);
  assert.match(html, /Case inputs/);
  assert.match(html, /Question/);
  assert.match(html, /topic<\/code> template variable/);
  assert.doesNotMatch(html, /template-use_question/);
  assert.doesNotMatch(html, /Input name Topic/);
  assert.match(html, /database migrations/);
  assert.match(html, /Contains text/);
  assert.match(html, /1 selected<\/span> × <span>3 reps<\/span> → <strong>3 runs/);
  assert.match(html, /Do not enter credentials or secrets/);
  // The mode gives the editor the whole surface, so there is nothing left for a
  // focus mode to expand into and it is gone.
  assert.doesNotMatch(html, /focus mode/i);
  assert.match(html, /Ready to run/);
  // The suite's identity is a heading now rather than an option in a select.
  assert.match(html, /<h2>Topic quality<\/h2>/);
  // Setup is a band that can be shut, so its summary states everything a start
  // depends on: the connection, the model, tool exposure, and repetitions.
  assert.match(html, /Buffered fixture · buffered-test-model · No tools · 3 reps/);
  // Expanded by default, so it has to carry a marked affordance or it reads as
  // a heading and nobody finds out it collapses.
  assert.match(html, /_setupChevron/);
  assert.match(html, /_setupHint[^"]*">Hide</);

  // The reference answer is an optional human note that nothing scores, so it
  // sits below the checks rather than above them, behind a disclosure that
  // opens itself only because this fixture's case has one written.
  const checksAt = html.indexOf("evaluation-check-list");
  const referenceAt = html.indexOf("evaluation-reference-answer");
  assert.ok(checksAt > 0 && referenceAt > checksAt, "checks come before the reference answer");
  assert.match(html, /<details class="evaluation-reference-answer" open=""/);
  assert.match(html, /Reference answer<span>Written<\/span>/);
  assert.match(html, /aria-label="Evaluation cases"/);
  // The Start button is the mode's primary action and lives in the topbar now,
  // so the preflight band states readiness and never restates the control.
  assert.doesNotMatch(html, /Start evaluation…/);
  assert.match(html, /suite keeps its own immutable input/i);
  assert.match(html, /plan, traces, and result will be saved/i);
  // The provider-input preview is the response pane's, not the editor's: the
  // editor keeps the controls, the pane shows what they resolve to.
  assert.doesNotMatch(html, /Provider input/);
  assert.doesNotMatch(html, /Explain database migrations\./);
  assert.doesNotMatch(html, /other cases can resolve to different messages/i);
});

test("warns without resizing large batches and names session-only evidence", async () => {
  const authoring = evaluationFixture();
  authoring.repetitions = 25;
  const html = await render(authoring, { storage: "unsaved", running: false, onStart() {} });
  assert.match(html, /25 runs/);
  assert.match(html, /Large evaluation batch: 25 provider calls/);
  assert.match(html, /results will be lost when this session closes/i);
});

test("explains when cases do not vary provider input", async () => {
  const authoring = evaluationFixture();
  authoring.project.evaluationSuites[0].inputBindings = [];
  authoring.project.evaluationSuites[0].cases[0].values = {};
  authoring.candidates = [];
  const preview = await renderPreview(authoring);
  assert.match(preview, /All cases currently use this provider input/);
  assert.match(preview, /References and checks may still differ/);
  const html = await render(authoring);
  assert.doesNotMatch(html, /evaluation-input-manager/);
});

test("shows an explicit error above the repetition maximum", async () => {
  const authoring = evaluationFixture();
  authoring.repetitions = 101;
  const html = await render(authoring, { storage: "durable", running: false, onStart() {} });
  assert.match(html, /at most 100 repetitions/);
  assert.match(html, /value was not changed/i);
  assert.doesNotMatch(html, /Ready to run/);
});

test("the editor names what serves each exposed tool and bounds the worst case", async () => {
  const authoring = evaluationFixture();
  authoring.project.tools = [
    { id: "tool_weather", name: "get_weather", inputSchema: { type: "object", properties: {} } },
    { id: "tool_db", name: "query_db", inputSchema: { type: "object", properties: {} } },
  ];
  authoring.project.evaluationSuites[0].execution.toolIds = ["tool_weather", "tool_db"];
  const html = await render(authoring, {
    storage: "durable",
    running: false,
    onStart() {},
    toolBindings: [
      {
        tool: authoring.project.tools[0],
        binding: { toolId: "tool_weather", kind: "mock", executorId: "mock_sunny", label: "sunny default" },
      },
      { tool: authoring.project.tools[1] },
    ],
  });
  assert.match(html, /2 exposed/);
  assert.match(html, /mock &quot;sunny default&quot;/);
  // The unbound one is named while the suite is authored, not only at start.
  assert.match(html, /Nothing on this device serves query_db/);
  // Floor and ceiling both stated: three repetitions, five turns each.
  assert.match(html, /<strong>3 runs<\/strong>.*up to 15 provider calls/);
  assert.match(html, /failed if it reaches 5 provider turns/);
});

test("a suite that exposes no tools shows neither a ceiling nor a call range", async () => {
  const authoring = evaluationFixture();
  authoring.project.tools = [
    { id: "tool_weather", name: "get_weather", inputSchema: { type: "object", properties: {} } },
  ];
  const html = await render(authoring, { storage: "durable", running: false, onStart() {} });
  assert.match(html, /None exposed/);
  assert.doesNotMatch(html, /Turn ceiling/);
  assert.doesNotMatch(html, /up to \d+ provider calls/);
});

test("evaluation confirmation lists the binding behind every tool it will serve", async () => {
  const server = await createServer({ configFile: false, cacheDir: uniqueViteCacheDir(), root: process.cwd(), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "warn" });
  try {
    const [{ EvaluationStartDialog }, { renderToStaticMarkup }, { createElement }] = await Promise.all([
      server.ssrLoadModule("/app/evaluations/evaluation-start-dialog.client.tsx"),
      import("react-dom/server"), import("react"),
    ]);
    const html = renderToStaticMarkup(createElement(EvaluationStartDialog, {
      draft: {
        targetName: "Fixture profile",
        revisionLabel: "Current · Aug 1, 12:00 PM",
        storage: "durable",
        toolBindings: [{
          tool: { id: "tool_weather", name: "get_weather" },
          binding: { toolId: "tool_weather", kind: "command", executorId: "weather", label: "Local weather script" },
        }],
        plan: {
          repetitions: 2,
          turnCeiling: 4,
          cells: Array.from({ length: 4 }),
          suite: { name: "Quality gate", conversationRevisionId: "revision_frozen", cases: [
            { caseId: "evaluation-case_1", name: "Case 1", input: { target: { model: "fixture-model" } } },
            { caseId: "evaluation-case_2", name: "Case 2", input: { target: { model: "fixture-model" } } },
          ] },
        },
      },
      onCancel() {}, onConfirm() {},
    }));
    assert.match(html, /Tools served automatically/);
    assert.match(html, /command &quot;Local weather script&quot;/);
    // The cost sentence is a range once a repetition can buy another turn.
    assert.match(html, /4–16 — one per repetition, up to 4/);
    assert.match(html, /Start 4 repetitions/);
  } finally { await server.close(); }
});

test("evaluation confirmation names the frozen revision, target, cases, repetitions, calls, and storage", async () => {
  const server = await createServer({ configFile: false, cacheDir: uniqueViteCacheDir(), root: process.cwd(), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "warn" });
  try {
    const [{ EvaluationStartDialog }, { renderToStaticMarkup }, { createElement }] = await Promise.all([
      server.ssrLoadModule("/app/evaluations/evaluation-start-dialog.client.tsx"),
      import("react-dom/server"), import("react"),
    ]);
    const target = { model: "fixture-model" };
    const cases = Array.from({ length: 5 }, (_, index) => ({
      caseId: `evaluation-case_${index + 1}`,
      name: `Case ${index + 1}`,
      input: { target },
    }));
    const html = renderToStaticMarkup(createElement(EvaluationStartDialog, {
      draft: {
        targetName: "Fixture profile",
        toolBindings: [],
        revisionLabel: "Current · Question · “Explain a topic.” · Aug 1, 12:00 PM",
        storage: "durable",
        plan: {
          repetitions: 5,
          cells: Array.from({ length: 25 }),
          suite: { name: "Quality gate", conversationRevisionId: "revision_frozen", cases },
        },
      },
      onCancel() {}, onConfirm() {},
    }));
    assert.match(html, /revision_frozen/);
    // Confirmation reuses the projected description rather than reformatting a
    // raw timestamp, so it names the same revision preflight showed.
    assert.match(html, /Current · Question · “Explain a topic\.” · Aug 1, 12:00 PM/);
    assert.match(html, /Fixture profile · fixture-model/);
    assert.match(html, /5 · Case 1, Case 2, Case 3, Case 4, Case 5/);
    assert.match(html, /5 per case/);
    assert.match(html, /25 planned/);
    assert.match(html, /Saved to the open project folder/);
    assert.match(html, /Large evaluation batch/);
  } finally { await server.close(); }
});

test("renders revision incompatibility as a setup issue", async () => {
  const authoring = evaluationFixture();
  authoring.diagnostics = [{ code: "missing-template-variable", message: "Selected revision no longer has topic." }];
  const html = await render(authoring);
  assert.match(html, /1 setup issue/);
  assert.match(html, /Selected revision no longer has topic/);
});

test("contains provider preview errors for a historical revision missing a bound template use", async () => {
  const authoring = evaluationFixture();
  authoring.project.conversationRevisions.push({
    id: "revision_historical",
    conversationId: "conversation_fixture",
    createdAt: "2026-07-31T12:00:00.000Z",
    items: [],
  });
  authoring.revisionId = "revision_historical";
  authoring.diagnostics = [{
    code: "missing-template-use",
    message: 'Selected revision does not contain template use "template-use_question".',
  }];
  // What resolveEvaluationCase reports for this revision: the binding has
  // nowhere to go, so it contributes no override and the revision renders
  // empty rather than throwing.
  authoring.selectedRevision = {
    revisionId: "revision_historical",
    conversationId: "conversation_fixture",
    createdAt: "2026-07-31T12:00:00.000Z",
    isCurrentRevision: false,
    templateUses: [],
    messageCount: 0,
    summary: "",
    resolvable: true,
    compatibility: {
      kind: "incompatible",
      mismatches: [{
        inputBindingId: "evaluation-input_topic",
        inputName: "Topic",
        templateUseId: "template-use_question",
        variableName: "topic",
        reason: "missing-template-use",
      }],
    },
  };
  authoring.revisionChoices = [authoring.revisionChoices[0], authoring.selectedRevision];
  authoring.focusedCaseResolution = {
    ok: true,
    messages: [],
    templateResolutions: [],
    variables: [],
    caseValues: {},
    unresolvedBindings: [{
      inputBindingId: "evaluation-input_topic",
      inputName: "Topic",
      templateUseId: "template-use_question",
      variableName: "topic",
      reason: "missing-template-use",
    }],
  };

  // The setup issue is preflight's, in the editor; the unsatisfiable binding is
  // the preview's. The two panes report the same failure from one resolution.
  const html = await render(authoring);
  assert.match(html, /1 setup issue/);
  assert.match(html, /Selected revision does not contain template use/);

  const preview = await renderPreview(authoring);
  // The unsatisfiable binding is a visible row in the value table, not a
  // silently dropped override.
  assert.match(preview, /Case input “Topic” has nowhere to go/);
  assert.match(preview, /revision has no such template use/);
  assert.match(preview, /evaluation-value-missing/);
  assert.match(preview, /resolves to no messages/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
  assert.doesNotMatch(preview, /NaN|Infinity|undefined|\[object Object\]/);
});

test("renders the four focused-case preflight regions from the shared resolution", async () => {
  const authoring = evaluationFixture();
  const html = await renderPreview(authoring, {
    storage: "durable",
    running: false,
    onStart() {},
    preview: {
      targetName: "Buffered fixture",
      endpoint: "http://127.0.0.1:44014/v1",
      protocol: "openai-compatible-chat-completions",
      model: "buffered-test-model",
      responseMode: "buffered",
      options: { temperature: 0.4, maxOutputTokens: 256, stop: ["</end>"] },
    },
  });

  // The pane names itself and the case it is showing, so an author reading the
  // right-hand pane never has to look left to know which case this is.
  assert.match(html, /<h2>Provider input<\/h2>/);
  assert.match(html, /aria-label="Provider input for Migrations"/);
  assert.match(html, /Migrations/);

  // 1. Revision provenance: a meaningful label, the pinned template revision,
  //    and the stable ID kept in details rather than as the primary label.
  assert.match(html, /aria-label="Revision provenance for Migrations"/);
  const localRevisionTime = new Date(authoring.selectedRevision.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  assert.ok(html.includes(`Current · Question · “Explain a topic.” · ${localRevisionTime}`));
  assert.match(html, /pinned to the template’s current revision/);
  assert.match(html, /template-revision_question/);
  assert.match(html, /<summary>Stable identity<\/summary>/);
  assert.match(html, /revision_current/);

  // 2. Resolved values: effective value and where it came from.
  assert.match(html, /aria-label="Resolved values for Migrations"/);
  assert.match(html, /<td>Case value · Topic<\/td>/);

  // 3. Resolved conversation: the exact ordered rendered text.
  assert.match(html, /aria-label="Resolved conversation for Migrations"/);
  assert.match(html, /Explain database migrations\./);

  // 4. Execution settings: connection, endpoint, protocol, model, delivery,
  //    every populated inference option, and tools.
  assert.match(html, /aria-label="Execution settings for Migrations"/);
  assert.match(html, /<dd>Buffered fixture<\/dd>/);
  assert.match(html, /http:\/\/127\.0\.0\.1:44014\/v1/);
  assert.match(html, /openai-compatible-chat-completions/);
  assert.match(html, /buffered-test-model/);
  assert.match(html, /<dt>Delivery<\/dt><dd>Buffered<\/dd>/);
  assert.match(html, /<dt>Temperature<\/dt><dd>0\.4<\/dd>/);
  assert.match(html, /<dt>Max output tokens<\/dt><dd>256<\/dd>/);
  assert.match(html, /<dt>Stop sequences<\/dt><dd>&lt;\/end&gt;<\/dd>/);
  assert.match(html, /<dt>Tools<\/dt><dd>None<\/dd>/);
  // Seed and provider options are unset, so the region omits them rather than
  // rendering blank rows.
  assert.doesNotMatch(html, /<dt>Seed<\/dt>/);
  assert.doesNotMatch(html, /<dt>Provider options<\/dt>/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);

  // With the pane's room, provenance and execution settings are headings the
  // author reads, not disclosures they have to open. Only the stable IDs stay
  // behind a summary.
  assert.match(html, /<h5>Revision provenance<\/h5>/);
  assert.match(html, /<h5>Execution settings<\/h5>/);
  assert.doesNotMatch(html, /<summary>Revision provenance<\/summary>/);
  assert.doesNotMatch(html, /<summary>Execution settings<\/summary>/);
});

test("shows every value source and keeps a variable with no value visible as a setup error", async () => {
  const authoring = evaluationFixture();
  authoring.focusedCaseResolution = {
    ...authoring.focusedCaseResolution,
    variables: [
      ...authoring.focusedCaseResolution.variables,
      {
        templateUseId: "template-use_question",
        templateId: "template_question",
        templateName: "Question",
        templateRevisionId: "template-revision_question",
        variableName: "audience",
        value: "auditors",
        source: "authored-use",
      },
      {
        templateUseId: "template-use_question",
        templateId: "template_question",
        templateName: "Question",
        templateRevisionId: "template-revision_question",
        variableName: "tone",
        value: "plain",
        source: "template-default",
      },
      {
        templateUseId: "template-use_question",
        templateId: "template_question",
        templateName: "Question",
        templateRevisionId: "template-revision_question",
        variableName: "format",
      },
    ],
  };

  const html = await renderPreview(authoring);

  assert.match(html, /<td>Case value · Topic<\/td>/);
  assert.match(html, /<td>Authored use value<\/td>/);
  assert.match(html, /<td>Template default<\/td>/);
  assert.match(html, /No value at any level/);
  assert.match(html, /<td>Setup error<\/td>/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
});

test("marks a disagreeing prompt target recommendation as advisory without changing the target", async () => {
  const authoring = evaluationFixture();
  authoring.project.connectionRequirements = [
    { id: "connection_default", name: "Research cluster" },
  ];
  authoring.project.promptTemplates[0].recommendedTarget = {
    connectionRequirementId: "connection_default",
    model: "authored-against-model",
  };

  const execution = {
    storage: "durable",
    running: false,
    onStart() {},
    preview: {
      targetName: "Buffered fixture",
      endpoint: "http://127.0.0.1:44014/v1",
      protocol: "openai-compatible-chat-completions",
      model: "buffered-test-model",
      responseMode: "buffered",
      options: { temperature: 0.4 },
    },
  };
  const preview = await renderPreview(authoring, execution);

  assert.match(preview, /Question was authored against Research cluster · authored-against-model/);
  assert.match(preview, /The evaluation target below is unchanged/);
  assert.match(preview, /<dt>Model<\/dt><dd>buffered-test-model<\/dd>/);
  assert.doesNotMatch(preview, /NaN|Infinity|undefined|\[object Object\]/);

  // Advisory, not blocking: preflight in the editor is still ready to run.
  const html = await render(authoring, execution);
  assert.match(html, /Ready to run/);
});

function suiteHistory(overrides = {}) {
  return {
    status: "loaded",
    executions: [],
    onExpand() {},
    onRefresh() {},
    async onOpen() {},
    ...overrides,
  };
}

function execution(overrides = {}) {
  return {
    experimentId: "experiment_past",
    kind: "evaluation",
    planFileName: "experiment_past.plan.json",
    createdAt: "2026-08-02T09:30:00.000Z",
    model: "past-model",
    lifecycle: "completed",
    requested: 3,
    completed: 3,
    failed: 0,
    cancelled: 0,
    notRun: 0,
    missingTrace: 0,
    cells: [],
    evaluation: {
      suiteId: "evaluation-suite_topics",
      suiteName: "Topic quality",
      conversationRevisionId: "revision_current",
      passed: true,
      caseCounts: { total: 2, passed: 2, failed: 0 },
    },
    ...overrides,
  };
}

test("past executions are offered in the editor and stay collapsed until asked for", async () => {
  const html = await render(
    evaluationFixture(),
    { storage: "durable", running: false, onStart() {} },
    suiteHistory({ executions: [execution()] }),
  );

  assert.match(html, /Past executions/);
  // Collapsed: listing every artifact in the project folder is expensive, so
  // opening a project must not pay for a list nobody asked to see.
  assert.doesNotMatch(html, /<details class="evaluation-suite-history" open/);
  assert.doesNotMatch(html, /Refresh/);
  // Collapsed, the card holds two words and no visible content, so it has to
  // say it opens. A native marker alone did not read as a disclosure.
  assert.match(html, /Show saved runs of this suite/);
  assert.match(html, /evaluation-suite-history-chevron/);
  // Scoped to this disclosure's own hint: the setup band above it is a second
  // disclosure, and it is open, so a bare />Hide</ now matches that one.
  assert.doesNotMatch(html, /evaluation-suite-history-hint">Hide</);
});

test("the editor omits past executions entirely without a project folder", async () => {
  const html = await render(evaluationFixture(), { storage: "unsaved", running: false, onStart() {} });
  assert.doesNotMatch(html, /Past executions/);
});

test("an execution against another input revision stays listed and is marked", async () => {
  // Suite identity, not revision identity, decides membership: PR12's whole
  // point is comparing a pass rate across an input change, so hiding the older
  // run would hide the comparison.
  const html = await render(
    evaluationFixture(),
    { storage: "durable", running: false, onStart() {} },
    suiteHistory({
      currentRevisionId: "revision_current",
      executions: [
        execution(),
        execution({
          experimentId: "experiment_older",
          planFileName: "experiment_older.plan.json",
          createdAt: "2026-08-01T09:30:00.000Z",
          evaluation: {
            suiteId: "evaluation-suite_topics",
            suiteName: "Topic quality",
            conversationRevisionId: "revision_older",
            passed: false,
            caseCounts: { total: 2, passed: 1, failed: 1 },
          },
        }),
      ],
    }),
  );

  assert.match(html, /2\/2 cases passed/);
  assert.match(html, /1\/2 cases passed/);
  const drift = html.match(/Ran against a different input revision/g) ?? [];
  assert.equal(drift.length, 1, "only the older revision's execution is marked");
});

test("an interrupted evaluation is not coloured as a failure", async () => {
  const html = await render(
    evaluationFixture(),
    { storage: "durable", running: false, onStart() {} },
    suiteHistory({
      executions: [execution({
        lifecycle: "interrupted",
        evaluation: {
          suiteId: "evaluation-suite_topics",
          suiteName: "Topic quality",
          conversationRevisionId: "revision_current",
          passed: false,
          caseCounts: { total: 2, passed: 0, failed: 0 },
        },
      })],
    }),
  );

  assert.match(html, /class="evaluation-pass pending"/);
  assert.doesNotMatch(html, /class="evaluation-pass failed"/);
});
