import assert from "node:assert/strict";
import test, { after } from "node:test";

import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});

after(() => dom.window.close());

// An n8n import of this shape is what the card has to stay navigable under: a
// long system prompt plus more variables than fit on a screen, only a few of
// which still need attention.
const satisfied = [
  "customer_name",
  "customer_tier",
  "order_id",
  "order_status",
  "shipping_region",
  "locale",
  "tone",
  "escalation_path",
  "support_hours",
  "brand_voice",
];
const missing = ["ticket_summary", "agent_notes", "resolution_target"];
const variableNames = [...satisfied, ...missing];

const template = {
  id: "template_support",
  name: "Support triage",
  currentRevisionId: "template-revision_support-1",
  revisions: [
    {
      id: "template-revision_support-1",
      createdAt: "2026-07-31T12:00:00.000Z",
      messages: [
          {
            role: "system",
            content: `You are a support agent.\n${variableNames
              .map((name) => `${name}: {{${name}}}`)
              .join("\n")}`,
          },
          { role: "user", content: "Handle {{ticket_summary}}." },
        ],
      variableDefaults: Object.fromEntries(
        satisfied.map((name) => [name, `default ${name}`]),
      ),
    },
  ],
};

const diagnostics = missing.map((name) => ({
  itemIndex: 0,
  templateUseId: "template-use_support",
  diagnostic: {
    code: "missing-template-variable",
    name,
    occurrences: [],
    message: `Template variable "${name}" has no value.`,
  },
}));

function cardProps(overrides = {}) {
  const noop = () => {};
  return {
    template,
    use: {
      id: "template-use_support",
      templateId: template.id,
      templateRevisionId: template.currentRevisionId,
      values: {},
      outputMessageIds: ["message_support"],
    },
    diagnostics,
    runOverrides: {},
    onSaveValues: noop,
    onSaveRunValue: noop,
    onRunOverridesChange: noop,
    onUpdateLatest: noop,
    onDetach: noop,
    onRemove: noop,
    ...overrides,
  };
}

async function mount(props, component = "TemplateUseCard") {
  let currentProps = props;
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  const [{ createElement, act }, { createRoot }, module] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    server.ssrLoadModule("/app/project-templates-pane.client.tsx"),
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const element = () => createElement(module[component], currentProps);
  await act(async () => root.render(element()));
  return {
    container,
    rows: () => [...container.querySelectorAll(".template-use-variable")],
    row(name) {
      return container
        .querySelector(`textarea[data-template-variable="${name}"]`)
        ?.closest("details");
    },
    async click(element) {
      await act(async () => {
        element.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
    },
    async type(input, value) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    async act(work) {
      await act(work);
    },
    async rerender() {
      await act(async () => root.render(element()));
    },
    async rerenderWith(nextProps) {
      currentProps = nextProps;
      await act(async () => root.render(element()));
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
      await server.close();
    },
  };
}

function libraryProps(templates, overrides = {}) {
  const noop = () => {};
  return {
    templates,
    connectionRequirements: [],
    usageCounts: new Map([[template.id, 2]]),
    itemCount: 1,
    onOpenN8nImport: noop,
    onCreate: () => "template_new",
    onSave: () => template.currentRevisionId,
    onArchive: noop,
    onRestore: noop,
    onInsert: noop,
    ...overrides,
  };
}

test("archiving stays on the Active tab; Archived remains reachable without exposing insertion", async () => {
  let finishArchive;
  let restoredId;
  const view = await mount(
    libraryProps([template], {
      onArchive(templateId, onArchived) {
        assert.equal(templateId, template.id);
        finishArchive = onArchived;
      },
      onRestore(templateId) {
        restoredId = templateId;
      },
    }),
    "ProjectTemplatesPane",
  );
  try {
    const archive = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Archive",
    );
    await view.click(archive);
    assert.equal(typeof finishArchive, "function");

    const archived = { ...template, archivedAt: "2026-07-31T13:00:00.000Z" };
    await view.act(async () => finishArchive());
    await view.rerenderWith(
      libraryProps([archived], {
        onRestore(templateId) {
          restoredId = templateId;
        },
      }),
    );

    // Archiving never auto-drops the author into the Archived view: staying
    // on Active with nothing selected is the honest state when the library
    // had only the one (now archived) template.
    assert.match(view.container.textContent, /Archived 1/);
    assert.ok(
      view.container
        .querySelector(".template-library-tab.selected")
        ?.textContent.startsWith("Active"),
    );
    assert.doesNotMatch(view.container.textContent, /Restore/);
    assert.doesNotMatch(view.container.textContent, /Add to conversation/);

    // Archived stays reachable through its own (quieter) toggle.
    const archivedToggle = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent.trim().startsWith("Archived"),
    );
    await view.click(archivedToggle);
    assert.match(view.container.textContent, /Restore/);

    const restore = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Restore",
    );
    await view.click(restore);
    assert.equal(restoredId, template.id);
    await view.rerenderWith(libraryProps([template]));
    assert.match(view.container.textContent, /Add to conversation/);
  } finally {
    await view.close();
  }
});

