import assert from "node:assert/strict";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { ssrLoadModule } from "./support/ssr.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
after(() => dom.window.close());

test("evaluating a decision prompt creates a decision suite without replacing Compose's request", async () => {
  const [{ createElement, act, useState }, { createRoot }, { useEvaluationSuiteAuthoring }, { decisionProject }, { createDecisionPromptTemplate }] = await Promise.all([
    import("react"), import("react-dom/client"), ssrLoadModule("/app/evaluations/use-evaluation-suite-authoring.client.ts"),
    ssrLoadModule("/tests/fixtures/decision-evaluation.ts"), ssrLoadModule("/packages/core/src/decision-template.ts"),
  ]);
  const original = { ...decisionProject(), evaluationSuites: [] };
  const project = createDecisionPromptTemplate(original, { name: "Reusable", decision: { state: "{{ticket}}", questions: { ok: { type: "noul", instructions: "OK?" } } }, idSuffix: "reusable", revisionIdSuffix: "reusable" });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let handle;
  function Harness() {
    const [current, adoptProjectMutation] = useState(project);
    handle = useEvaluationSuiteAuthoring({ project: current, adoptProjectMutation });
    return null;
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    let accepted;
    await act(async () => { accepted = handle.evaluatePromptRevision("template_reusable", "template-revision_reusable"); });
    assert.equal(accepted, true, handle.savedPromptError);
    const suite = handle.project.evaluationSuites.find(({ id }) => id === handle.suiteId);
    assert.equal(suite.input.kind, "decision-request-revision");
    const pin = handle.project.decisionRequestRevisions.find(({ id }) => id === suite.input.decisionRequestRevisionId);
    assert.equal(pin.kind, "template-use");
    assert.equal(pin.templateRevisionId, "template-revision_reusable");
    assert.deepEqual(handle.project.defaults, original.defaults);
    assert.deepEqual(handle.project.conversationRevisions, original.conversationRevisions);
    assert.deepEqual(handle.project.decisionRequestRevisions.slice(0, -1), original.decisionRequestRevisions);
    assert.deepEqual(handle.savedPromptCandidates, []);
    const beforeRejected = handle.project;
    await act(async () => { accepted = handle.evaluatePromptRevision("template_reusable", "template-revision_reusable", "evaluation-suite_missing"); });
    assert.equal(accepted, false);
    assert.match(handle.savedPromptError, /no longer exists/);
    assert.equal(handle.project, beforeRejected);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("the retarget dialog includes the revision diff disclosure in its keyboard focus cycle", async () => {
  const [{ createElement, act }, { createRoot }, { DecisionPromptEvaluationDialog }] = await Promise.all([
    import("react"), import("react-dom/client"), ssrLoadModule("/app/templates/decision-prompt-evaluation-dialog.client.tsx"),
  ]);
  const decision = { state: "Before", questions: { ok: { type: "noul", instructions: "OK?" } } };
  const template = { id: "template_focus", name: "Focus", kind: "decision", currentRevisionId: "template-revision_two", revisions: [
    { id: "template-revision_one", createdAt: "2026-10-25T12:00:00Z", decision, variableDefaults: {} },
    { id: "template-revision_two", createdAt: "2026-10-25T13:00:00Z", decision: { ...decision, state: "After" }, variableDefaults: {} },
  ] };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const button = (text) => [...container.querySelectorAll("button")].find((node) => node.textContent === text);
  try {
    await act(async () => root.render(createElement(DecisionPromptEvaluationDialog, { template, revisionId: "template-revision_two", onClose() {},
      evaluationSuites: [{ suite: { id: "evaluation-suite_focus", name: "Focus suite" }, pinnedRevisionId: "template-revision_one" }],
      onPreviewEvaluation: () => ({ changes: [], diagnostics: [], existingDiagnostics: [] }),
    })));
    await act(async () => button("Review Focus suite…").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    // JSDOM does not implement summary's native focusability. Observe the
    // requested focus target here; the browser spec checks actual focus.
    let disclosureFocused = false;
    container.querySelector("summary").focus = () => { disclosureFocused = true; };
    button("Retarget suite").focus();
    assert.equal(document.activeElement?.textContent, "Retarget suite");
    await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    assert.equal(disclosureFocused, true, "the first focusable control is Revision changes, before Cancel");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("multiple evaluations of the same prompt retain distinct request choices", async () => {
  const [{ createElement, act }, { createRoot }, { useDecisionSuiteSettings }, { DecisionSuiteSetup }, { decisionProject }, { createDecisionPromptTemplate }, { createDecisionTemplateEvaluation }] = await Promise.all([
    import("react"), import("react-dom/client"), ssrLoadModule("/app/evaluations/use-decision-suite-settings.client.ts"), ssrLoadModule("/app/evaluations/decision-suite-setup.client.tsx"),
    ssrLoadModule("/tests/fixtures/decision-evaluation.ts"), ssrLoadModule("/packages/core/src/decision-template.ts"), ssrLoadModule("/packages/core/src/decision-template-evaluation.ts"),
  ]);
  const source = createDecisionPromptTemplate({ ...decisionProject(), evaluationSuites: [] }, { name: "Repeated prompt", decision: { state: "Ticket", questions: { ok: { type: "noul", instructions: "OK?" } } }, idSuffix: "repeat", revisionIdSuffix: "repeat" });
  const first = createDecisionTemplateEvaluation(source, { templateId: "template_repeat", templateRevisionId: "template-revision_repeat" });
  const second = createDecisionTemplateEvaluation(first.project, { templateId: "template_repeat", templateRevisionId: "template-revision_repeat" });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  function Harness() {
    const settings = useDecisionSuiteSettings({ project: second.project, suiteId: second.suiteId, adoptProjectMutation() {} });
    return createElement(DecisionSuiteSetup, { open: true, className: "setup", project: second.project, settings, authoring: { selectedVariantIds: new Set() } });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.equal(container.querySelectorAll('optgroup[label="Repeated prompt"]').length, 2);
    assert.equal(errors.filter((message) => message.includes("same key")).length, 0, errors.join("\n"));
  } finally { console.error = originalError; await act(async () => root.unmount()); container.remove(); }
});

test("the retarget dialog keeps focus where the user put it when its owner re-renders", async () => {
  const [{ createElement, act }, { createRoot }, { DecisionPromptEvaluationDialog }] = await Promise.all([
    import("react"), import("react-dom/client"), ssrLoadModule("/app/templates/decision-prompt-evaluation-dialog.client.tsx"),
  ]);
  const decision = { state: "Before", questions: { ok: { type: "noul", instructions: "OK?" } } };
  const template = { id: "template_refocus", name: "Refocus", kind: "decision", currentRevisionId: "template-revision_two", revisions: [
    { id: "template-revision_one", createdAt: "2026-10-25T12:00:00Z", decision, variableDefaults: {} },
    { id: "template-revision_two", createdAt: "2026-10-25T13:00:00Z", decision: { ...decision, state: "After" }, variableDefaults: {} },
  ] };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const button = (text) => [...container.querySelectorAll("button")].find((node) => node.textContent === text);
  // Owners pass a fresh onClose each render, as DecisionTemplateContent does.
  const render = (evaluateRevisionError) => root.render(createElement(DecisionPromptEvaluationDialog, { template, revisionId: "template-revision_two", onClose: () => {},
    evaluationSuites: [{ suite: { id: "evaluation-suite_refocus", name: "Refocus suite" }, pinnedRevisionId: "template-revision_one" }],
    onPreviewEvaluation: () => ({ changes: [], diagnostics: [], existingDiagnostics: [] }),
    onEvaluateRevision: () => false, evaluateRevisionError,
  }));
  try {
    await act(async () => render(undefined));
    await act(async () => button("Review Refocus suite…").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(document.activeElement?.textContent, "Cancel", "opening the review focuses Cancel");
    button("Retarget suite").focus();
    await act(async () => render("The suite could not be retargeted."));
    assert.ok(container.querySelector('[role="alert"]'), "the failure is shown");
    assert.equal(document.activeElement?.textContent, "Retarget suite");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
