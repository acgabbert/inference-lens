import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createProjectFile, parseProjectJson } from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { setProjectDefaultEnvironment, setProjectEnvironment } from "../packages/core/src/environment.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import {
  parseWorkbenchRecord,
  parseWorkbenchRecordJson,
  serializeWorkbenchRecord,
  WorkbenchValidationError,
} from "../packages/core/src/personal-workbench.ts";
import { parseMigrationResolutions, serializeMigrationResolutions } from "../packages/core/src/migration-journal.ts";
import { assertWorkbenchRecordPath, workbenchRecordPath } from "../packages/core/src/workbench-store.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";

const projectId = "project_shared-assets-example";
const example = (name: string) => readFileSync(new URL(`../docs/examples/shared-assets-level-two/${name}`, import.meta.url));
const legacy = parseProjectJson(example("project-v15.json").toString());
const chatParent = legacy.conversationRevisions.find(({ id }) => id === "revision_chat-1")!;
const chatChild = legacy.conversationRevisions.find(({ id }) => id === "revision_chat-2")!;
const inlineRevision = legacy.decisionRequestRevisions.find(({ id }) => id === "decision-revision_inline")!;
const useRevision = legacy.decisionRequestRevisions.find(({ id }) => id === "decision-revision_use")!;
const inlineDecision = inlineRevision.kind === "inline" ? inlineRevision.decision : undefined;
assert.ok(inlineDecision);

const literalItems = [{
  kind: "message",
  message: { id: "message_local", role: "user", content: [{ type: "text", text: "Try latency instead." }] },
}];

function roundTrips(value: unknown): void {
  const parsed = parseWorkbenchRecord(value, projectId);
  assert.deepEqual(parsed, value);
  const serialized = serializeWorkbenchRecord(parsed);
  assert.deepEqual(parseWorkbenchRecordJson(serialized, projectId), parsed);
  assert.equal(serializeWorkbenchRecord(parseWorkbenchRecordJson(serialized)), serialized);
}

const chatRequestDraft = {
  schemaVersion: 1,
  kind: "draft",
  projectId,
  draftId: "draft_chat-request",
  asset: { kind: "chat-request", id: "conversation_example" },
  base: { revisionId: chatChild.id, snapshot: chatChild },
  edited: { items: literalItems },
};

const decisionRequestDraft = {
  schemaVersion: 1,
  kind: "draft",
  projectId,
  draftId: "draft_decision-request",
  asset: { kind: "decision-request", id: "decision-request_example" },
  base: { revisionId: useRevision.id, snapshot: useRevision },
  edited: { kind: "template-use", templateId: "template_decision", templateRevisionId: "template-revision_decision-1", overrides: { ticket: "latency", region: "" } },
};

test("chat request drafts keep a saved revision snapshot and edited authored items", () => {
  roundTrips(chatRequestDraft);
  // Edited items may keep a pinned template use, with an empty saved value.
  roundTrips({ ...chatRequestDraft, edited: { items: [{ ...chatChild.items[0], use: { ...(chatChild.items[0] as { use: object }).use, values: { topic: "" } } }] } });
  roundTrips({ ...chatRequestDraft, edited: { items: [] } });
  assert.equal(workbenchRecordPath(parseWorkbenchRecord(chatRequestDraft)), "drafts/draft_chat-request.json");
});

test("request drafts refuse mismatched bases, foreign assets and secret assignments", () => {
  for (const value of [
    { ...chatRequestDraft, base: { revisionId: chatParent.id, snapshot: chatChild } },
    { ...chatRequestDraft, asset: { kind: "chat-request", id: "conversation_other" } },
    { ...chatRequestDraft, asset: { kind: "chat-request", id: "template_chat" } },
    { ...chatRequestDraft, base: { revisionId: inlineRevision.id, snapshot: inlineRevision } },
    { ...chatRequestDraft, edited: { items: literalItems, extra: true } },
    { ...chatRequestDraft, edited: { items: [{ ...chatChild.items[0], use: { ...(chatChild.items[0] as { use: object }).use, values: { api_key: "secret" } } }] } },
    { ...decisionRequestDraft, base: { revisionId: inlineRevision.id, snapshot: useRevision } },
    { ...decisionRequestDraft, asset: { kind: "decision-request", id: "decision-request_other" } },
    { ...decisionRequestDraft, edited: { ...decisionRequestDraft.edited, overrides: { api_key: "secret" } } },
    { ...decisionRequestDraft, edited: { kind: "inline", decision: inlineDecision, values: { unused: "value" } } },
    { ...decisionRequestDraft, edited: { kind: "inline", decision: {}, values: {} } },
    { ...decisionRequestDraft, edited: { ...decisionRequestDraft.edited, decisionRequestId: "decision-request_example" } },
  ]) assert.throws(() => parseWorkbenchRecord(value), WorkbenchValidationError, JSON.stringify(value).slice(0, 160));
});

