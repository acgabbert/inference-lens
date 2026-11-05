import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ProjectFile } from "../packages/core/src/project.ts";
import type { EvaluationSuite } from "../packages/core/src/evaluation-suites.ts";
import { addEvaluationCase, createEvaluationSuite, removeEvaluationSuite, renameEvaluationSuite } from "../packages/core/src/evaluation-suite-authoring.ts";
import { createRevisionFromSavedPrompt, updateEvaluationSuiteInput } from "../packages/core/src/evaluation-suite-authoring.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { routeSuiteMutation, withSuiteDrafts } from "../app/evaluations/suite-drafts.ts";

// Slice 2c-1 (C1, C2): owners mutate the project they are shown, which
// carries the user's suite drafts. A change to a saved suite goes to its
// draft; creating or deleting a suite, and anything outside suites, stays a
// direct shared write.

const shared: ProjectFile = planSharedProjectMigration(
  readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)),
).shared;
const chat = shared.evaluationSuites.find(({ id }) => id === "evaluation-suite_chat")!;
const decision = shared.evaluationSuites.find(({ id }) => id === "evaluation-suite_decision")!;
const drafted = { ...chat, name: "Drafted" } as EvaluationSuite;

test("the view shows each suite's draft in place of the saved suite", () => {
  const view = withSuiteDrafts(shared, (id) => id === chat.id ? drafted : undefined);
  assert.deepEqual(view.evaluationSuites.map(({ name }) => name), ["Drafted", decision.name]);
  assert.equal(withSuiteDrafts(shared, () => undefined), shared);
});

test("editing a saved suite goes to its draft and writes nothing shared", () => {
  const view = withSuiteDrafts(shared, (id) => id === chat.id ? drafted : undefined);
  const next = addEvaluationCase(view, chat.id).project;
  const route = routeSuiteMutation(shared, view, next);
  assert.equal(route.shared, undefined);
  assert.deepEqual(route.removed, []);
  assert.equal(route.drafts.length, 1);
  // The base is the saved suite, and the edit keeps the earlier draft's change.
  assert.deepEqual(route.drafts[0]!.base, chat);
  assert.equal(route.drafts[0]!.edited.name, "Drafted");
  assert.equal(route.drafts[0]!.edited.cases.length, chat.cases.length + 1);
});

test("an untouched suite with a draft is not rewritten by another suite's edit", () => {
  const view = withSuiteDrafts(shared, (id) => id === chat.id ? drafted : undefined);
  const route = routeSuiteMutation(shared, view, renameEvaluationSuite(view, decision.id, "Routing, renamed"));
  assert.deepEqual(route.drafts.map(({ edited }) => edited.id), [decision.id]);
});

test("creating a suite is a direct shared write; the new suite has no draft (C2)", () => {
  const view = withSuiteDrafts(shared, (id) => id === chat.id ? drafted : undefined);
  const created = createEvaluationSuite(view, "Fresh");
  const route = routeSuiteMutation(shared, view, created.project);
  assert.deepEqual(route.drafts, []);
  assert.ok(route.shared);
  // The saved suites stay as saved: the draft does not leak into the shared write.
  assert.deepEqual(route.shared.evaluationSuites.slice(0, 2), shared.evaluationSuites);
  assert.equal(route.shared.evaluationSuites.at(-1)!.id, created.suiteId);
});

test("deleting a suite is a direct shared write and drops its draft (C2)", () => {
  const view = withSuiteDrafts(shared, (id) => id === chat.id ? drafted : undefined);
  const route = routeSuiteMutation(shared, view, removeEvaluationSuite(view, chat.id));
  assert.deepEqual(route.removed, [chat.id]);
  assert.deepEqual(route.drafts, []);
  assert.deepEqual(route.shared?.evaluationSuites.map(({ id }) => id), [decision.id]);
});

test("a new input revision is shared while the suite's pin to it is drafted", () => {
  const template = shared.promptTemplates.find(({ kind }) => kind === "chat")!;
  const created = createRevisionFromSavedPrompt(shared, {
    parentRevisionId: (chat as { input: { conversationRevisionId: ProjectFile["defaults"]["conversationRevisionId"] } }).input.conversationRevisionId,
    templateId: template.id,
  });
  const next = updateEvaluationSuiteInput(created.project, chat.id, created.conversationRevisionId);
  const route = routeSuiteMutation(shared, shared, next);
  assert.ok(route.shared);
  assert.ok(route.shared.conversationRevisions.some(({ id }) => id === created.conversationRevisionId));
  assert.deepEqual(route.shared.evaluationSuites, shared.evaluationSuites);
  assert.equal(route.drafts.length, 1);
  assert.equal((route.drafts[0]!.edited as { input: { conversationRevisionId: string } }).input.conversationRevisionId, created.conversationRevisionId);
});
