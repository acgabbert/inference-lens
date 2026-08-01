import assert from "node:assert/strict";
import test, { after } from "node:test";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { evaluationFixture } from "./fixtures/evaluation-suite-authoring.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
after(() => dom.window.close());

test("evaluation focus mode opens, traps the surface, and closes with Escape", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], server: { middlewareMode: true, hmr: false }, logLevel: "warn" });
  const [{ createElement, act }, { createRoot }, { EvaluationSuiteEditor }] = await Promise.all([import("react"), import("react-dom/client"), server.ssrLoadModule("/app/evaluations/evaluation-suite-editor.client.tsx")]);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(EvaluationSuiteEditor, { authoring: evaluationFixture() })));
    const expand = container.querySelector('[aria-label="Open evaluation editor in focus mode"]');
    assert.ok(expand);
    await act(async () => expand.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
    const dialog = container.querySelector('[role="dialog"][aria-label="Evaluation editor focus mode"]');
    assert.ok(dialog);
    assert.equal(document.body.style.overflow, "hidden");
    await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(document.body.style.overflow, "");
  } finally { await act(async () => root.unmount()); container.remove(); await server.close(); }
});
