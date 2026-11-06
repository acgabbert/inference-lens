import { stableJsonValue } from "../../packages/core/src/stable-json.ts";
import { diffLines } from "../../packages/core/src/text-diff.ts";
import type { DiffLine } from "../../packages/core/src/text-diff.ts";
import type {
  MigrationBackupSummary,
  RecoveryAction,
  RecoveryComparison,
  RecoveryEntry,
  WorkbenchAssetRef,
} from "./personal-workbench-controller.ts";

/**
 * What the Recovery chip, drawer and pane marks read
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 6b-2 decisions"). Pure.
 */

export type RecoveryChipState =
  | { kind: "pending"; count: number; label: string }
  /** Nothing pending, but a backup can be removed or its removal finished. */
  | { kind: "backup"; label: string };

/** X1: a count while items are pending, a backup while one is removable, otherwise nothing. */
export function recoveryChip(
  recovery: readonly RecoveryEntry[],
  backups: readonly MigrationBackupSummary[],
): RecoveryChipState | undefined {
  if (recovery.length > 0) return { kind: "pending", count: recovery.length, label: `Recovery · ${recovery.length}` };
  if (backups.some(({ removable, removing }) => removable || removing)) return { kind: "backup", label: "Migration backup" };
  return undefined;
}

/** `prompt:<templateId>`, `suite:<suiteId>`, or the request switcher's `request:<id>` key. */
export function assetTargetKey(asset: WorkbenchAssetRef): string {
  if (asset.kind === "suite") return `suite:${asset.id}`;
  return asset.kind === "chat-prompt" || asset.kind === "decision-prompt" ? `prompt:${asset.id}` : `request:${asset.id}`;
}

/** X3: which prompt, request or local request an item marks; undefined for none. */
export function recoveryTargetKey(item: Pick<RecoveryEntry, "asset" | "path" | "record">): string | undefined {
  if (item.asset) return assetTargetKey(item.asset);
  const scratch = /^scratch\/([^/]+)\.json$/.exec(item.path);
  if (scratch) return `scratch:${scratch[1]}`;
  if (item.record?.kind === "scratch") return `scratch:${item.record.scratchId}`;
  return undefined;
}

export function recoveryTargets(recovery: readonly RecoveryEntry[]): Set<string> {
  const targets = new Set<string>();
  for (const item of recovery) {
    const key = recoveryTargetKey(item);
    if (key) targets.add(key);
  }
  return targets;
}

const ASSET_NOUN: Record<WorkbenchAssetRef["kind"], string> = {
  "chat-prompt": "Prompt",
  "decision-prompt": "Decision prompt",
  "chat-request": "Request",
  "decision-request": "Decision request",
  suite: "Evaluation suite",
};

