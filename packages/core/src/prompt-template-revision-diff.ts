import { diffLines, type TextDiff } from "./text-diff.ts";
import type {
  PromptTemplateMessage,
  PromptTemplateRevision,
} from "./project.ts";

export type RevisionDiffStatus = "identical" | "added" | "removed" | "changed";

export interface PromptTemplateMessageDiff {
  index: number;
  status: RevisionDiffStatus;
  before?: PromptTemplateMessage;
  after?: PromptTemplateMessage;
  roleChanged: boolean;
  content: TextDiff;
}

export interface PromptTemplateVariableDefaultDiff {
  name: string;
  status: RevisionDiffStatus;
  before?: string;
  after?: string;
}

export interface PromptTemplateRevisionDiff {
  identical: boolean;
  messages: PromptTemplateMessageDiff[];
  variableDefaults: PromptTemplateVariableDefaultDiff[];
  importProvenance: {
    status: RevisionDiffStatus;
    beforePresent: boolean;
    afterPresent: boolean;
  };
}

function statusFor<T>(before: T | undefined, after: T | undefined): RevisionDiffStatus {
  if (before === undefined && after === undefined) return "identical";
  if (before === undefined) return "added";
  if (after === undefined) return "removed";
  return before === after ? "identical" : "changed";
}

/**
 * Compares immutable prompt revisions without flattening their message
 * boundaries. Message position is deliberately part of the comparison: an
 * otherwise identical message moved to another turn is a prompt change.
 */
export function diffPromptTemplateRevisions(
  before: PromptTemplateRevision,
  after: PromptTemplateRevision,
): PromptTemplateRevisionDiff {
  const messages = Array.from(
    { length: Math.max(before.messages.length, after.messages.length) },
    (_, index): PromptTemplateMessageDiff => {
      const left = before.messages[index];
      const right = after.messages[index];
      const roleChanged = left !== undefined && right !== undefined && left.role !== right.role;
      const content = diffLines(left?.content ?? "", right?.content ?? "");
      return {
        index,
        status: left === undefined
          ? "added"
          : right === undefined
            ? "removed"
            : roleChanged || !content.identical
              ? "changed"
              : "identical",
        before: left,
        after: right,
        roleChanged,
        content,
      };
    },
  );
  const names = new Set([
    ...Object.keys(before.variableDefaults),
    ...Object.keys(after.variableDefaults),
  ]);
  const variableDefaults = [...names].sort((left, right) => left.localeCompare(right)).map((name) => {
    const left = before.variableDefaults[name];
    const right = after.variableDefaults[name];
    return { name, status: statusFor(left, right), before: left, after: right };
  });
  const importProvenance = {
    status: statusFor(before.externalImportId, after.externalImportId),
    beforePresent: before.externalImportId !== undefined,
    afterPresent: after.externalImportId !== undefined,
  };
  return {
    identical: messages.every(({ status }) => status === "identical")
      && variableDefaults.every(({ status }) => status === "identical")
      && importProvenance.status === "identical",
    messages,
    variableDefaults,
    importProvenance,
  };
}
