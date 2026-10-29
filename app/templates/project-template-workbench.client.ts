import {
  authoredItemsForMessages,
  resolveProjectRevisionInContext,
  resolveProjectRevisionMessages,
} from "../../packages/core/src/project.ts";
import type {
  ProjectConversationItem,
  ProjectFile,
  ResolvedProjectRevisionInContext,
  TemplateResolutionContext,
} from "../../packages/core/src/project.ts";
import type {
  ConversationMessage,
  ConversationRevisionId,
} from "../../packages/core/src/run-kernel/index.ts";

export interface ProjectTemplateWorkbenchView {
  composerItems: ProjectConversationItem[];
  resolution?: ResolvedProjectRevisionInContext;
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
  resolutionContext: TemplateResolutionContext;
  parentRevisionId: ConversationRevisionId;
  update(items: ProjectConversationItem[]): ProjectConversationItem[];
  /** What the result renders with, when the edit is a change of context. */
  nextResolutionContext?: TemplateResolutionContext;
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
    input.resolutionContext,
  );
  const items = input.update(structuredClone(currentItems));
  return resolveProjectRevisionMessages(
    input.project,
    { ...parent, items },
    input.nextResolutionContext ?? input.resolutionContext,
  );
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
  resolutionContext: TemplateResolutionContext;
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
        input.resolutionContext,
      );
      return {
        composerItems,
        resolution: resolveProjectRevisionInContext(
          input.project,
          { ...parent, items: composerItems },
          input.resolutionContext,
        ),
      };
    }

    return {
      composerItems: activeRevision.items,
      resolution: resolveProjectRevisionInContext(
        input.project,
        activeRevision,
        input.resolutionContext,
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
