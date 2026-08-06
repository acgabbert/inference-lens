import assert from "node:assert/strict";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { ssrLoadModule } from "./support/ssr.mjs";
import { evaluationFixture } from "./fixtures/evaluation-suite-authoring.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
after(() => dom.window.close());

/**
 * Collapsing the setup band is what buys the cases their height, so nothing a
 * start depends on may be hidden with it: the preflight state, the planned run
 * count, the blocker text, and the primary action all live in the suite header
 * and stay put. That invariant is the reason the band is allowed to shut at all.
 */
test("shutting the setup band hides its controls and keeps every fact a start depends on", async () => {
  const [{ createElement, act }, { createRoot }, { EvaluationSuiteEditor }] = await Promise.all([import("react"), import("react-dom/client"), ssrLoadModule("/app/evaluations/evaluation-suite-editor.client.tsx")]);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    const authoring = evaluationFixture();
    authoring.diagnostics = [{ code: "missing-template-variable", message: "Selected revision no longer has topic." }];
    await act(async () => root.render(createElement(EvaluationSuiteEditor, {
      authoring,
      execution: { storage: "durable", running: false, onStart() {} },
    })));

    const toggle = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.startsWith("Setup"),
    );
    assert.ok(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.ok(container.querySelector(".evaluation-setup"));

    await act(async () => toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));

    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector(".evaluation-setup"), null);
    // Shut, the band still names what it is holding.
    assert.match(toggle.textContent, /Buffered fixture · buffered-test-model/);

    const header = container.querySelector(".evaluation-preflight").parentElement;
    assert.match(header.textContent, /1 setup issue/);
    assert.match(header.textContent, /Selected revision no longer has topic/);
    assert.match(header.textContent, /1 case × 1 configuration × 3 reps/);
    assert.match(header.textContent, /3 runs/);
    // The Start button is the topbar's. What the band owes it is the reason,
    // in visible text, with an id the disabled button can point at.
    assert.equal(header.querySelector("#evaluation-preflight-summary").textContent,
      "Selected revision no longer has topic.");

    // The case list and the case editor are unaffected by the band either way.
    assert.ok(container.querySelector(".evaluation-case-rail"));
    assert.ok(container.querySelector(".evaluation-case-detail"));
  } finally { await act(async () => root.unmount()); container.remove(); }
});

/**
 * The prompt library is in the Compose mode now, so the editor cannot select a
 * tab to reach it. It closes its picker and reports the navigation upward; the
 * route is what crosses the mode boundary.
 */
test("an empty saved-prompt picker closes and asks its owner for the prompt library", async () => {
  const [{ createElement, act }, { createRoot }, { EvaluationSuiteEditor }] = await Promise.all([import("react"), import("react-dom/client"), ssrLoadModule("/app/evaluations/evaluation-suite-editor.client.tsx")]);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let pickerClosed = false;
  let templatesRequested = 0;
  try {
    const authoring = evaluationFixture();
    authoring.savedPromptCandidates = [];
    authoring.savedPromptPickerOpen = true;
    authoring.closeSavedPromptPicker = () => { pickerClosed = true; };
    await act(async () => root.render(createElement(EvaluationSuiteEditor, {
      authoring,
      onOpenTemplates: () => { templatesRequested += 1; },
    })));
    const openTemplates = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Open Prompts",
    );
    assert.ok(openTemplates);
    await act(async () => openTemplates.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(pickerClosed, true);
    assert.equal(templatesRequested, 1);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
