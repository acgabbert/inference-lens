import {
  createBranchRevision,
  projectDraft,
  resolveProjectRevision,
  updateProjectDraft,
} from "../../../packages/core/src/project.ts";
import type {
  ProjectConversationItem,
  ProjectFile,
  ResolvedProjectRevision,
  TemplateRunOverrides,
  UpdateProjectDraft,
} from "../../../packages/core/src/project.ts";
import { buildChatCompletionsRequest } from "../../../packages/core/src/openai-compatible.ts";
import type { RichInferenceRequest } from "../../../packages/core/src/types.ts";
import type {
  ConversationRevisionId,
  PromptTemplateUseId,
  ToolDefinition,
} from "../../../packages/core/src/run-kernel/index.ts";
import { createSingleTurnRunExecution } from "../../../packages/core/src/run-kernel/index.ts";

export interface ProjectTemplateMutationTarget {
  project: ProjectFile;
  revisionId: ConversationRevisionId;
  branched: boolean;
}

/**
 * Selects the immutable revision that an authored template edit may change.
 * A revision which has already run is copied exactly once, then later edits
 * keep targeting that child revision.
 */
export function projectTemplateMutationTarget(input: {
  project: ProjectFile;
  runOverrides: TemplateRunOverrides;
  executedRevisionIds: ReadonlySet<ConversationRevisionId>;
}): ProjectTemplateMutationTarget {
  let project = input.project;
  let revision = project.conversationRevisions.find(
    ({ id }) => id === project.defaults.conversationRevisionId,
  );
  if (!revision) throw new Error("The active project conversation revision no longer exists.");

  if (input.executedRevisionIds.has(revision.id)) {
    project = createBranchRevision(project, {
      conversationId: revision.conversationId,
      parentRevisionId: revision.id,
      messages: resolveProjectRevision(project, revision, input.runOverrides).messages,
      items: structuredClone(revision.items),
    });
    revision = project.conversationRevisions.find(
      ({ id }) => id === project.defaults.conversationRevisionId,
    );
    if (!revision) throw new Error("Could not create a child conversation revision.");
    return { project, revisionId: revision.id, branched: true };
  }

  return { project, revisionId: revision.id, branched: false };
}

export function nextTemplateRunOverrides(
  current: TemplateRunOverrides,
  templateUseId: PromptTemplateUseId,
  values?: Record<string, string>,
): TemplateRunOverrides {
  if (values) return { ...current, [templateUseId]: values };
  const next = { ...current };
  delete next[templateUseId];
  return next;
}

export function updateAuthoredProjectItems(input: {
  project: ProjectFile;
  revisionId: ConversationRevisionId;
  draft: UpdateProjectDraft;
  items: ProjectConversationItem[];
}): ProjectFile {
  return updateProjectDraft(input.project, {
    ...input.draft,
    items: input.items,
  });
}

export type TemplateRequestPreview =
  | { body: unknown; messages: RichInferenceRequest["messages"] }
  | { error: string };

/** Builds the exact provider body shown by the template request preview. */
export function resolvedTemplateRequestPreview(input: {
  request: RichInferenceRequest;
  resolution: ResolvedProjectRevision;
  conversationId: string;
  conversationRevisionId: ConversationRevisionId;
  tools: ToolDefinition[];
}): TemplateRequestPreview {
  try {
    const execution = createSingleTurnRunExecution(
      { ...input.request, messages: input.resolution.messages },
      {
        conversationId: input.conversationId as never,
        conversationRevisionId: input.conversationRevisionId,
      },
      "template-preview",
      "1970-01-01T00:00:00.000Z",
      input.tools,
      input.resolution.templateResolutions,
    );
    return {
      messages: input.resolution.messages,
      body: buildChatCompletionsRequest({
        runId: execution.runId,
        turnId: execution.turnId,
        exchangeId: execution.exchangeId,
        attempt: execution.attempt,
        input: execution.turnInput,
      }).body,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Could not build request preview.",
    };
  }
}

export { projectDraft };
