import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseProjectFile, ProjectValidationError } from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { setProjectDefaultEnvironment, setProjectEnvironment } from "../packages/core/src/environment.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { parseWorkbenchRecord } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchDraftV1, WorkbenchScratchV1 } from "../packages/core/src/personal-workbench.ts";
import {
  resolveLocalChatInput,
  resolveLocalDecisionInput,
  setDecisionLaunchDefault,
  setLaunchDefaults,
} from "../packages/core/src/workbench-local-input.ts";

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const project: ProjectFile = parseProjectFile({ ...plan.shared, schemaVersion: 18 });
const projectId = project.projectId;
const chatParent = project.conversationRevisions.find(({ id }) => id === "revision_chat-1")!;
const chatChild = project.conversationRevisions.find(({ id }) => id === "revision_chat-2")!;
const useRevision = project.decisionRequestRevisions.find(({ id }) => id === "decision-revision_use")!;
const inlineRevision = project.decisionRequestRevisions.find(({ id }) => id === "decision-revision_inline")!;
assert.ok(inlineRevision.kind === "inline");
const inlineDecision = inlineRevision.decision;

const literalItems = [{
  kind: "message" as const,
  message: { id: "message_local", role: "user" as const, content: [{ type: "text" as const, text: "Try latency instead." }] },
}];

const chatDraft = parseWorkbenchRecord({
  schemaVersion: 1, kind: "draft", projectId, draftId: "draft_chat",
  asset: { kind: "chat-request", id: "conversation_example" },
  base: { revisionId: chatChild.id, snapshot: chatChild },
  edited: { items: literalItems },
}) as WorkbenchDraftV1;
const decisionDraft = parseWorkbenchRecord({
  schemaVersion: 1, kind: "draft", projectId, draftId: "draft_decision",
  asset: { kind: "decision-request", id: "decision-request_example" },
  base: { revisionId: useRevision.id, snapshot: useRevision },
  edited: { kind: "template-use", templateId: "template_decision", templateRevisionId: "template-revision_decision-1", overrides: { ticket: "latency" } },
}) as WorkbenchDraftV1;
const chatScratch = parseWorkbenchRecord({
  schemaVersion: 1, kind: "scratch", projectId, scratchId: "scratch_chat", createdAt: "2026-10-31T12:00:00.000Z",
  localConversationId: "conversation_local", request: { kind: "chat", items: literalItems, parent: { kind: "saved-conversation-revision", revisionId: chatChild.id } },
}) as WorkbenchScratchV1;
const decisionScratch = parseWorkbenchRecord({
  schemaVersion: 1, kind: "scratch", projectId, scratchId: "scratch_decision", createdAt: "2026-10-31T12:00:00.000Z",
  localConversationId: "conversation_local-decision", request: { kind: "decision", content: { kind: "inline", decision: inlineRevision.decision, values: { ticket: "" } } },
}) as WorkbenchScratchV1;
function decisionScratchWith(values: Record<string, string>): WorkbenchScratchV1 {
  return parseWorkbenchRecord({ ...decisionScratch, request: { kind: "decision", content: { kind: "inline", decision: inlineDecision, values } } }) as WorkbenchScratchV1;
}
const records = { drafts: [chatDraft, decisionDraft], scratches: [chatScratch, decisionScratch] };

test("a saved revision runs as itself", () => {
  assert.deepEqual(resolveLocalChatInput(project, records, { kind: "saved-conversation-revision", revisionId: chatParent.id }), {
    items: chatParent.items,
    identity: { conversationId: "conversation_example", conversationRevisionId: chatParent.id },
  });
});

test("a request draft runs under its saved conversation with a fresh revision ID", () => {
  const resolved = resolveLocalChatInput(project, records, { kind: "draft", draftId: "draft_chat" }, { idSuffix: "run-1" });
  assert.deepEqual(resolved, {
    items: literalItems,
    identity: { conversationId: "conversation_example", conversationRevisionId: "revision_run-1" },
  });
  const another = resolveLocalChatInput(project, records, { kind: "draft", draftId: "draft_chat" });
  assert.notEqual(another?.identity.conversationRevisionId, resolved?.identity.conversationRevisionId);
  assert.ok(!project.conversationRevisions.some(({ id }) => id === another?.identity.conversationRevisionId));
  // Returned items are the caller's, not aliases of the record.
  resolved!.items.length = 0;
  assert.equal((chatDraft as { edited: { items: unknown[] } }).edited.items.length, 1);
});

test("a scratch runs under its stable local conversation with a fresh revision ID per run", () => {
  const first = resolveLocalChatInput(project, records, { kind: "scratch", scratchId: "scratch_chat" }, { idSuffix: "run-1" });
  const second = resolveLocalChatInput(project, records, { kind: "scratch", scratchId: "scratch_chat" }, { idSuffix: "run-2" });
  assert.deepEqual(first, { items: literalItems, identity: { conversationId: "conversation_local", conversationRevisionId: "revision_run-1" } });
  assert.equal(second?.identity.conversationId, "conversation_local");
  assert.equal(second?.identity.conversationRevisionId, "revision_run-2");
});

