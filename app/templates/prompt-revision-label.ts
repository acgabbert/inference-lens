import type { PromptTemplate } from "../../packages/core/src/project";
import type { PromptTemplateRevisionId } from "../../packages/core/src/run-kernel";
import type { PromptTemplateRevisionDiff } from "../../packages/core/src/prompt-template-revision-diff";

/** "Current" for the template's live revision, otherwise its 1-based position. */
export function promptRevisionLabel(
  template: PromptTemplate,
  revisionId: PromptTemplateRevisionId,
): string {
  if (revisionId === template.currentRevisionId) return "Current";
  const index = template.revisions.findIndex(({ id }) => id === revisionId);
  return index >= 0 ? `Revision ${index + 1}` : "an earlier revision";
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
