import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { detachDecisionRequestTemplate, updateDecisionRequestTemplateRevision } from "../packages/core/src/decision-request.ts";
import { parseProjectFile } from "../packages/core/src/project.ts";
import type { ProjectDecisionRequestRevision, ProjectFile } from "../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import type { WorkbenchDecisionRequestContent, WorkbenchScratchV1 } from "../packages/core/src/personal-workbench.ts";
import type { ConversationId } from "../packages/core/src/run-kernel/types.ts";
import {
  decisionContentAfterMutation,
  decisionScratchNeedsName,
  editedDecisionContent,
  resolveDecisionContent,
  selectedDecisionRecord,
  suggestedDecisionRequestName,
} from "../app/decisions/local-decision-request.ts";

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const shared: ProjectFile = parseProjectFile({ ...plan.shared, schemaVersion: 18 });
const projectId = shared.projectId;
const inline = shared.decisionRequestRevisions.find(({ id }) => id === "decision-revision_inline") as Extract<ProjectDecisionRequestRevision, { kind: "inline" }>;
const use = shared.decisionRequestRevisions.find(({ id }) => id === "decision-revision_use") as Extract<ProjectDecisionRequestRevision, { kind: "template-use" }>;
const useContent: WorkbenchDecisionRequestContent = { kind: "template-use", templateId: use.templateId, templateRevisionId: use.templateRevisionId, overrides: { ...use.overrides } };

function scratch(scratchId: string, parent?: WorkbenchScratchV1["request"]["parent"]): WorkbenchScratchV1 {
  return {
    schemaVersion: 1, kind: "scratch", projectId, scratchId: scratchId as WorkbenchScratchV1["scratchId"], createdAt: "2026-11-04T15:00:00.000Z",
    localConversationId: `conversation_${scratchId}` as ConversationId,
    request: { kind: "decision", content: useContent, ...(parent ? { parent } : {}) } as WorkbenchScratchV1["request"],
  };
}

const noRecords = { draftById: () => undefined, scratch: () => undefined };

test("no selection inherits the decision launch default, and a project without one has no record", () => {
  const selected = selectedDecisionRecord(shared, undefined, noRecords);
  assert.equal(selected.kind, "saved");
  assert.equal(selected.revision?.id, shared.defaults.decisionRequestRevisionId);
  const defaults = { ...shared.defaults };
  delete defaults.decisionRequestRevisionId;
  assert.equal(selectedDecisionRecord({ ...shared, defaults }, undefined, noRecords).kind, "none");
  // A selection that names nothing here falls back too.
  assert.equal(selectedDecisionRecord(shared, { kind: "scratch", scratchId: "scratch_gone" }, noRecords).kind, "saved");
});

test("a template-use pin resolves to its prompt's decision with overrides over the defaults", () => {
  const resolved = resolveDecisionContent(shared, useContent)!;
  assert.equal(resolved.values.ticket, "");
  assert.ok(resolved.variables.includes("ticket"));
  assert.equal(resolveDecisionContent(shared, { ...useContent, templateRevisionId: "template-revision_gone" as never }), undefined);
});

test("value edits on a pin stay sparse overrides; inline edits keep only used variables", () => {
  const resolved = resolveDecisionContent(shared, useContent)!;
  const edited = editedDecisionContent(shared, useContent, { decision: resolved.decision, values: { ...resolved.values, ticket: "New ticket" } });
  assert.deepEqual(edited, { ...useContent, overrides: { ticket: "New ticket" } });
  const unchanged = editedDecisionContent(shared, useContent, { decision: resolved.decision, values: resolved.values });
  assert.deepEqual(unchanged, useContent);
  const inlineEdit = editedDecisionContent(shared, undefined, { decision: inline.decision, values: { ticket: "T", unused: "dropped" } });
  assert.deepEqual(inlineEdit, { kind: "inline", decision: inline.decision, values: { ticket: "T" } });
});

test("detach and retarget run the core helpers on local content", () => {
  const detached = decisionContentAfterMutation(shared, useContent, (project, revisionId) =>
    detachDecisionRequestTemplate(project, { decisionRequestRevisionId: revisionId }));
  assert.equal(detached.kind, "inline");
  const resolved = resolveDecisionContent(shared, useContent)!;
  assert.deepEqual(detached.kind === "inline" && detached.values, resolved.values);
  // Retargeting to the same revision changes nothing.
  const same = decisionContentAfterMutation(shared, useContent, (project, revisionId) =>
    updateDecisionRequestTemplateRevision(project, { decisionRequestRevisionId: revisionId, templateRevisionId: use.templateRevisionId }));
  assert.deepEqual(same, useContent);
});

test("a scratch needs a name only without a saved ancestor, and is offered its prompt's name", () => {
  const root = scratch("scratch_root");
  const child = scratch("scratch_child", { kind: "scratch", scratchId: "scratch_root" });
  const records = { draftById: () => undefined, scratch: (id: string) => [root, child].find(({ scratchId }) => scratchId === id) };
  assert.equal(decisionScratchNeedsName(root, records), true);
  assert.equal(decisionScratchNeedsName(child, records), true);
  assert.equal(decisionScratchNeedsName(scratch("scratch_saved", { kind: "saved-decision-request-revision", revisionId: inline.id }), records), false);
  const template = shared.promptTemplates.find(({ id }) => id === use.templateId)!;
  assert.equal(suggestedDecisionRequestName(shared, useContent), template.name);
  assert.equal(suggestedDecisionRequestName(shared, { kind: "inline", decision: inline.decision, values: {} }), "Decision request");
});
