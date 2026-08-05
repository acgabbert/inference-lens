import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

async function renderImportModal() {
  const [{ N8nImportModal }, { renderToStaticMarkup }, { createElement }] =
    await Promise.all([
      ssrLoadModule("/app/n8n-import-modal.client.tsx"),
      import("react-dom/server"),
      import("react"),
    ]);
  return renderToStaticMarkup(
    createElement(N8nImportModal, {
      open: true,
      onClose: () => {},
      onImport: async () => {},
    }),
  );
}

async function renderExecutionLinkSelector() {
  const [
    { N8nExecutionLinkSelector },
    { renderToStaticMarkup },
    { createElement },
  ] = await Promise.all([
    ssrLoadModule("/app/n8n-import-modal.client.tsx"),
    import("react-dom/server"),
    import("react"),
  ]);
  return renderToStaticMarkup(
    createElement(N8nExecutionLinkSelector, {
      value:
        "https://n8n.example/workflow/workflow_1/executions/execution_1",
      loading: false,
      onChange: () => {},
      onSubmit: () => {},
    }),
  );
}

test("renders a focused and safe n8n import workspace shell", async () => {
  const html = await renderImportModal();
  assert.match(html, /role="dialog"/);
  assert.match(html, /Import from n8n/);
  assert.match(html, /resolved snapshot or a reusable native template/);
  assert.match(html, /Checking n8n integration/);
  assert.doesNotMatch(html, /undefined|NaN|Infinity/);
  assert.doesNotMatch(html, /api.?key.?[:=].+fixture/i);
});

test("renders the pasted execution-link selector", async () => {
  const html = await renderExecutionLinkSelector();
  assert.match(html, /Paste execution link/);
  assert.match(html, /aria-label="n8n execution link"/);
  assert.match(html, />Review</);
  assert.doesNotMatch(html, /undefined|NaN|Infinity/);
});

test("keeps the model recommendation checkbox from consuming the label width", async () => {
  const stylesheet = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    stylesheet,
    /\.n8n-recommendation-option label\s*\{[^}]*margin:\s*0;/s,
  );
  assert.match(
    stylesheet,
    /\.n8n-recommendation-option input\[type="checkbox"\]\s*\{[^}]*width:\s*14px;[^}]*margin:\s*1px 0 0;/s,
  );
});
