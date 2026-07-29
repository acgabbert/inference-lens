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

async function renderConfirmation(props) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    logLevel: "warn",
  });
  try {
    const [{ ConfirmationDialog }, { renderToStaticMarkup }, { createElement }] =
      await Promise.all([
        server.ssrLoadModule("/app/confirmation-dialog.client.tsx"),
        import("react-dom/server"),
        import("react"),
      ]);
    return renderToStaticMarkup(createElement(ConfirmationDialog, props));
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
      recommendedTarget: {
        connectionRequirementId: "connection_default",
        model: "fixture-model",
      },
    },
  ],
};

test("renders the project template library and revision defaults", async () => {
  const html = await render("ProjectTemplatesPane", {
    templates: [template],
    connectionRequirements: [
      { id: "connection_default", name: "Default connection" },
    ],
    defaultConnectionRequirementId: "connection_default",
    usageCounts: new Map([["template_question", 2]]),
    itemCount: 3,
    onCreate: () => "template_new",
    onSave: () => "template-revision_question-1",
    onInsert: () => {},
  });

  assert.match(html, /Question/);
  assert.match(html, /2 uses/);
  assert.match(html, /Revision defaults/);
  assert.match(html, /Recommended target/);
  assert.match(html, /fixture-model/);
  assert.match(html, /\{\{topic\}\}/);
  assert.match(html, /Add to conversation/);
});

test("renders a multiline run value with save and reset actions", async () => {
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
    runOverrides: { topic: "temporary\nsecond line" },
    onSaveValues: () => {},
    onSaveRunValue: () => {},
    onRunOverridesChange: () => {},
    onUpdateLatest: () => {},
    onDetach: () => {},
    onRemove: () => {},
  });

  assert.match(html, /Value for run/);
  assert.match(html, /<textarea[^>]*>temporary\nsecond line<\/textarea>/);
  assert.match(html, /Session override/);
  assert.match(html, /Prompt preview/);
  assert.match(html, /template-variable-chip/);
  assert.match(html, /Save to project/);
  assert.match(html, /Reset/);
});

test("summarizes unresolved template values without repeating diagnostic rows", async () => {
  const unresolvedTemplate = {
    ...template,
    revisions: template.revisions.map((revision) => ({
      ...revision,
      variableDefaults: {},
    })),
  };
  const diagnostic = {
    itemIndex: 0,
    templateUseId: "template-use_question",
    diagnostic: {
      code: "missing-template-variable",
      name: "topic",
      occurrences: [],
      message: 'Template variable "topic" has no value.',
    },
  };
  const html = await render("TemplateUseCard", {
    template: unresolvedTemplate,
    use: {
      id: "template-use_question",
      templateId: template.id,
      templateRevisionId: template.currentRevisionId,
      values: {},
      outputMessageIds: ["message_question"],
      fragmentRole: "user",
    },
    diagnostics: [diagnostic, diagnostic],
    runOverrides: {},
    onSaveValues: () => {},
    onSaveRunValue: () => {},
    onRunOverridesChange: () => {},
    onUpdateLatest: () => {},
    onDetach: () => {},
    onRemove: () => {},
  });

  assert.match(html, />1 missing</);
  assert.doesNotMatch(html, /Template variable &quot;topic&quot; has no value\./);
  assert.match(html, /template-variable-chip missing/);
  assert.match(html, /Needs a value/);
});

test("labels non-current revisions without a Previous 0 state", async () => {
  const olderCurrent = {
    ...template,
    currentRevisionId: "template-revision_question-1",
    revisions: [
      ...template.revisions,
      {
        id: "template-revision_question-2",
        createdAt: "2026-07-26T13:00:00.000Z",
        content: { kind: "fragment", text: "New {{topic}}" },
        variableDefaults: { topic: "new" },
      },
    ],
  };
  const html = await render("ProjectTemplatesPane", {
    templates: [olderCurrent],
    usageCounts: new Map(),
    itemCount: 0,
    onCreate: () => "template_new",
    onSave: () => "template-revision_question-1",
    onInsert: () => {},
  });

  assert.doesNotMatch(html, /Previous 0/);
  assert.match(html, /Revision 2/);
});

test("renders a structured, testable confirmation dialog", async () => {
  const html = await renderConfirmation({
    request: {
      title: 'Update "Question"?',
      description: "Pin the latest revision.",
      confirmLabel: "Update to latest",
      details: [
        { label: "Variables", value: "topic → subject" },
        { label: "Latest content", value: "Explain {{subject}}" },
      ],
      onConfirm: () => {},
    },
    onClose: () => {},
  });

  assert.match(html, /role="dialog"/);
  assert.match(html, /Update to latest/);
  assert.match(html, /topic → subject/);
  assert.doesNotMatch(html, /\{\s*&quot;kind&quot;/);
});
