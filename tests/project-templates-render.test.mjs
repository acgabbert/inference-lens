import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

async function render(component, props) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    logLevel: "warn",
  });
  try {
    const [{ [component]: Component }, { renderToStaticMarkup }, { createElement }] =
      await Promise.all([
        server.ssrLoadModule("/app/project-templates-pane.client.tsx"),
        import("react-dom/server"),
        import("react"),
      ]);
    return renderToStaticMarkup(createElement(Component, props));
  } finally {
    await server.close();
  }
}

const template = {
  id: "template_question",
  name: "Question",
  currentRevisionId: "template-revision_question-1",
  revisions: [
    {
      id: "template-revision_question-1",
      createdAt: "2026-07-26T12:00:00.000Z",
      content: { kind: "fragment", text: "Explain {{topic}}." },
      variableDefaults: { topic: "branching" },
    },
  ],
};

test("renders the project template library and revision defaults", async () => {
  const html = await render("ProjectTemplatesPane", {
    templates: [template],
    usageCounts: new Map([["template_question", 2]]),
    itemCount: 3,
    onCreate: () => "template_new",
    onSave: () => "template-revision_question-1",
    onInsert: () => {},
  });

  assert.match(html, /Question/);
  assert.match(html, /2 uses/);
  assert.match(html, /Revision defaults/);
  assert.match(html, /\{\{topic\}\}/);
  assert.match(html, /Add to conversation/);
});

test("renders saved and run-only template use values distinctly", async () => {
  const html = await render("TemplateUseCard", {
    template,
    use: {
      id: "template-use_question",
      templateId: template.id,
      templateRevisionId: template.currentRevisionId,
      values: { topic: "saved" },
      outputMessageIds: ["message_question"],
      fragmentRole: "user",
    },
    diagnostics: [],
    runOverrides: { topic: "temporary" },
    onSaveValues: () => {},
    onRunOverridesChange: () => {},
    onUpdateLatest: () => {},
    onDetach: () => {},
    onRemove: () => {},
  });

  assert.match(html, /Saved value/);
  assert.match(html, /Run-only override/);
  assert.match(html, /Effective: &quot;temporary&quot;/);
  assert.match(html, /Clear override/);
});