test("unknown or mismatched chat references resolve to nothing", () => {
  assert.equal(resolveLocalChatInput(project, records, { kind: "saved-conversation-revision", revisionId: "revision_gone" }), undefined);
  assert.equal(resolveLocalChatInput(project, records, { kind: "draft", draftId: "draft_gone" }), undefined);
  assert.equal(resolveLocalChatInput(project, records, { kind: "draft", draftId: "draft_decision" }), undefined);
  assert.equal(resolveLocalChatInput(project, records, { kind: "scratch", scratchId: "scratch_decision" }), undefined);
  const foreign = { drafts: [{ ...chatDraft, projectId: "project_other" } as WorkbenchDraftV1], scratches: [] };
  assert.equal(resolveLocalChatInput(project, foreign, { kind: "draft", draftId: "draft_chat" }), undefined);
});

test("decision inputs resolve their content, template pin and supplied values", () => {
  const saved = resolveLocalDecisionInput(project, records, { kind: "saved-decision-request-revision", revisionId: useRevision.id })!;
  const template = project.promptTemplates.find(({ id }) => id === "template_decision")!;
  const pinned = template.revisions[0]!;
  assert.ok("decision" in pinned);
  assert.deepEqual(saved.decision, pinned.decision);
  // The saved empty override is a value, and `region` inherits the pin's default.
  assert.deepEqual(saved.values, { region: "global", ticket: "" });
  assert.deepEqual(saved.content, { kind: "template-use", templateId: "template_decision", templateRevisionId: "template-revision_decision-1", overrides: { ticket: "" } });
  assert.deepEqual(saved.diagnostics, []);
  const unassigned = resolveLocalDecisionInput(project, { drafts: [], scratches: [decisionScratchWith({})] }, { kind: "scratch", scratchId: "scratch_decision" })!;
  assert.deepEqual(unassigned.diagnostics.map(({ name }) => name).sort(), ["region", "ticket"]);

  const draft = resolveLocalDecisionInput(project, records, { kind: "draft", draftId: "draft_decision" })!;
  assert.deepEqual(draft.values, { region: "global", ticket: "latency" });
  assert.deepEqual(draft.diagnostics, []);
  assert.deepEqual(draft.variables.sort(), ["region", "ticket"]);

  const local = resolveLocalDecisionInput(project, records, { kind: "scratch", scratchId: "scratch_decision" })!;
  assert.deepEqual(local.decision, inlineRevision.decision);
  assert.deepEqual(local.values, { ticket: "" });
  // Authored order is part of the request; resolution keeps it.
  assert.equal(JSON.stringify(local.decision), JSON.stringify(inlineRevision.decision));

  assert.equal(resolveLocalDecisionInput(project, records, { kind: "draft", draftId: "draft_chat" }), undefined);
  assert.equal(resolveLocalDecisionInput(project, records, { kind: "scratch", scratchId: "scratch_chat" }), undefined);
  const stalePin = { ...decisionDraft, edited: { kind: "template-use", templateId: "template_decision", templateRevisionId: "template-revision_gone", overrides: {} } } as WorkbenchDraftV1;
  assert.equal(resolveLocalDecisionInput(project, { drafts: [stalePin], scratches: [] }, { kind: "draft", draftId: "draft_decision" }), undefined);
});

test("launch defaults take saved references only and leave the environment default alone", () => {
  const withEnvironment = setProjectDefaultEnvironment(setProjectEnvironment(project, {
    id: "environment_staging", name: "Staging", entries: [],
  }), "environment_staging");
  const target = { ...project.defaults.target, model: "chat-other" };
  const next = setLaunchDefaults(withEnvironment, {
    chat: { revisionId: chatParent.id, target, options: { temperature: 0.1 }, enabledToolIds: [] },
  });
  assert.deepEqual(next.defaults, {
    ...withEnvironment.defaults,
    conversationRevisionId: chatParent.id,
    target,
    options: { temperature: 0.1 },
    enabledToolIds: [],
  });
  assert.equal(next.defaults.environmentId, "environment_staging");
  assert.deepEqual(next.conversationRevisions, project.conversationRevisions);

  for (const revisionId of ["revision_run-1", "revision_local"]) {
    assert.throws(() => setLaunchDefaults(project, {
      chat: { revisionId: revisionId as typeof chatParent.id, target, options: {}, enabledToolIds: [] },
    }), (error: unknown) => error instanceof ProjectValidationError && /saved request revision/.test(error.message));
  }
  assert.throws(() => setLaunchDefaults(project, {
    chat: { revisionId: chatParent.id, target, options: {}, enabledToolIds: ["tool_gone" as never] },
  }), ProjectValidationError);

  const decision = setDecisionLaunchDefault(project, inlineRevision.id);
  assert.deepEqual(decision.defaults, { ...project.defaults, decisionRequestRevisionId: inlineRevision.id });
  assert.throws(() => setDecisionLaunchDefault(project, "decision-revision_local" as typeof inlineRevision.id),
    (error: unknown) => error instanceof ProjectValidationError && /saved decision request revision/.test(error.message));
});
