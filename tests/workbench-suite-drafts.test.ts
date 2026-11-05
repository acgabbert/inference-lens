import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseProjectFile, ProjectValidationError } from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import type { EvaluationSuite } from "../packages/core/src/evaluation-suites.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import {
  parseWorkbenchRecord,
  serializeWorkbenchRecord,
  WorkbenchValidationError,
} from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchSuiteDraftV1 } from "../packages/core/src/personal-workbench.ts";
import {
  clearPublication,
  completePublication,
  publishSuiteDraft,
  rebaseSuiteDraft,
  reconcilePublication,
} from "../packages/core/src/workbench-publication.ts";

// Slice 2c-1 (C1, C4): one draft per suite, holding the whole suite. Suites
// have no revisions, so a save replaces the suite in place and the draft's
// base is the shared suite it started from.

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const project: ProjectFile = plan.shared;
const projectId = project.projectId;
const chatSuite = project.evaluationSuites.find(({ id }) => id === "evaluation-suite_chat")!;
const decisionSuite = project.evaluationSuites.find(({ id }) => id === "evaluation-suite_decision")!;

function suiteDraft(base: EvaluationSuite, edited: EvaluationSuite, extra: Record<string, unknown> = {}): WorkbenchSuiteDraftV1 {
  return parseWorkbenchRecord({
    schemaVersion: 1, kind: "draft", projectId, draftId: "draft_suite",
    asset: { kind: "suite", id: base.id }, base: { snapshot: base }, edited, ...extra,
  }, projectId) as WorkbenchSuiteDraftV1;
}

const renamed = { ...chatSuite, name: "Chat cases, edited" } as EvaluationSuite;
const draft = suiteDraft(chatSuite, renamed);

function withSuite(source: ProjectFile, suite: EvaluationSuite): ProjectFile {
  return parseProjectFile({ ...source, evaluationSuites: source.evaluationSuites.map(entry => entry.id === suite.id ? suite : entry) });
}

function refusal(message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ProjectValidationError || error instanceof WorkbenchValidationError, String(error));
    assert.match(error.message, message);
    return true;
  };
}

test("a suite draft round-trips through the workbench codec, for both suite kinds", () => {
  assert.deepEqual(parseWorkbenchRecord(JSON.parse(serializeWorkbenchRecord(draft)), projectId), draft);
  const decision = suiteDraft(decisionSuite, { ...decisionSuite, name: "Routing, edited" } as EvaluationSuite);
  assert.equal(decision.edited.input.kind, "decision-request-revision");
  assert.deepEqual(parseWorkbenchRecord(JSON.parse(serializeWorkbenchRecord(decision)), projectId), decision);
});

test("a suite draft names one suite: its base and edited content carry the asset's ID", () => {
  const other = { ...decisionSuite } as EvaluationSuite;
  assert.throws(() => suiteDraft(chatSuite, { ...renamed, id: other.id } as EvaluationSuite), refusal(/different suite/));
  assert.throws(() => parseWorkbenchRecord({
    ...draft, base: { snapshot: other },
  }, projectId), refusal(/different suite/));
  // Suites have no revisions; a base revision is not a suite field.
  assert.throws(() => parseWorkbenchRecord({ ...draft, base: { revisionId: "revision_chat-1", snapshot: chatSuite } }, projectId));
});

test("a suite draft refuses secret-bearing provider options, as selections do", () => {
  const leaking = {
    ...chatSuite,
    execution: { ...(chatSuite as { execution: object }).execution, options: { providerOptions: { apiKey: "sk-live" } } },
  } as unknown as EvaluationSuite;
  assert.throws(() => suiteDraft(chatSuite, leaking), refusal(/Secret-bearing/));
});

test("saving a suite draft replaces the suite in place and freezes the saved content", () => {
  const result = publishSuiteDraft(project, draft);
  assert.equal(result.kind, "publish");
  assert.ok(result.kind === "publish");
  assert.deepEqual(result.project.evaluationSuites.map(({ id }) => id), project.evaluationSuites.map(({ id }) => id));
  assert.equal(result.project.evaluationSuites.find(({ id }) => id === chatSuite.id)!.name, "Chat cases, edited");
  assert.deepEqual(result.intent, { content: renamed });
  // Nothing else in the shared document moves.
  assert.deepEqual({ ...result.project, evaluationSuites: [] }, { ...project, evaluationSuites: [] });
});

