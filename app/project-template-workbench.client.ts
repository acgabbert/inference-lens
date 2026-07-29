import {
  authoredItemsForMessages,
  resolveProjectRevision,
} from "../packages/core/src/project.ts";
import type {
  ProjectConversationItem,
  ProjectFile,
  ResolvedProjectRevision,
  TemplateRunOverrides,
} from "../packages/core/src/project.ts";
import type {
  ConversationMessage,
  ConversationRevisionId,
} from "../packages/core/src/run-kernel/index.ts";

export interface ProjectTemplateWorkbenchView {
  composerItems: ProjectConversationItem[];
  resolution?: ResolvedProjectRevision;
  resolutionError?: string;
}

/**
 * Applies an authored-item edit to a pending branch without changing the
 * project's active revision. The returned messages remain the branch's local
 * draft until the caller commits them by creating the branch revision.
 */
export function pendingBranchMessagesAfterItemUpdate(input: {
  project: ProjectFile;
  messages: ConversationMessage[];
  runOverrides: TemplateRunOverrides;
  parentRevisionId: ConversationRevisionId;
  update(items: ProjectConversationItem[]): ProjectConversationItem[];
}): ConversationMessage[] {
  const parent = input.project.conversationRevisions.find(
    ({ id }) => id === input.parentRevisionId,
  );
  if (!parent) {
    throw new Error("The pending branch parent no longer exists.");
  }
  const currentItems = authoredItemsForMessages(
    input.project,
    parent,
    input.messages,
    input.runOverrides,
  );
  const items = input.update(structuredClone(currentItems));
  return resolveProjectRevision(
    input.project,
    { ...parent, items },
    input.runOverrides,
  ).messages;
}

/**
 * Derives the template-backed composer and request projection together.
 *
 * A pending branch is not yet part of the project document, so both surfaces
 * must resolve the same synthetic authored revision. Keeping this derivation in
 * one pure boundary prevents the composer and request preview from drifting.
 */
export function projectTemplateWorkbenchView(input: {
  project: ProjectFile | null;
  messages: ConversationMessage[];
  runOverrides: TemplateRunOverrides;
  branchParentRevisionId?: ConversationRevisionId;
}): ProjectTemplateWorkbenchView {
  const literalItems = input.messages.map(
    (message): ProjectConversationItem => ({ kind: "message", message }),
  );
  if (!input.project) return { composerItems: literalItems };

  const activeRevision = input.project.conversationRevisions.find(
    ({ id }) => id === input.project!.defaults.conversationRevisionId,
  );
  if (!activeRevision) {
    return {
      composerItems: literalItems,
      resolutionError: "The active project conversation revision no longer exists.",
    };
  }

  try {
    if (input.branchParentRevisionId) {
      const parent = input.project.conversationRevisions.find(
        ({ id }) => id === input.branchParentRevisionId,
      );
      if (!parent) {
        return {
          composerItems: literalItems,
          resolutionError: "The pending branch parent no longer exists.",
        };
      }
      const composerItems = authoredItemsForMessages(
        input.project,
        parent,
        input.messages,
        input.runOverrides,
      );
      return {
        composerItems,
        resolution: resolveProjectRevision(
          input.project,
          { ...parent, items: composerItems },
          input.runOverrides,
        ),
      };
    }

    return {
      composerItems: activeRevision.items,
      resolution: resolveProjectRevision(
        input.project,
        activeRevision,
        input.runOverrides,
      ),
    };
  } catch (error) {
    return {
      composerItems: literalItems,
      resolutionError:
        error instanceof Error
          ? error.message
          : "Could not resolve the project template draft.",
    };
  }
}
