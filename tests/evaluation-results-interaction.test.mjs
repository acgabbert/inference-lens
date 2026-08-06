import assert from "node:assert/strict";
import test, { after } from "node:test";

import { JSDOM } from "jsdom";
import { ssrLoadModule } from "./support/ssr.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
after(() => dom.window.close());

async function fixture(variantCount) {
  const [projectCore, executionCore, experimentCore, kernel, types, component] = await Promise.all([
    ssrLoadModule("/packages/core/src/project.ts"),
    ssrLoadModule("/packages/core/src/evaluation-execution.ts"),
    ssrLoadModule("/packages/core/src/experiment.ts"),
    ssrLoadModule("/packages/core/src/run-kernel/index.ts"),
    ssrLoadModule("/packages/core/src/types.ts"),
    ssrLoadModule("/app/evaluations/evaluation-results-workspace.client.tsx"),
  ]);
  const initial = projectCore.createProjectFile({
    name: "Comparison drawer", idSuffix: `drawer-${variantCount}`,
    request: { provider: "openai-compatible", endpoint: "https://provider.example.test/v1", model: "base-model", messages: [{ role: "user", content: "Explain migrations." }] },
  });
  const variants = ["First", "Second", "Third"].slice(0, variantCount).map((name, index) => ({
    id: `evaluation-variant_${name.toLowerCase()}`,
    name,
    overrides: { target: { model: `${name.toLowerCase()}-model` } },
  }));
  const project = projectCore.parseProjectFile({
    ...initial,
    evaluationSuites: [{
      id: "evaluation-suite_drawer", name: "Drawer suite",
      input: { kind: "conversation-revision", conversationRevisionId: initial.defaults.conversationRevisionId },
      execution: { target: initial.defaults.target, responseMode: "buffered", options: {}, repetitions: 1, toolIds: [] },
      variants,
      inputBindings: [],
      cases: [{ id: "evaluation-case_migrations", name: "Migrations", values: {}, checks: [{ checkId: "check_migration", kind: "contains", value: "migration" }] }],
    }],
  });
  let suffix = 0;
  const runtimeTargets = Object.fromEntries(variants.map((variant) => [variant.id, {
    profileId: `profile_${variant.name.toLowerCase()}`,
    protocol: "openai-compatible-chat-completions",
    endpoint: `https://${variant.name.toLowerCase()}.example.test/v1`,
    capabilities: types.OPENAI_COMPATIBLE_CAPABILITIES,
  }]));
  const plan = executionCore.createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_drawer",
    selectedCaseIds: ["evaluation-case_migrations"],
    selectedVariantIds: variants.map(({ id }) => id),
    runtimeTargets,
    createSuffix: () => `drawer-${variantCount}-${++suffix}`,
  });
  const states = new Map();
  const traces = new Map();
  for (const cell of plan.cells) {
    const input = experimentCore.materializeExperimentCellInput(plan, cell.cellId);
    const coordinator = new kernel.RunCoordinator(input);
    const { execution } = coordinator.start();
    const name = plan.suite.variants.find(({ variantId }) => variantId === cell.variantId).name;
    coordinator.accept({ type: "text_delta", text: `${name} migration output`, source: { exchangeId: execution.exchangeId } });
    coordinator.accept({ type: "completed", finishReason: { normalized: "stop" }, source: { exchangeId: execution.exchangeId } });
    coordinator.finishTurnStream();
    states.set(cell.runId, coordinator.state);
    traces.set(cell.runId, { runId: cell.runId });
  }
  return {
    component,
    execution: {
      plan,
      result: { schemaVersion: 4, experimentId: plan.experimentId, status: "completed", endedAt: "2026-08-06T12:00:00.000Z", cells: plan.cells.map((cell) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed" })) },
      storage: "durable", workspace: null, states, traces, traceFileNames: new Map(), unreadableTraces: new Map(), selectedRunId: null,
    },
  };
}

async function renderFixture(variantCount) {
  const [{ createElement }, { createRoot }, { act }, fx] = await Promise.all([
    import("react"), import("react-dom/client"), import("react"), fixture(variantCount),
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(fx.component.EvaluationResultsWorkspace, {
    execution: fx.execution, onStop() {}, onOpenTrace() {},
  })));
  return { container, root, act };
}

function button(container, text) {
  return [...container.querySelectorAll("button")].find((candidate) => candidate.textContent.includes(text));
}

test("two configurations open an automatic pair without selectors", async () => {
  const { container, root, act } = await renderFixture(2);
  try {
    assert.equal(container.querySelectorAll(".evaluation-configuration-table tbody tr").length, 2);
    await act(async () => button(container, "Compare output").click());
    const drawer = container.querySelector('[role="dialog"]');
    assert.ok(drawer);
    assert.equal(drawer.querySelectorAll("select").length, 0);
    assert.match(drawer.textContent, /First.*Second/s);
    assert.match(drawer.textContent, /First migration output/);
    assert.match(drawer.textContent, /Second migration output/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("three configurations preserve active/next order and allow both sides to change", async () => {
  const { container, root, act } = await renderFixture(3);
  try {
    const third = button(container, "Thirdthird-model");
    assert.ok(third);
    await act(async () => third.click());
    assert.match(third.closest("tr").className, /selected/);
    await act(async () => button(container, "Compare output").click());
    const drawer = container.querySelector('[role="dialog"]');
    const selects = drawer.querySelectorAll("select");
    assert.equal(selects.length, 2);
    assert.equal(selects[0].value, "evaluation-variant_third");
    assert.equal(selects[1].value, "evaluation-variant_first");

    await act(async () => {
      selects[0].value = "evaluation-variant_second";
      selects[0].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.match(drawer.querySelector('[aria-label="left configuration"]').textContent, /Second/);
    const currentSelects = drawer.querySelectorAll("select");
    await act(async () => {
      currentSelects[1].value = "evaluation-variant_third";
      currentSelects[1].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.match(drawer.querySelector('[aria-label="right configuration"]').textContent, /Third/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
