import type { PromptTemplate } from "../../packages/core/src/project";
import type { PromptTemplateRevisionId } from "../../packages/core/src/run-kernel";
import type { PromptTemplateRevisionDiff } from "../../packages/core/src/prompt-template-revision-diff";
import type { DecisionTemplateRevisionDiff } from "../../packages/core/src/decision-template-revision-diff";

/**
 * The revision's author-supplied name, else its 1-based position, with
 * " (current)" appended for the template's live revision.
 */
export function promptRevisionLabel(
  template: PromptTemplate,
  revisionId: PromptTemplateRevisionId,
): string {
  const index = template.revisions.findIndex(({ id }) => id === revisionId);
  if (index < 0) return "an earlier revision";
  const label = template.revisions[index]!.name?.trim() || promptRevisionPositionLabel(template, revisionId);
  return revisionId === template.currentRevisionId ? `${label} (current)` : label;
}

/** The label an unnamed revision falls back to: its 1-based position. */
export function promptRevisionPositionLabel(
  template: PromptTemplate,
  revisionId: PromptTemplateRevisionId,
): string {
  return `Revision ${template.revisions.findIndex(({ id }) => id === revisionId) + 1}`;
}

/**
 * The revision a diff compares with by default: the one before, so the diff
 * reads as what this revision changed, else the one after for the first.
 */
export function defaultComparedRevisionId(
  template: PromptTemplate,
  revisionId: PromptTemplateRevisionId,
): PromptTemplateRevisionId | undefined {
  const index = template.revisions.findIndex(({ id }) => id === revisionId);
  if (index < 0) return undefined;
  return (template.revisions[index - 1] ?? template.revisions[index + 1])?.id;
}

export type CompatibleSuiteRevisionState =
  | { kind: "current"; label: string }
  | { kind: "outdated"; pinnedLabel: string; targetLabel: string }
  | { kind: "unknown" };

/**
 * Describes what a compatible suite currently pins for this template relative
 * to the revision the user is about to send, so the dialog can say what will
 * change instead of asking the user to already know.
 */
export function describeCompatibleSuiteRevision(
  template: PromptTemplate | undefined,
  pinnedRevisionId: PromptTemplateRevisionId,
  targetRevisionId: PromptTemplateRevisionId,
): CompatibleSuiteRevisionState {
  if (!template) return { kind: "unknown" };
  if (pinnedRevisionId === targetRevisionId) {
    return { kind: "current", label: promptRevisionLabel(template, targetRevisionId) };
  }
  return {
    kind: "outdated",
    pinnedLabel: promptRevisionLabel(template, pinnedRevisionId),
    targetLabel: promptRevisionLabel(template, targetRevisionId),
  };
}

/** "identical" or a comma-joined count of what changed, for a diff disclosure's collapsed summary. */
export function summarizeRevisionDiff(diff: PromptTemplateRevisionDiff): string {
  if (diff.identical) return "identical";
  const messageChanges = diff.messages.filter(({ status }) => status !== "identical").length;
  const defaultChanges = diff.variableDefaults.filter(({ status }) => status !== "identical").length;
  const parts: string[] = [];
  if (messageChanges > 0) {
    parts.push(`${messageChanges} message change${messageChanges === 1 ? "" : "s"}`);
  }
  if (defaultChanges > 0) {
    parts.push(`${defaultChanges} default change${defaultChanges === 1 ? "" : "s"}`);
  }
  if (diff.importProvenance.status !== "identical") parts.push("import link changed");
  return parts.join(", ");
}

/** "identical" or a comma-joined count of what changed between two decision revisions. */
export function summarizeDecisionRevisionDiff(diff: DecisionTemplateRevisionDiff): string {
  if (diff.identical) return "identical";
  const questionChanges = diff.questions.filter(({ status }) => status !== "identical").length;
  const defaultChanges = diff.variableDefaults.filter(({ status }) => status !== "identical").length;
  const parts: string[] = [];
  if (!diff.state.identical) parts.push("state changed");
  if (questionChanges > 0) {
    parts.push(`${questionChanges} question change${questionChanges === 1 ? "" : "s"}`);
  }
  if (diff.questionOrderChanged) parts.push("question order changed");
  if (defaultChanges > 0) {
    parts.push(`${defaultChanges} default change${defaultChanges === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

export interface RevisionVariables {
  variables: readonly string[];
  defaults: Readonly<Record<string, string>>;
}

export interface RevisionVariableChanges {
  added: string[];
  removed: string[];
  /** Saved values or overrides the switch discards because the target lacks the variable. */
  cleared: string[];
  /** Variables that will block a run after the switch but did not before. */
  needsValue: string[];
}

/**
 * What switching a pinned use between revisions does to its variables, so a
 * review can lead with that instead of a full content diff.
 */
export function summarizeRevisionVariableChanges({
  before,
  after,
  kept,
}: {
  before: RevisionVariables;
  after: RevisionVariables;
  /** Variables the use currently holds a saved value or override for. */
  kept: readonly string[];
}): RevisionVariableChanges {
  const had = new Set(before.variables);
  const has = new Set(after.variables);
  const valued = new Set(kept);
  const neededBefore = (name: string) =>
    had.has(name) && !valued.has(name) && !Object.hasOwn(before.defaults, name);
  return {
    added: after.variables.filter((name) => !had.has(name)),
    removed: before.variables.filter((name) => !has.has(name)),
    cleared: kept.filter((name) => !has.has(name)),
    needsValue: after.variables.filter(
      (name) => !valued.has(name) && !Object.hasOwn(after.defaults, name) && !neededBefore(name),
    ),
  };
}
