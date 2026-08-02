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
        revisionCreatedAt: "2026-08-01T12:00:00.000Z",
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
