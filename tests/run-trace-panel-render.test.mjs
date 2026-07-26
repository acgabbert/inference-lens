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

test("renders an explicit empty provenance state", async () => {
  const html = await renderTemplateProvenance([]);
  assert.match(html, /no project-template provenance/i);
});
