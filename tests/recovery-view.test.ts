import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationBackupSummary, RecoveryEntry } from "../app/workbench/personal-workbench-controller.ts";
import {
  changesActiveCopy,
  discardConfirmation,
  recoveryChip,
  recoveryComparisonDiff,
  recoveryGuidance,
  recoveryMenuKey,
  recoverySubject,
  recoveryTargetKey,
  recoveryTargets,
} from "../app/workbench/recovery-view.ts";

/**
 * Shared assets 2b step 6b-2 (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 6b-2
 * decisions"): what the Recovery chip, drawer and pane marks read.
 */

function entry(fields: Partial<RecoveryEntry> & Pick<RecoveryEntry, "kind" | "path">): RecoveryEntry {
  return { message: "", id: `${fields.kind}:${fields.path}`, actions: [], ...fields };
}

const backup = (fields: Partial<MigrationBackupSummary>): MigrationBackupSummary => ({
  operationId: "migration_op",
  removable: false,
  removing: false,
  unfinished: false,
  files: [],
  ...fields,
});

const promptAsset = { kind: "chat-prompt", id: "template_triage" } as RecoveryEntry["asset"];
const requestAsset = { kind: "chat-request", id: "conversation_main" } as RecoveryEntry["asset"];

test("X1: the chip counts pending items, falls back to a removable backup, and hides otherwise", () => {
  const items = [entry({ kind: "competing-draft", path: "drafts/a.json" }), entry({ kind: "unreadable", path: "drafts/b.json" })];
  assert.deepEqual(recoveryChip(items, [backup({ removable: true })]), { kind: "pending", count: 2, label: "Recovery · 2" });
  assert.deepEqual(recoveryChip([], [backup({ removable: true })]), { kind: "backup", label: "Migration backup" });
  assert.deepEqual(recoveryChip([], [backup({ removing: true })]), { kind: "backup", label: "Migration backup" });
  // A backup whose candidates still wait for Finish upgrade is not the drawer's to remove.
  assert.equal(recoveryChip([], [backup({ unfinished: true })]), undefined);
  assert.equal(recoveryChip([], []), undefined);
});

test("X3: items mark the prompt, request or local request they belong to", () => {
  assert.equal(recoveryTargetKey(entry({ kind: "orphaned-draft", path: "drafts/d.json", asset: promptAsset })), "prompt:template_triage");
  assert.equal(recoveryTargetKey(entry({ kind: "write-failed", path: "drafts/e.json", asset: requestAsset })), "request:conversation_main");
  assert.equal(recoveryTargetKey(entry({ kind: "record-conflict", path: "scratch/scratch_one.json" })), "scratch:scratch_one");
  assert.equal(recoveryTargetKey(entry({ kind: "record-conflict", path: "selections.json" })), undefined);
  assert.equal(recoveryTargetKey(entry({ kind: "unreadable", path: "migrations" })), undefined);
  const targets = recoveryTargets([
    entry({ kind: "migration-candidate", path: "migrations/m/drafts/x.json", asset: promptAsset }),
    entry({ kind: "competing-draft", path: "drafts/y.json", asset: promptAsset }),
    entry({ kind: "record-conflict", path: "selections.json" }),
  ]);
  assert.deepEqual([...targets], ["prompt:template_triage"]);
});

test("items name their asset from the project, and fall back to what they are", () => {
  const names = (asset: NonNullable<RecoveryEntry["asset"]>) => (asset.id === "template_triage" ? "Incident triage" : undefined);
  assert.equal(recoverySubject(entry({ kind: "competing-draft", path: "drafts/a.json", asset: promptAsset }), names), "Prompt “Incident triage”");
  assert.equal(recoverySubject(entry({ kind: "orphaned-draft", path: "drafts/b.json", asset: requestAsset }), names), "Request conversation_main");
  assert.equal(recoverySubject(entry({ kind: "record-conflict", path: "scratch/scratch_one.json" }), names), "Local request");
  assert.equal(recoverySubject(entry({ kind: "record-conflict", path: "selections.json" }), names), "Your selections");
  assert.equal(recoverySubject(entry({ kind: "unreadable", path: "drafts/broken.json" }), names), "drafts/broken.json");
});

