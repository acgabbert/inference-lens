import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { uniqueViteCacheDir } from "./support/vite-cache-dir.mjs";

async function render(component, props) {
  const server = await createServer({
    configFile: false, cacheDir: uniqueViteCacheDir(),
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
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
    configFile: false, cacheDir: uniqueViteCacheDir(),
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
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
      messages: [{ role: "user", content: "Explain {{topic}}." }],
      variableDefaults: { topic: "branching" },
    },
  ],
  recommendedTarget: {
    connectionRequirementId: "connection_default",
    model: "fixture-model",
  },
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
    onOpenN8nImport: () => {},
    onCreate: () => "template_new",
    onSave: () => "template-revision_question-1",
    onRename: () => true,
    onArchive: () => {},
    onRestore: () => {},
    onInsert: () => {},
  });

  assert.match(html, /Question/);
  assert.match(html, /2 uses/);
  assert.match(html, /Revision defaults/);
  assert.match(html, /Recommended target/);
  assert.match(html, /fixture-model/);
  assert.match(html, /\{\{topic\}\}/);
  assert.match(html, /Add to conversation/);
  assert.match(html, />Archive</);
  assert.match(html, /Archived <span>0<\/span>/);
  assert.match(html, /Import from n8n…/);
  assert.match(html, /Open prompt editor in focus mode/);
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
    },
    diagnostics: [],
    runOverrides: { topic: "temporary\nsecond line" },
    importedFrom: {
      id: "external-import_question",
      source: {
        adapter: "synthetic-fixture",
        resource: { kind: "workflow", id: "workflow-1" },
        execution: { id: "execution-23" },
      },
      invocation: {
        id: "node-1",
        name: "Fixture prompt",
        type: "fixture.prompt",
      },
      authored: [],
      bindings: [],
      importedAt: "2026-07-26T12:00:00.000Z",
      importerVersion: 1,
      sourceDigest: "a".repeat(64),
      fidelity: "authored-only",
      warnings: [],
      projection: { kind: "literal-messages" },
    },
    onSaveValues: () => {},
    onSaveRunValue: () => {},
    onRunOverridesChange: () => {},
    onUpdateLatest: () => {},
    onDetach: () => {},
    onRemove: () => {},
  });

  assert.match(html, /Value for run/);
  assert.match(
    html,
    /Imported from synthetic-fixture · execution execution-23/,
  );
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

test("keeps run-value textareas distinct from the composer surface", async () => {
  const stylesheet = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    stylesheet,
    /\.template-run-value-editor textarea\s*\{[^}]*border:\s*1px solid var\(--border-strong\);[^}]*background:\s*var\(--surface-inset\);[^}]*box-shadow:\s*var\(--shadow-field-inset\);/s,
  );
  assert.match(
    stylesheet,
    /\.template-run-value-editor textarea:focus\s*\{[^}]*border-color:\s*var\(--accent-focus\);[^}]*background:\s*var\(--surface-panel\);[^}]*box-shadow:\s*var\(--focus-ring\), var\(--shadow-field-inset\);/s,
  );
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
        messages: [{ role: "user", content: "New {{topic}}" }],
        variableDefaults: { topic: "new" },
      },
    ],
  };
  const html = await render("ProjectTemplatesPane", {
    templates: [olderCurrent],
    usageCounts: new Map(),
    itemCount: 0,
    n8nImportDisabledReason: "Finish the current run.",
    onOpenN8nImport: () => {},
    onCreate: () => "template_new",
    onSave: () => "template-revision_question-1",
    onRename: () => true,
    onArchive: () => {},
    onRestore: () => {},
    onInsert: () => {},
  });

  assert.doesNotMatch(html, /Previous 0/);
  assert.match(html, /Revision 2/);
  assert.match(
    html,
    /disabled="" title="Finish the current run."[^>]*>Import from n8n…/,
  );
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
