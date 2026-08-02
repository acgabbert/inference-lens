import assert from "node:assert/strict";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { evaluationFixture } from "./fixtures/evaluation-suite-authoring.mjs";

async function render(authoring, execution) {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "warn" });
  try {
    const [{ EvaluationSuiteEditor }, { renderToStaticMarkup }, { createElement }] = await Promise.all([
      server.ssrLoadModule("/app/evaluations/evaluation-suite-editor.client.tsx"),
      import("react-dom/server"), import("react"),
    ]);
    return renderToStaticMarkup(createElement(EvaluationSuiteEditor, { authoring, execution }));
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
  assert.match(html, /Open evaluation editor in focus mode/);
  assert.match(html, /Ready to run/);
  assert.match(html, /aria-label="Evaluation cases"/);
  assert.match(html, /Start evaluation…/);
  assert.match(html, /saved project revision/i);
  assert.match(html, /plan, traces, and result will be saved/i);
  assert.match(html, /Provider input/);
  assert.match(html, /Explain database migrations\./);
  assert.match(html, /other cases can resolve to different messages/i);
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
  const html = await render(authoring);
  assert.match(html, /All cases currently use this provider input/);
  assert.match(html, /References and checks may still differ/);
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

test("evaluation confirmation names the frozen revision, target, cases, repetitions, calls, and storage", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "warn" });
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

  const html = await render(authoring);

  assert.match(html, /1 setup issue/);
  assert.match(html, /Selected revision does not contain template use/);
  // The unsatisfiable binding is a visible row in the value table, not a
  // silently dropped override.
  assert.match(html, /Case input “Topic” has nowhere to go/);
  assert.match(html, /revision has no such template use/);
  assert.match(html, /evaluation-value-missing/);
  assert.match(html, /resolves to no messages/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
});

test("renders the four focused-case preflight regions from the shared resolution", async () => {
  const html = await render(evaluationFixture(), {
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

  // 1. Revision provenance: a meaningful label, the pinned template revision,
  //    and the stable ID kept in details rather than as the primary label.
  assert.match(html, /aria-label="Revision provenance for Migrations"/);
  assert.match(html, /Current · Question · “Explain a topic\.” · Aug 1, 12:00 PM/);
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

  const html = await render(authoring);

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

  const html = await render(authoring, {
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
  });

  assert.match(html, /Question was authored against Research cluster · authored-against-model/);
  assert.match(html, /The evaluation target below is unchanged/);
  // Advisory, not blocking: preflight is still ready and the target still reads
  // as the one the route supplied.
  assert.match(html, /Ready to run/);
  assert.match(html, /<dt>Model<\/dt><dd>buffered-test-model<\/dd>/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object Object\]/);
});