test("X4: Discard asks first unless the backup keeps the copy", () => {
  assert.equal(discardConfirmation(entry({ kind: "migration-candidate", path: "migrations/m/drafts/x.json" }), "Prompt “A”"), undefined);
  for (const item of [
    entry({ kind: "competing-draft", path: "drafts/a.json", memory: true }),
    entry({ kind: "competing-draft", path: "drafts/b.json", stored: true }),
    entry({ kind: "replaced-draft", path: "replaced/c.json" }),
    entry({ kind: "record-conflict", path: "drafts/d.json" }),
    entry({ kind: "record-conflict", path: "selections.json", memory: true }),
    entry({ kind: "orphaned-draft", path: "drafts/e.json" }),
    entry({ kind: "publication-conflict", path: "drafts/f.json" }),
  ]) {
    const request = discardConfirmation(item, "Prompt “A”");
    assert.ok(request, `${item.kind} ${item.path} should confirm`);
    assert.equal(request.title, "Discard Prompt “A”?");
    assert.match(request.description, /\S/);
  }
  assert.match(discardConfirmation(entry({ kind: "record-conflict", path: "drafts/d.json" }), "X")!.description, /copy on disk/);
});

test("X2: Compare is a line diff of stable JSON, current on the left", () => {
  const diff = recoveryComparisonDiff({
    incoming: { label: "From the migration backup", record: { b: 2, a: "new" } },
    current: { label: "Active draft", record: { a: "old", b: 2 } },
  });
  assert.equal(diff.left, "Active draft");
  assert.equal(diff.right, "From the migration backup");
  assert.deepEqual(diff.lines.filter(({ kind }) => kind !== "context").map(({ kind, text }) => `${kind} ${text.trim()}`), [
    "removed \"a\": \"old\",",
    "added \"a\": \"new\",",
  ]);
  const alone = recoveryComparisonDiff({ incoming: { label: "Draft", record: { a: 1 } } });
  assert.equal(alone.left, undefined);
  assert.ok(alone.lines.every(({ kind }) => kind === "added"));
});

test("X3: a composer's selected request names the same key its marks use", () => {
  assert.equal(recoveryMenuKey({ kind: "saved", revision: { conversationId: "conversation_main" } }), "request:conversation_main");
  assert.equal(recoveryMenuKey({ kind: "draft", draft: { asset: { id: "decision-request_a" } }, revision: { decisionRequestId: "decision-request_a" } }), "request:decision-request_a");
  assert.equal(recoveryMenuKey({ kind: "scratch", scratch: { scratchId: "scratch_one" } }), "scratch:scratch_one");
  assert.equal(recoveryMenuKey({ kind: "none" }), undefined);
  assert.equal(recoveryMenuKey(undefined), undefined);
});

test("a settled action reloads an editor only when it changed the asset's active copy", () => {
  for (const action of ["use", "save-as-new", "keep-as-draft"] as const) {
    assert.equal(changesActiveCopy(entry({ kind: "competing-draft", path: "drafts/a.json" }), action), true, action);
  }
  assert.equal(changesActiveCopy(entry({ kind: "write-failed", path: "drafts/a.json" }), "retry"), false);
  // Discarding the other copy leaves the active one as it was.
  assert.equal(changesActiveCopy(entry({ kind: "competing-draft", path: "drafts/a.json", stored: true }), "discard"), false);
  assert.equal(changesActiveCopy(entry({ kind: "replaced-draft", path: "replaced/b.json" }), "discard"), false);
  assert.equal(changesActiveCopy(entry({ kind: "migration-candidate", path: "migrations/m/drafts/c.json" }), "discard"), false);
  // Discarding this session's copy, the draft itself or this window's copy changes what an editor should show.
  assert.equal(changesActiveCopy(entry({ kind: "competing-draft", path: "drafts/a.json", memory: true }), "discard"), true);
  assert.equal(changesActiveCopy(entry({ kind: "orphaned-draft", path: "drafts/d.json" }), "discard"), true);
  assert.equal(changesActiveCopy(entry({ kind: "publication-conflict", path: "drafts/e.json" }), "discard"), true);
  assert.equal(changesActiveCopy(entry({ kind: "record-conflict", path: "drafts/f.json" }), "discard"), true);
});

test("an item with no action says how to clear it", () => {
  assert.match(recoveryGuidance(entry({ kind: "unreadable", path: "drafts/broken.json" }))!, /\.workbench\/drafts\/broken\.json/);
  assert.equal(recoveryGuidance(entry({ kind: "competing-draft", path: "drafts/a.json", actions: ["compare", "use", "discard"] })), undefined);
});
