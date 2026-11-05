import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import type {
  WorkbenchChatRequestDraftV1,
  WorkbenchDraftV1,
  WorkbenchScratchV1,
} from "../packages/core/src/personal-workbench.ts";
import type { ConversationId, MessageId } from "../packages/core/src/run-kernel/types.ts";
import { requestMenu } from "../app/workbench/request-menu.ts";
import { chatRequestMenu, selectedChatRecord } from "../app/request/local-chat-request.ts";
import { decisionRequestMenu, selectedDecisionRecord } from "../app/decisions/local-decision-request.ts";

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const shared: ProjectFile = plan.shared;
const projectId = shared.projectId;
const [first, second] = shared.conversationRevisions;

type ChatParent = Extract<WorkbenchScratchV1["request"], { kind: "chat" }>["parent"];

function scratch(scratchId: string, parent: ChatParent, branched: boolean, createdAt: string): WorkbenchScratchV1 {
  return {
    schemaVersion: 1, kind: "scratch", projectId, scratchId: scratchId as WorkbenchScratchV1["scratchId"], createdAt,
    localConversationId: `conversation_local-${scratchId}` as ConversationId,
    request: { kind: "chat", items: [{ kind: "message", message: { id: "message_s" as MessageId, role: "user", content: [{ type: "text", text: "s" }] } }], ...(parent ? { parent } : {}) },
    ...(branched ? { branchedFrom: { runId: "run_x", messageId: "message_s" as MessageId } } : {}),
  };
}

test("one entry per request opens its newest revision, with revisions newest first", () => {
  const menu = requestMenu({
    requests: [{ id: "r1", name: "One" }, { id: "r2", name: "Two" }, { id: "r3", name: "Empty" }],
    revisions: [
      { id: "a", requestId: "r1", createdAt: "2026-11-01T00:00:00Z" },
      { id: "c", requestId: "r2", createdAt: "2026-11-01T00:00:00Z" },
      { id: "b", requestId: "r1", createdAt: "2026-11-02T00:00:00Z" },
    ],
    launchRevisionId: "a",
    draftFor: () => undefined,
    scratches: [],
    selected: { kind: "saved", revisionId: "a" },
  });
  assert.deepEqual(menu.requests.map(({ requestId, open, launchDefault }) => [requestId, open, launchDefault]), [
    ["r1", { kind: "saved", revisionId: "b" }, true],
    ["r2", { kind: "saved", revisionId: "c" }, false],
  ]);
  assert.deepEqual(menu.requests[0]!.revisions, [
    { revisionId: "b", ordinal: 2, launchDefault: false },
    { revisionId: "a", ordinal: 1, launchDefault: true },
  ]);
  assert.equal(menu.selectedKey, "request:r1");
  assert.equal(menu.selectedRevisionKey, "a");
});

test("equal creation times keep file order", () => {
  const menu = requestMenu({
    requests: [{ id: "r1", name: "One" }],
    revisions: [{ id: "a", requestId: "r1", createdAt: "x" }, { id: "b", requestId: "r1", createdAt: "x" }],
    launchRevisionId: undefined, draftFor: () => undefined, scratches: [], selected: undefined,
  });
  assert.deepEqual(menu.requests[0]!.open, { kind: "saved", revisionId: "b" });
  assert.equal(menu.selectedKey, undefined);
});

test("a request with a draft opens the draft", () => {
  const draft: WorkbenchChatRequestDraftV1 = {
    schemaVersion: 1, kind: "draft", projectId, draftId: "draft_one",
    asset: { kind: "chat-request", id: first!.conversationId },
    base: { revisionId: first!.id, snapshot: structuredClone(first!) },
    edited: { items: [] },
  };
  const records = {
    scratches: [] as WorkbenchScratchV1[],
    scratch: () => undefined,
    draftById: (id: string) => (id === draft.draftId ? draft : undefined),
    draftFor: (asset: { id: string }): WorkbenchDraftV1 | undefined => (asset.id === draft.asset.id ? draft : undefined),
  };
  const menu = chatRequestMenu(shared, selectedChatRecord(shared, { kind: "draft", draftId: "draft_one" }, records), records);
  assert.deepEqual(menu.requests[0]!.open, { kind: "draft", draftId: "draft_one" });
  assert.deepEqual(menu.requests[0]!.draft, { draftId: "draft_one", baseRevisionId: first!.id });
  assert.equal(menu.selectedKey, `request:${first!.conversationId}`);
  assert.equal(menu.selectedRevisionKey, "draft");
});

test("scratches are labelled by their nearest saved parent", () => {
  const scratches = [
    scratch("scratch_b", { kind: "saved-conversation-revision", revisionId: second!.id }, true, "2026-11-04T02:00:00Z"),
    scratch("scratch_a", { kind: "saved-conversation-revision", revisionId: second!.id }, true, "2026-11-04T01:00:00Z"),
    scratch("scratch_c", { kind: "scratch", scratchId: "scratch_a" }, false, "2026-11-04T03:00:00Z"),
    scratch("scratch_d", undefined, false, "2026-11-04T04:00:00Z"),
  ];
  const records = {
    scratches,
    scratch: (id: string) => scratches.find(({ scratchId }) => scratchId === id),
    draftById: () => undefined,
    draftFor: () => undefined,
  };
  const menu = chatRequestMenu(shared, selectedChatRecord(shared, { kind: "scratch", scratchId: "scratch_c" }, records), records);
  assert.deepEqual(menu.scratches, [
    { scratchId: "scratch_a", label: "Branch of Explain (1)" },
    { scratchId: "scratch_b", label: "Branch of Explain (2)" },
    { scratchId: "scratch_c", label: "Local copy of Explain" },
    { scratchId: "scratch_d", label: "New request" },
  ]);
  assert.equal(menu.selectedKey, "scratch:scratch_c");
});

test("the decision menu lists decision requests and marks the decision launch default", () => {
  const records = { scratches: [], scratch: () => undefined, draftById: () => undefined, draftFor: () => undefined };
  const menu = decisionRequestMenu(shared, selectedDecisionRecord(shared, undefined, records), records);
  assert.equal(menu.requests.length, 1);
  assert.equal(menu.requests[0]!.name, "Ticket routing");
  assert.equal(menu.requests[0]!.launchDefault, true);
  assert.equal(menu.selectedRevisionKey, shared.defaults.decisionRequestRevisionId);
});