test("decision request drafts carry either arm, including a local detach from a template use", () => {
  roundTrips(decisionRequestDraft);
  // Sparse overrides stay sparse; an empty override is a value.
  roundTrips({ ...decisionRequestDraft, edited: { ...decisionRequestDraft.edited, overrides: {} } });
  roundTrips({ ...decisionRequestDraft, edited: { kind: "inline", decision: inlineDecision, values: { ticket: "" } } });
  roundTrips({ ...decisionRequestDraft, base: { revisionId: inlineRevision.id, snapshot: inlineRevision }, edited: { kind: "inline", decision: inlineDecision, values: {} } });
});

test("publication intent freezes the content being published beside the draft", () => {
  roundTrips({
    ...chatRequestDraft,
    publishing: { revisionId: "revision_published", parentRevisionId: chatChild.id, content: { items: literalItems } },
  });
  roundTrips({
    ...decisionRequestDraft,
    publishing: { revisionId: "decision-revision_published", parentRevisionId: useRevision.id, content: { kind: "inline", decision: inlineDecision, values: {} } },
  });
  const [promptDraft] = planSharedProjectMigration(example("project-v15.json")).drafts;
  assert.ok(promptDraft);
  const content = structuredClone(promptDraft.edited);
  delete content.revisionName;
  roundTrips({ ...promptDraft, publishing: { revisionId: "template-revision_published", parentRevisionId: promptDraft.base.revisionId, content: promptDraft.edited } });
  roundTrips({ ...promptDraft, publishing: { revisionId: "template-revision_published", parentRevisionId: promptDraft.base.revisionId, content } });
  for (const publishing of [
    {},
    { revisionId: "decision-revision_wrong", content: { items: literalItems } },
    { revisionId: "revision_published", content: { kind: "inline", decision: inlineDecision, values: {} } },
    { revisionId: "revision_published", parentRevisionId: "template-revision_chat-1", content: { items: literalItems } },
    { revisionId: "revision_published", content: { items: literalItems }, extra: true },
  ]) assert.throws(() => parseWorkbenchRecord({ ...chatRequestDraft, publishing }), WorkbenchValidationError, JSON.stringify(publishing));
});

const chatScratch = {
  schemaVersion: 1,
  kind: "scratch",
  projectId,
  scratchId: "scratch_branch",
  createdAt: "2026-10-31T12:00:00.000Z",
  localConversationId: "conversation_local-branch",
  request: { kind: "chat", items: literalItems, parent: { kind: "saved-conversation-revision", revisionId: chatChild.id } },
  branchedFrom: { runId: "run_parent", messageId: "message_explain" },
};

const pinnedItem = chatChild.items.find(item => item.kind === "template-use")!;
assert.equal(pinnedItem.kind, "template-use");
if (pinnedItem.kind !== "template-use") throw new Error("Expected a pinned chat template fixture.");
const pinnedUse = pinnedItem.use;
const duplicateItemCases = [
  { name: "literal message IDs", id: "message_local", items: [literalItems[0], literalItems[0]] },
  { name: "template-use IDs", id: pinnedUse.id, items: [pinnedItem, { ...pinnedItem, use: { ...pinnedUse, outputMessageIds: ["message_other"] } }] },
  { name: "output IDs within a use", id: "message_repeated", items: [{ ...pinnedItem, use: { ...pinnedUse, outputMessageIds: ["message_repeated", "message_repeated"] } }] },
  { name: "output IDs across uses", id: "message_repeated", items: [
    { ...pinnedItem, use: { ...pinnedUse, outputMessageIds: ["message_repeated"] } },
    { ...pinnedItem, use: { ...pinnedUse, id: "template-use_other", outputMessageIds: ["message_repeated"] } },
  ] },
  { name: "literal and output IDs", id: "message_local", items: [literalItems[0], { ...pinnedItem, use: { ...pinnedUse, outputMessageIds: ["message_local"] } }] },
];

