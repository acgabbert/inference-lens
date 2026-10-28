import assert from "node:assert/strict";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { ssrLoadModule } from "./support/ssr.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
after(() => dom.window.close());

const recommend = (model, connectionRequirementId = "connection_local") => ({ connectionRequirementId, model });

/** Renders the hook with props the test can replace, exposing its latest handle. */
async function mount(initial) {
  const [{ createElement, act }, { createRoot }, { usePromptModelWarnings }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    ssrLoadModule("/app/templates/use-prompt-model-warnings.client.ts"),
  ]);
  let handle;
  function Harness({ scope, comparisons }) {
    handle = usePromptModelWarnings(scope, comparisons);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let props = initial;
  await act(async () => root.render(createElement(Harness, props)));
  return {
    isDismissed: (id) => handle.isDismissed(id),
    async dismiss(id) { await act(async () => handle.dismiss(id)); },
    async update(next) {
      props = { ...props, ...next };
      await act(async () => root.render(createElement(Harness, props)));
    },
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

const twoUses = (selectedModel, firstModel = "triage-model", secondModel = "triage-model") => [
  { id: "use_first", recommendation: recommend(firstModel), selectedModel },
  { id: "use_second", recommendation: recommend(secondModel), selectedModel },
];

test("a dismissal belongs to one use and survives an unchanged re-render", async () => {
  const view = await mount({ scope: "project_a", comparisons: twoUses("buffered-test-model") });
  try {
    await view.dismiss("use_first");
    assert.equal(view.isDismissed("use_first"), true);
    assert.equal(view.isDismissed("use_second"), false);

    // A fresh but equal comparison array is what every parent render passes.
    await view.update({ comparisons: twoUses("buffered-test-model") });
    assert.equal(view.isDismissed("use_first"), true);
  } finally { await view.unmount(); }
});

test("changing the selected model away and back restores the advice", async () => {
  const view = await mount({ scope: "project_a", comparisons: twoUses("buffered-test-model") });
  try {
    await view.dismiss("use_first");
    await view.update({ comparisons: twoUses("another-model") });
    assert.equal(view.isDismissed("use_first"), false);

    await view.update({ comparisons: twoUses("buffered-test-model") });
    assert.equal(view.isDismissed("use_first"), false);
  } finally { await view.unmount(); }
});

test("whitespace around either model is not a new comparison", async () => {
  const view = await mount({ scope: "project_a", comparisons: twoUses("buffered-test-model") });
  try {
    await view.dismiss("use_first");
    await view.update({ comparisons: twoUses(" buffered-test-model ", "triage-model ") });
    assert.equal(view.isDismissed("use_first"), true);
  } finally { await view.unmount(); }
});

test("a recommendation edit expires only that use's dismissal", async () => {
  const view = await mount({ scope: "project_a", comparisons: twoUses("buffered-test-model") });
  try {
    await view.dismiss("use_first");
    await view.dismiss("use_second");
    await view.update({ comparisons: twoUses("buffered-test-model", "revised-model") });
    assert.equal(view.isDismissed("use_first"), false);
    assert.equal(view.isDismissed("use_second"), true);
  } finally { await view.unmount(); }
});

test("a recommendation moving to another connection expires the dismissal", async () => {
  const view = await mount({ scope: "project_a", comparisons: twoUses("buffered-test-model") });
  try {
    await view.dismiss("use_first");
    await view.update({ comparisons: [
      { id: "use_first", recommendation: recommend("triage-model", "connection_other"), selectedModel: "buffered-test-model" },
      twoUses("buffered-test-model")[1],
    ] });
    assert.equal(view.isDismissed("use_first"), false);
  } finally { await view.unmount(); }
});

test("removing a use forgets its dismissal even if the same id returns", async () => {
  const view = await mount({ scope: "project_a", comparisons: twoUses("buffered-test-model") });
  try {
    await view.dismiss("use_first");
    await view.update({ comparisons: twoUses("buffered-test-model").slice(1) });
    await view.update({ comparisons: twoUses("buffered-test-model") });
    assert.equal(view.isDismissed("use_first"), false);
  } finally { await view.unmount(); }
});

test("changing projects forgets every dismissal", async () => {
  const view = await mount({ scope: "project_a", comparisons: twoUses("buffered-test-model") });
  try {
    await view.dismiss("use_first");
    await view.update({ scope: "project_b" });
    assert.equal(view.isDismissed("use_first"), false);
  } finally { await view.unmount(); }
});
