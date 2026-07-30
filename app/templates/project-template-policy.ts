import {
  createBranchRevision,
  resolveProjectRevision,
} from "../../packages/core/src/project.ts";
import type {
  ProjectFile,
  TemplateRunOverrides,
} from "../../packages/core/src/project.ts";
import type {
  ConversationRevisionId,
  PromptTemplateUseId,
} from "../../packages/core/src/run-kernel/index.ts";

/**
 * Selects the authored revision that a template mutation may update.
 *
 * An executed revision is immutable from the workbench's perspective: the
 * first subsequent edit creates a branch containing its resolved messages.
 */
export function projectForTemplateMutation(input: {
  project: ProjectFile;
  executedRevisionIds: ReadonlySet<ConversationRevisionId>;
  runOverrides: TemplateRunOverrides;
}): { project: ProjectFile; revisionId: ConversationRevisionId } {
  let project = input.project;
  let revision = project.conversationRevisions.find(
    ({ id }) => id === project.defaults.conversationRevisionId,
  )!;
  if (input.executedRevisionIds.has(revision.id)) {
    project = createBranchRevision(project, {
      conversationId: revision.conversationId,
      parentRevisionId: revision.id,
      messages: resolveProjectRevision(
        project,
        revision,
        input.runOverrides,
      ).messages,
      items: structuredClone(revision.items),
    });
    revision = project.conversationRevisions.find(
      ({ id }) => id === project.defaults.conversationRevisionId,
    )!;
  }
  return { project, revisionId: revision.id };
}

export function templateRunOverridesAfterUpdate(
  overrides: TemplateRunOverrides,
  templateUseId: PromptTemplateUseId,
  values: Record<string, string>,
): TemplateRunOverrides {
  return { ...overrides, [templateUseId]: values };
}

/** Keeps only non-empty transient overrides after a saved-value mutation. */
export function templateRunOverridesAfterSave(
  overrides: TemplateRunOverrides,
  templateUseId: PromptTemplateUseId,
  values: Record<string, string>,
): TemplateRunOverrides {
  const next = { ...overrides };
  if (Object.keys(values).length > 0) next[templateUseId] = values;
  else delete next[templateUseId];
  return next;
}