for (const { name, id, items } of duplicateItemCases) {
  const records = [
    { name: "base snapshot", value: { ...chatRequestDraft, base: { ...chatRequestDraft.base, snapshot: { ...chatChild, items } } }, path: ["base", "snapshot", "items"] },
    { name: "edited draft", value: { ...chatRequestDraft, edited: { items } }, path: ["edited", "items"] },
    { name: "draft publication", value: { ...chatRequestDraft, publishing: { revisionId: "revision_published", parentRevisionId: chatChild.id, content: { items } } }, path: ["publishing", "content", "items"] },
    { name: "scratch request", value: { ...chatScratch, request: { ...chatScratch.request, items } }, path: ["request", "items"] },
    { name: "scratch publication", value: { ...chatScratch, publishing: { conversationId: "conversation_example", revisionId: "revision_published", parentRevisionId: chatChild.id, content: { items } } }, path: ["publishing", "content", "items"] },
  ];
  for (const record of records) {
    test(`${record.name} rejects duplicate ${name}`, () => {
      assert.throws(() => parseWorkbenchRecord(record.value), (error: unknown) => {
        assert.ok(error instanceof WorkbenchValidationError);
        assert.ok(error.issues.some(issue => issue.message === `Duplicate identifier "${id}".`
          && record.path.every((part, index) => issue.path[index] === part)), error.message);
        return true;
      });
    });
  }
}

for (const kind of ["chat", "decision"] as const) {
  test(`${kind} scratch publication rejects a revision that is its own parent`, () => {
    const revisionId = kind === "chat" ? "revision_parent" : "decision-revision_parent";
    const record = {
      ...chatScratch,
      request: kind === "chat" ? chatScratch.request : { kind: "decision", content: decisionRequestDraft.edited },
      publishing: {
        ...(kind === "chat" ? { conversationId: "conversation_example" } : { decisionRequestId: "decision-request_example" }),
        revisionId, parentRevisionId: revisionId,
        content: kind === "chat" ? { items: literalItems } : decisionRequestDraft.edited,
      },
    };
    assert.throws(() => parseWorkbenchRecord(record), (error: unknown) => {
      assert.ok(error instanceof WorkbenchValidationError);
      assert.ok(error.issues.some(issue => issue.path.join(".") === "publishing.revisionId"
        && issue.message === "A publication allocates a new revision."), error.message);
      return true;
    });
  });
}

test("scratch records hold local requests with discriminated parents and a stable local conversation", () => {
  roundTrips(chatScratch);
  roundTrips({ ...chatScratch, scratchId: "scratch_child", request: { kind: "chat", items: literalItems, parent: { kind: "scratch", scratchId: "scratch_branch" } } });
  const fresh: Partial<typeof chatScratch> = structuredClone(chatScratch);
  delete fresh.branchedFrom;
  roundTrips({ ...fresh, request: { kind: "chat", items: literalItems } });
  roundTrips({
    ...fresh,
    scratchId: "scratch_decision",
    request: { kind: "decision", content: { kind: "inline", decision: inlineDecision, values: { ticket: "" } }, parent: { kind: "saved-decision-request-revision", revisionId: useRevision.id } },
  });
  // With a saved ancestor, publication branches inside the ancestor's request,
  // because project.json keeps a parent in its child's conversation.
  roundTrips({
    ...chatScratch,
    publishing: { conversationId: "conversation_example", revisionId: "revision_published", parentRevisionId: chatChild.id, content: { items: literalItems } },
  });
  // Without one, it creates a named request.
  roundTrips({
    ...fresh,
    publishing: { conversationId: "conversation_published", name: "Latency", revisionId: "revision_published", content: { items: literalItems } },
  });
  roundTrips({
    ...fresh,
    scratchId: "scratch_decision",
    request: { kind: "decision", content: decisionRequestDraft.edited },
    publishing: { decisionRequestId: "decision-request_published", name: "Latency", revisionId: "decision-revision_published", content: decisionRequestDraft.edited },
  });
  assert.equal(workbenchRecordPath(parseWorkbenchRecord(chatScratch)), "scratch/scratch_branch.json");
  // Envelope first; fields shared with saved content keep project.json's order.
  assert.deepEqual(Object.keys(JSON.parse(serializeWorkbenchRecord(parseWorkbenchRecord(chatScratch)))), [
    "schemaVersion", "kind", "projectId", "scratchId", "localConversationId", "request", "branchedFrom", "createdAt",
  ]);
  const draft = JSON.parse(serializeWorkbenchRecord(parseWorkbenchRecord(chatRequestDraft)));
  assert.deepEqual(Object.keys(draft.base.snapshot), Object.keys(chatChild));
});