/** What an item is about, for its heading and its confirmations. */
export function recoverySubject(
  item: Pick<RecoveryEntry, "asset" | "path" | "record">,
  nameOf: (asset: WorkbenchAssetRef) => string | undefined,
): string {
  if (item.asset) {
    const name = nameOf(item.asset);
    return name ? `${ASSET_NOUN[item.asset.kind]} “${name}”` : `${ASSET_NOUN[item.asset.kind]} ${item.asset.id}`;
  }
  if (/^scratch\//.test(item.path) || item.record?.kind === "scratch") return "Local request";
  if (item.path === "selections.json" || item.record?.kind === "selections") return "Your selections";
  return item.path;
}

const KIND_LABEL: Record<RecoveryEntry["kind"], string> = {
  "migration-candidate": "Kept by the upgrade",
  "competing-draft": "Competing draft",
  "replaced-draft": "Replaced draft",
  "record-conflict": "Changed outside this window",
  "orphaned-draft": "Base no longer exists",
  "publication-conflict": "Earlier save needs review",
  "write-failed": "Not saved",
  unreadable: "Cannot be read",
};

export function recoveryKindLabel(kind: RecoveryEntry["kind"]): string {
  return KIND_LABEL[kind];
}

export const RECOVERY_ACTION_LABEL: Record<RecoveryAction, string> = {
  compare: "Compare",
  use: "Use this one",
  discard: "Discard",
  "save-as-new": "Save as new…",
  "keep-as-draft": "Keep as draft",
  retry: "Retry",
};

export interface DiscardConfirmation {
  title: string;
  description: string;
  confirmLabel: string;
}

/**
 * X4: Discard asks first whenever it deletes the only copy of some work. A
 * migration candidate's Discard only records `discarded`; the backup keeps it.
 */
export function discardConfirmation(
  item: Pick<RecoveryEntry, "kind" | "path" | "memory" | "stored">,
  subject: string,
): DiscardConfirmation | undefined {
  const description = (() => {
    switch (item.kind) {
      case "migration-candidate":
      case "unreadable":
      case "write-failed":
        return undefined;
      case "competing-draft":
        return item.memory
          ? "The copy this session kept in memory is deleted. The draft in this folder stays active."
          : "This other draft is deleted from the folder. The active draft stays.";
      case "replaced-draft":
        return "The replaced draft is deleted from the folder. The active draft stays.";
      case "record-conflict":
        return item.memory
          ? "The copy this session kept in memory is deleted. The copy in this folder stays."
          : "This window's copy is deleted, and the copy on disk is kept.";
      case "orphaned-draft":
        return "The draft is deleted. Its base no longer exists, so Save as new is the only other way to keep its edits.";
      case "publication-conflict":
        return "The draft's unsaved edits are deleted. Saved revisions are not changed.";
    }
  })();
  return description ? { title: `Discard ${subject}?`, description, confirmLabel: "Discard" } : undefined;
}

export interface RecoveryDiff {
  /** The current copy's label; undefined when there is nothing to compare against. */
  left?: string;
  right: string;
  lines: DiffLine[];
  truncated: boolean;
}

/** A side with no record, such as a deleted copy, has no lines, so the other side reads as removed or added. */
function formatted(record: unknown): string {
  return record === undefined ? "" : JSON.stringify(stableJsonValue(record), null, 2);
}

/** X2: stable-formatted JSON of both sides as a line diff, the current copy first. */
export function recoveryComparisonDiff(comparison: RecoveryComparison): RecoveryDiff {
  const diff = diffLines(comparison.current ? formatted(comparison.current.record) : "", formatted(comparison.incoming.record));
  return {
    ...(comparison.current ? { left: comparison.current.label } : {}),
    right: comparison.incoming.label,
    lines: comparison.current ? diff.lines : diff.lines.filter(({ kind, text }) => !(kind === "removed" && text === "")),
    truncated: diff.truncated,
  };
}

/** W3: what removing a backup deletes, for its confirmation. */
export function backupRemovalDetails(backup: MigrationBackupSummary): Array<{ label: string; value: string }> {
  const prefix = `migrations/${backup.operationId}/`;
  const relative = backup.files.map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path));
  const replaced = relative.filter((path) => path.startsWith("replaced/"));
  return [
    { label: "Folder", value: `.workbench/${prefix}` },
    { label: "Files", value: relative.filter((path) => !path.startsWith("replaced/")).join(", ") || "None" },
    ...(replaced.length > 0 ? [{ label: "Replaced drafts", value: replaced.join(", ") }] : []),
  ];
}

/** The switcher key of the request a composer edits, as recovery marks name it. */
export function recoveryMenuKey(record: {
  kind: string;
  draft?: { asset: { id: string } };
  scratch?: { scratchId: string };
  revision?: { conversationId: string } | { decisionRequestId: string };
} | undefined): string | undefined {
  if (!record) return undefined;
  if (record.scratch) return `scratch:${record.scratch.scratchId}`;
  if (record.draft) return `request:${record.draft.asset.id}`;
  if (record.revision) return `request:${"conversationId" in record.revision ? record.revision.conversationId : record.revision.decisionRequestId}`;
  return undefined;
}

/** The actions that settle an item; Compare only reads. */
export type SettlingAction = Exclude<RecoveryAction, "compare">;

/**
 * Whether a settled action changed the copy an editor of the asset should
 * show, so an editor that holds its own copy reloads. Discarding the other
 * copy, a replaced draft or a migration candidate leaves the active copy as it
 * was; Retry writes the same content again.
 */
export function changesActiveCopy(item: Pick<RecoveryEntry, "kind" | "memory">, action: SettlingAction): boolean {
  switch (action) {
    case "use":
    case "save-as-new":
    case "keep-as-draft":
      return true;
    case "retry":
      return false;
    case "discard":
      return Boolean(item.memory) || !(item.kind === "competing-draft" || item.kind === "replaced-draft" || item.kind === "migration-candidate");
  }
}

/** What clears an item the drawer offers no action for, such as a file it cannot read. */
export function recoveryGuidance(item: Pick<RecoveryEntry, "path" | "actions">): string | undefined {
  if (item.actions.length > 0) return undefined;
  return `Nothing here can repair this. Fix or remove .workbench/${item.path} on this device, then reopen the project.`;
}