test("a draft equal to the saved suite writes nothing", () => {
  assert.deepEqual(publishSuiteDraft(project, suiteDraft(chatSuite, chatSuite)), { kind: "unchanged" });
  // Someone else already saved the same content: nothing to write either.
  assert.deepEqual(publishSuiteDraft(withSuite(project, renamed), draft), { kind: "unchanged" });
});

test("a suite changed since the draft started stops the save until the user overwrites (C4)", () => {
  const theirs = { ...chatSuite, name: "Someone else's name" } as EvaluationSuite;
  const changed = withSuite(project, theirs);
  const result = publishSuiteDraft(changed, draft);
  assert.deepEqual(result, { kind: "stale", current: theirs });

  // Overwrite with mine: the draft adopts their suite as its base, keeps its edits, then saves.
  const rebased = rebaseSuiteDraft(draft, theirs);
  assert.deepEqual(rebased.base.snapshot, theirs);
  assert.deepEqual(rebased.edited, renamed);
  const overwritten = publishSuiteDraft(changed, rebased);
  assert.ok(overwritten.kind === "publish");
  assert.equal(overwritten.project.evaluationSuites.find(({ id }) => id === chatSuite.id)!.name, "Chat cases, edited");
  assert.throws(() => rebaseSuiteDraft(draft, decisionSuite), refusal(/different suite/));
});

test("a deleted suite refuses a plain save; Save as new restores it under the name given", () => {
  const without = parseProjectFile({ ...project, evaluationSuites: project.evaluationSuites.filter(({ id }) => id !== chatSuite.id) });
  assert.throws(() => publishSuiteDraft(without, draft), refusal(/no longer exists/));
  const restored = publishSuiteDraft(without, draft, { asNew: { name: "Recovered cases" } });
  assert.ok(restored.kind === "publish");
  const suite = restored.project.evaluationSuites.at(-1)!;
  assert.equal(suite.id, chatSuite.id);
  assert.equal(suite.name, "Recovered cases");
  assert.deepEqual(restored.intent.content, suite);
  // Save as new is only for a suite that is gone.
  assert.throws(() => publishSuiteDraft(project, draft, { asNew: { name: "Again" } }), refusal(/still exists/));
});

test("a suite draft that no longer validates against the project is refused, not written", () => {
  const dangling = {
    ...chatSuite, input: { kind: "conversation-revision", conversationRevisionId: "revision_gone" },
  } as EvaluationSuite;
  assert.throws(() => publishSuiteDraft(project, suiteDraft(chatSuite, dangling)), refusal(/unknown conversation revision/));
  assert.throws(() => publishSuiteDraft(project, { ...draft, projectId: "project_other" } as WorkbenchSuiteDraftV1), refusal(/different project/));
});

test("reconciling a suite save compares the frozen content, never the ID alone", () => {
  const result = publishSuiteDraft(project, draft);
  assert.ok(result.kind === "publish");
  const record = parseWorkbenchRecord({ ...draft, publishing: result.intent }, projectId) as WorkbenchSuiteDraftV1;
  assert.equal(reconcilePublication(result.project, record), "published");
  // The shared write never landed: the suite still matches the base.
  assert.equal(reconcilePublication(project, record), "not-published");
  // Gone since: the draft is kept, and the open marks it orphaned.
  const without = parseProjectFile({ ...project, evaluationSuites: project.evaluationSuites.filter(({ id }) => id !== chatSuite.id) });
  assert.equal(reconcilePublication(without, record), "not-published");
  // Neither the base nor the saved content: someone else's edit, for review.
  assert.equal(reconcilePublication(withSuite(project, { ...chatSuite, name: "Third" } as EvaluationSuite), record), "conflict");
});

test("completing a suite save deletes the draft, or keeps later edits on the saved suite", () => {
  const result = publishSuiteDraft(project, draft);
  assert.ok(result.kind === "publish");
  const record = parseWorkbenchRecord({ ...draft, publishing: result.intent }, projectId) as WorkbenchSuiteDraftV1;
  assert.equal(completePublication(result.project, record, []).record, undefined);

  const later = { ...renamed, name: "Edited while saving" } as EvaluationSuite;
  const kept = completePublication(result.project, { ...record, edited: later } as WorkbenchSuiteDraftV1, []).record as WorkbenchSuiteDraftV1;
  assert.equal(kept.publishing, undefined);
  assert.deepEqual(kept.base.snapshot, renamed);
  assert.deepEqual(kept.edited, later);
  assert.throws(() => completePublication(project, record, []), refusal(/has not landed/));
  assert.deepEqual(clearPublication(record), draft);
});