test("scratch records refuse claimed shared identities, self parents and mismatched publication", () => {
  for (const value of [
    { ...chatScratch, scratchId: "draft_branch" },
    { ...chatScratch, scratchId: "scratch_../../escape" },
    { ...chatScratch, localConversationId: "revision_local" },
    { ...chatScratch, request: { kind: "chat", items: literalItems, parent: { kind: "scratch", scratchId: "scratch_branch" } } },
    { ...chatScratch, request: { kind: "chat", items: literalItems, parent: { kind: "saved-decision-request-revision", revisionId: useRevision.id } } },
    { ...chatScratch, request: { kind: "chat", items: literalItems, parent: { kind: "saved-conversation-revision", revisionId: chatChild.id, conversationId: "conversation_example" } } },
    { ...chatScratch, request: { kind: "decision", content: { kind: "inline", decision: inlineDecision, values: {} }, parent: { kind: "saved-conversation-revision", revisionId: chatChild.id } } },
    { ...chatScratch, publishing: { conversationId: "conversation_published", name: "", revisionId: "revision_published", content: { items: literalItems } } },
    { ...chatScratch, publishing: { conversationId: "conversation_example", name: "Both", revisionId: "revision_published", parentRevisionId: chatChild.id, content: { items: literalItems } } },
    { ...chatScratch, publishing: { conversationId: "conversation_example", revisionId: "revision_published", content: { items: literalItems } } },
    { ...chatScratch, publishing: { decisionRequestId: "decision-request_published", name: "Wrong kind", revisionId: "decision-revision_published", content: decisionRequestDraft.edited } },
    { ...chatScratch, publishing: { name: "Missing identity", revisionId: "revision_published", content: { items: literalItems } } },
    { ...chatScratch, createdAt: "yesterday" },
  ]) assert.throws(() => parseWorkbenchRecord(value), WorkbenchValidationError, JSON.stringify(value).slice(0, 200));
  assert.throws(() => parseWorkbenchRecord(chatScratch, "project_other"), /different project/);
});

test("selections name saved revisions or local records, and an environment choice", () => {
  const base = { schemaVersion: 1, kind: "selections", projectId };
  roundTrips({
    ...base,
    chat: { selectedInput: { kind: "draft", draftId: "draft_chat-request" }, execution: { environmentId: "environment_staging" } },
    decision: { selectedInput: { kind: "scratch", scratchId: "scratch_decision" } },
  });
  roundTrips({ ...base, chat: { selectedInput: { kind: "scratch", scratchId: "scratch_branch" }, execution: { environmentId: null } } });
  roundTrips({ ...base, decision: { selectedInput: { kind: "draft", draftId: "draft_decision-request" } } });
  for (const value of [
    { ...base, chat: { selectedInput: { kind: "draft", draftId: "scratch_branch" } } },
    { ...base, chat: { selectedInput: { kind: "scratch", scratchId: "draft_chat-request" } } },
    { ...base, chat: { selectedInput: { kind: "saved-decision-request-revision", revisionId: useRevision.id } } },
    { ...base, decision: { selectedInput: { kind: "saved-conversation-revision", revisionId: chatChild.id } } },
    { ...base, chat: { execution: { environmentId: "connection_example" } } },
  ]) assert.throws(() => parseWorkbenchRecord(value), WorkbenchValidationError, JSON.stringify(value));
});

