import assert from "node:assert/strict";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { ssrLoadModule } from "./support/ssr.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
after(() => dom.window.close());

test("task runner yields before work, between steps, and stops before resuming cancelled work", async () => {
  const { runScheduledDerivation } = await ssrLoadModule("/app/evaluations/use-scheduled-derivation.client.ts");
  const order = [];
  function* work() {
    try {
      order.push("first"); yield;
      order.push("second"); yield;
      return "complete";
    } finally { order.push("released"); }
  }
  const result = await runScheduledDerivation(work(), new AbortController().signal, async () => { order.push("pause"); }, { budgetMs: 0 });
  assert.equal(result, "complete");
  assert.deepEqual(order, ["pause", "first", "pause", "second", "pause", "released"]);
  order.length = 0;
  const controller = new AbortController();
  const cancelled = await runScheduledDerivation(work(), controller.signal, async () => {
    if (order.includes("first")) controller.abort();
  }, { budgetMs: 0 });
  assert.equal(cancelled, undefined);
  assert.deepEqual(order, ["first", "released"]);
});

test("task runner continues steps within one time slice and yields once the budget is spent", async () => {
  const { runScheduledDerivation } = await ssrLoadModule("/app/evaluations/use-scheduled-derivation.client.ts");
  let clock = 0;
  const order = [];
  function* work(costMs) {
    for (const step of ["s1", "s2", "s3", "s4"]) {
      order.push(step); clock += costMs; yield;
    }
    return "complete";
  }
  const pause = async () => { order.push("pause"); };
  const slice = { budgetMs: 8, now: () => clock };
  assert.equal(await runScheduledDerivation(work(5), new AbortController().signal, pause, slice), "complete");
  assert.deepEqual(order, ["pause", "s1", "s2", "pause", "s3", "s4", "pause"]);
  order.length = 0;
  assert.equal(await runScheduledDerivation(work(0), new AbortController().signal, pause, slice), "complete");
  assert.deepEqual(order, ["pause", "s1", "s2", "s3", "s4"], "cheap steps share one task");
});

test("hook hides stale values, survives StrictMode replay, cancels superseded work, and reports errors", async () => {
  const [{ useScheduledDerivation }, { createElement, StrictMode, act }, { createRoot }] = await Promise.all([
    ssrLoadModule("/app/evaluations/use-scheduled-derivation.client.ts"), import("react"), import("react-dom/client"),
  ]);
  const previousScheduler = globalThis.scheduler;
  const pauses = [];
  globalThis.scheduler = { yield: () => new Promise((resolve) => pauses.push(resolve)) };
  const container = document.createElement("div");
  const root = createRoot(container);
  const visited = [];
  function Probe({ factory }) {
    const { value, pending, error } = useScheduledDerivation(factory, { budgetMs: 0 });
    return createElement("p", {}, pending ? "loading" : error ? error.message : value);
  }
  function factory(name) {
    return function* () {
      visited.push(`${name}:first`); yield;
      visited.push(`${name}:second`); yield;
      return name;
    };
  }
  const render = async (factory) => act(async () => root.render(createElement(StrictMode, {}, createElement(Probe, { factory }))));
  const advance = async () => act(async () => { pauses.splice(0).forEach((resolve) => resolve()); });
  try {
    await render(factory("old"));
    assert.equal(container.textContent, "loading");
    await advance();
    assert.deepEqual(visited, ["old:first"], "StrictMode must abandon the first job without advancing it");
    await render(factory("new"));
    assert.equal(container.textContent, "loading");
    await advance(); await advance();
    assert.equal(container.textContent, "loading", "no partial result may be published");
    await advance();
    assert.equal(container.textContent, "new");
    assert.ok(!visited.includes("old:second"));
    await render(factory("latest"));
    assert.equal(container.textContent, "loading", "a completed old value must disappear immediately");
    await advance(); await advance(); await advance();
    assert.equal(container.textContent, "latest");
    await render(function* () { throw new Error("derivation failed"); });
    await advance();
    assert.equal(container.textContent, "derivation failed");
  } finally {
    await act(async () => root.unmount());
    pauses.splice(0).forEach((resolve) => resolve());
    globalThis.scheduler = previousScheduler;
    container.remove();
  }
});

test("hook keeps the completed value visible while recomputing under the same retain key", async () => {
  const [{ useScheduledDerivation }, { createElement, act }, { createRoot }] = await Promise.all([
    ssrLoadModule("/app/evaluations/use-scheduled-derivation.client.ts"), import("react"), import("react-dom/client"),
  ]);
  const previousScheduler = globalThis.scheduler;
  const pauses = [];
  globalThis.scheduler = { yield: () => new Promise((resolve) => pauses.push(resolve)) };
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe({ factory, retainKey }) {
    const { value, pending } = useScheduledDerivation(factory, { retainKey, budgetMs: 0 });
    return createElement("p", {}, `${value ?? "none"}|${pending ? "pending" : "settled"}`);
  }
  const factory = (name) => function* () { yield; return name; };
  const render = async (factory, retainKey) => act(async () => root.render(createElement(Probe, { factory, retainKey })));
  const advance = async () => act(async () => { pauses.splice(0).forEach((resolve) => resolve()); });
  const live = { reading: "as-run" };
  try {
    await render(factory("first states"), live);
    await advance(); await advance();
    assert.equal(container.textContent, "first states|settled");
    await render(factory("next states"), live);
    assert.equal(container.textContent, "first states|pending", "same reading keeps its last complete value");
    await advance(); await advance();
    assert.equal(container.textContent, "next states|settled");
    await render(factory("other reading"), { reading: "corrected" });
    assert.equal(container.textContent, "none|pending", "a different reading never shows the old value");
    await advance(); await advance();
    await render(factory("unkeyed"), undefined);
    assert.equal(container.textContent, "none|pending", "without a key nothing is retained");
  } finally {
    await act(async () => root.unmount());
    pauses.splice(0).forEach((resolve) => resolve());
    globalThis.scheduler = previousScheduler;
    container.remove();
  }
});
