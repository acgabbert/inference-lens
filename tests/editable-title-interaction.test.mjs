import assert from "node:assert/strict";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { ssrLoadModule } from "./support/ssr.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, FocusEvent: dom.window.FocusEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
after(() => dom.window.close());

async function mount(props) {
  const [{ createElement, act }, { createRoot }, { EditableTitle }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    ssrLoadModule("/app/editable-title.client.tsx"),
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(EditableTitle, { label: "Case name", ...props })));
  const button = (name) => Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === name,
  );
  return {
    container,
    button,
    input: () => container.querySelector("input"),
    async click(name) {
      const target = button(name);
      assert.ok(target, `no ${name} button`);
      await act(async () => target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    },
    async type(value) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
        const input = container.querySelector("input");
        setter.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    /** React implements onBlur via the bubbling "focusout", not native "blur". */
    async blurAway() {
      await act(async () => container.querySelector("input").dispatchEvent(
        new dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
      ));
    },
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

test("the name reads as a heading until the pencil opens it for editing", async () => {
  const view = await mount({ value: "time dilation", onCommit: () => true });
  try {
    assert.equal(view.container.querySelector("h3").textContent, "time dilation");
    // The field a standing "Case name" input would occupy costs nothing here.
    assert.equal(view.input(), null);

    await view.click("Edit case name");

    assert.equal(view.container.querySelector("h3"), null);
    assert.equal(view.input().value, "time dilation");
  } finally { await view.unmount(); }
});

test("saving commits the draft and returns to the heading", async () => {
  const committed = [];
  const view = await mount({ value: "time dilation", onCommit: (name) => { committed.push(name); return true; } });
  try {
    await view.click("Edit case name");
    await view.type("length contraction");
    await view.click("Save case name");

    assert.deepEqual(committed, ["length contraction"]);
    assert.equal(view.input(), null);
  } finally { await view.unmount(); }
});

test("discarding keeps the saved name and never commits", async () => {
  let commits = 0;
  const view = await mount({ value: "time dilation", onCommit: () => { commits += 1; return true; } });
  try {
    await view.click("Edit case name");
    await view.type("half-typed");
    await view.click("Discard case name change");

    assert.equal(commits, 0);
    assert.equal(view.container.querySelector("h3").textContent, "time dilation");
  } finally { await view.unmount(); }
});

/**
 * The behaviour the standing field could not offer: a rejected name is the one
 * the author still has to fix, so it survives the rejection. The old case field
 * overwrote it with the saved name on blur and the typing was gone.
 */
test("a rejected name stays in the open editor and marks the field invalid", async () => {
  const view = await mount({ value: "time dilation", onCommit: () => false });
  try {
    await view.click("Edit case name");
    await view.type("   ");
    await view.click("Save case name");

    assert.equal(view.input().value, "   ");
    assert.equal(view.input().getAttribute("aria-invalid"), "true");
  } finally { await view.unmount(); }
});

test("leaving the field commits, but an unchanged name is not a mutation", async () => {
  const committed = [];
  const view = await mount({ value: "time dilation", onCommit: (name) => { committed.push(name); return true; } });
  try {
    await view.click("Edit case name");
    await view.blurAway();
    // Nothing was typed, so there is nothing to validate and nothing to save.
    assert.deepEqual(committed, []);
    assert.equal(view.input(), null);

    await view.click("Edit case name");
    await view.type("length contraction");
    await view.blurAway();
    assert.deepEqual(committed, ["length contraction"]);
  } finally { await view.unmount(); }
});

test("a read-only title offers no way in", async () => {
  const view = await mount({ value: "time dilation", readOnly: true, onCommit: () => true });
  try {
    assert.equal(view.button("Edit case name"), undefined);
    assert.equal(view.container.querySelector("h3").textContent, "time dilation");
  } finally { await view.unmount(); }
});