test("a large import opens only the variables that still need attention", async () => {
  const view = await mount(cardProps());
  try {
    const summary = view.container.querySelector(".template-values-summary");
    assert.match(summary.textContent, /13 variables/);
    assert.match(summary.textContent, /3 need attention/);

    for (const name of missing) {
      assert.equal(view.row(name).open, true, `${name} should be open`);
    }
    for (const name of satisfied) {
      assert.equal(view.row(name).open, false, `${name} should be collapsed`);
    }

    // A collapsed row still says what its value is and where it came from.
    const collapsed = view.row("locale");
    assert.match(collapsed.textContent, /\{\{locale\}\}/);
    assert.match(collapsed.textContent, /default locale/);
    assert.match(collapsed.textContent, /Template default/);

    // The prompt preview starts clamped rather than filling the card.
    const preview = view.container.querySelector(".template-preview-body");
    assert.ok(preview.classList.contains("clamped"));
  } finally {
    await view.close();
  }
});

test("opening a collapsed row survives the next render", async () => {
  const view = await mount(cardProps());
  try {
    const row = view.row("tone");
    await view.click(row.querySelector("summary"));
    assert.equal(view.row("tone").open, true);

    await view.rerender();
    assert.equal(view.row("tone").open, true);
  } finally {
    await view.close();
  }
});

test("the readiness deep-link can open a row the user collapsed", async () => {
  const view = await mount(cardProps());
  try {
    const row = view.row("agent_notes");
    await view.click(row.querySelector("summary"));
    assert.equal(view.row("agent_notes").open, false);

    // What the request composer does when readiness routes to this field.
    const target = view.container.querySelector(
      'textarea[data-template-variable="agent_notes"]',
    );
    const disclosure = target.closest("details");
    await view.act(
      () =>
        new Promise((resolve) => {
          disclosure.addEventListener("toggle", resolve, { once: true });
          disclosure.open = true;
        }),
    );

    await view.rerender();
    assert.equal(view.row("agent_notes").open, true);
  } finally {
    await view.close();
  }
});

test("filtering hides satisfied variables but never the blocking ones", async () => {
  const view = await mount(cardProps());
  try {
    const filter = view.container.querySelector('input[type="search"]');
    await view.type(filter, "order");

    const visible = view.rows().map((row) =>
      row.querySelector("code").textContent,
    );
    assert.deepEqual(visible, [
      "{{order_id}}",
      "{{order_status}}",
      "{{ticket_summary}}",
      "{{agent_notes}}",
      "{{resolution_target}}",
    ]);
    assert.match(
      view.container.querySelector(".template-values-hidden").textContent,
      /8 variables hidden/,
    );
  } finally {
    await view.close();
  }
});

test("needs-attention only leaves the blocking variables", async () => {
  const view = await mount(cardProps());
  try {
    const toggle = view.container.querySelector(
      '.template-values-attention-toggle input',
    );
    await view.click(toggle);

    assert.deepEqual(
      view.rows().map((row) => row.querySelector("code").textContent),
      missing.map((name) => `{{${name}}}`),
    );
  } finally {
    await view.close();
  }
});

test("a variable that becomes blocking in a newer pinned revision opens", async () => {
  const initialProps = cardProps();
  const view = await mount(initialProps);
  try {
    assert.equal(view.row("locale").open, false);

    const revisedTemplate = {
      ...template,
      currentRevisionId: "template-revision_support-2",
      revisions: [
        ...template.revisions,
        {
          ...template.revisions[0],
          id: "template-revision_support-2",
          variableDefaults: Object.fromEntries(
            satisfied
              .filter((name) => name !== "locale")
              .map((name) => [name, `default ${name}`]),
          ),
        },
      ],
    };
    await view.rerenderWith(cardProps({
      template: revisedTemplate,
      use: {
        ...initialProps.use,
        templateRevisionId: "template-revision_support-2",
      },
      diagnostics: [
        ...diagnostics,
        {
          itemIndex: 0,
          templateUseId: "template-use_support",
          diagnostic: {
            code: "missing-template-variable",
            name: "locale",
            occurrences: [],
            message: 'Template variable "locale" has no value.',
          },
        },
      ],
    }));

    assert.equal(view.row("locale").open, true);
  } finally {
    await view.close();
  }
});