test("scratch record paths are accepted beside drafts and selections, and nothing else", () => {
  assert.equal(assertWorkbenchRecordPath("scratch/scratch_branch.json"), "scratch/scratch_branch.json");
  for (const path of ["scratch/draft_branch.json", "scratch/scratch_.json", "scratch/scratch_a/b.json", "drafts/scratch_branch.json", "scratch/scratch_a.txt"]) {
    assert.throws(() => assertWorkbenchRecordPath(path), /Invalid workbench record path/, path);
  }
});

test("migration resolutions record each settled candidate beside the immutable journal", () => {
  const operationId = `migration_${"a".repeat(64)}`;
  const candidate = `candidates/draft_migrated-${"b".repeat(64)}.json`;
  const value = {
    schemaVersion: 1,
    kind: "migration-resolutions",
    projectId,
    operationId,
    resolutions: [
      { candidate, outcome: "used", settledAt: "2026-10-31T12:00:00.000Z", replacedCopy: `migrations/${operationId}/replaced/draft_local.json` },
      { candidate: "candidates/selections.json", outcome: "discarded", settledAt: "2026-10-31T12:01:00.000Z" },
    ],
  };
  const parsed = parseMigrationResolutions(value, projectId);
  assert.deepEqual(parsed, value);
  const serialized = serializeMigrationResolutions(parsed);
  assert.deepEqual(Object.keys(JSON.parse(serialized)), Object.keys(value));
  assert.deepEqual(parseMigrationResolutions(JSON.parse(serialized), projectId), parsed);
  assert.equal(serializeMigrationResolutions(parseMigrationResolutions(JSON.parse(serialized))), serialized);
  const removed = { ...value, backupRemovedAt: "2026-10-31T13:00:00.000Z" };
  assert.deepEqual(parseMigrationResolutions(removed), removed);
  for (const invalid of [
    { ...value, schemaVersion: 2 },
    { ...value, kind: "selections" },
    { ...value, extra: true },
    { ...value, resolutions: [{ ...value.resolutions[1], outcome: "merged" }] },
    { ...value, resolutions: [value.resolutions[1], value.resolutions[1]] },
    { ...value, resolutions: [{ ...value.resolutions[0], replacedCopy: `migrations/migration_${"c".repeat(64)}/replaced/draft_local.json` }] },
    { ...value, resolutions: [{ ...value.resolutions[0], replacedCopy: "drafts/draft_local.json" }] },
    { ...value, resolutions: [{ ...value.resolutions[0], replacedCopy: `migrations/${operationId}/replaced/../draft_local.json` }] },
    { ...value, resolutions: [{ ...value.resolutions[1], replacedCopy: `migrations/${operationId}/replaced/selections.json` }] },
    { ...value, resolutions: [{ ...value.resolutions[1], candidate: "../../project.json" }] },
    { ...value, resolutions: [{ ...value.resolutions[1], candidate: "candidates/draft_local.json" }] },
    { ...value, resolutions: [{ ...value.resolutions[1], settledAt: "later" }] },
    { ...value, operationId: "../op" },
  ]) assert.throws(() => parseMigrationResolutions(invalid), WorkbenchValidationError, JSON.stringify(invalid).slice(0, 200));
  assert.throws(() => parseMigrationResolutions(value, "project_other"), /different project/);
});

function projectWithEnvironment(defaultEnvironment: boolean): ProjectFile {
  let project = createProjectFile({
    name: "Environments", idSuffix: "environments", createdAt: "2026-10-31T12:00:00.000Z",
    request: { provider: "openai-compatible", endpoint: "https://example.com/v1", model: "example", messages: [{ role: "user", content: "Hello" }], capabilities: resolveProviderCapabilities("openai-compatible") },
  });
  project = setProjectEnvironment(project, { id: "environment_staging", name: "Staging", entries: [] });
  return defaultEnvironment ? setProjectDefaultEnvironment(project, "environment_staging") : project;
}

test("migration seeds the personal environment choice from the launch default", () => {
  const seeded = planSharedProjectMigration(Buffer.from(JSON.stringify(projectWithEnvironment(true))));
  assert.equal(seeded.selections.chat?.execution?.environmentId, "environment_staging");
  assert.equal(seeded.shared.defaults.environmentId, "environment_staging");
  const unseeded = planSharedProjectMigration(Buffer.from(JSON.stringify(projectWithEnvironment(false))));
  assert.equal(unseeded.selections.chat?.execution && "environmentId" in unseeded.selections.chat.execution, false);
});
