import assert from "node:assert/strict";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { evaluationFixture } from "./fixtures/evaluation-suite-authoring.mjs";

async function render(authoring) {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "warn" });
  try {
    const [{ EvaluationSuiteEditor }, { renderToStaticMarkup }, { createElement }] = await Promise.all([
      server.ssrLoadModule("/app/evaluations/evaluation-suite-editor.client.tsx"),
      import("react-dom/server"), import("react"),
    ]);
    return renderToStaticMarkup(createElement(EvaluationSuiteEditor, { authoring }));
  } finally { await server.close(); }
}

test("renders suite preflight, case grid, checks, and paid-cell preview", async () => {
  const html = await render(evaluationFixture());
  assert.match(html, /Topic quality/);
  assert.match(html, /Template-variable inputs/);
  assert.match(html, /database migrations/);
  assert.match(html, /Contains text/);
  assert.match(html, /1 cases × 3 = <strong>3 planned runs/);
  assert.match(html, /Do not enter credentials or secrets/);
  assert.match(html, /Open evaluation editor in focus mode/);
});

test("renders revision incompatibility as a setup issue", async () => {
  const authoring = evaluationFixture();
  authoring.diagnostics = [{ code: "missing-template-variable", message: "Selected revision no longer has topic." }];
  const html = await render(authoring);
  assert.match(html, /1 setup issue/);
  assert.match(html, /Selected revision no longer has topic/);
});
