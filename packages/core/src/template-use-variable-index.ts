import type { ProjectConversationRevision, PromptTemplate } from "./project.ts";
import type { ConversationRevisionId, PromptTemplateUseId } from "./run-kernel/types.ts";
import { discoverTemplateVariables } from "./template-engine.ts";

export interface TemplateUseVariableOccurrence {
  revisionId: ConversationRevisionId;
  variables: ReadonlySet<string>;
}

/** Indexes the variables exposed by each stable template-use identity. */
export function templateUseVariableIndex(
  revisions: readonly ProjectConversationRevision[],
  templates: readonly PromptTemplate[],
): ReadonlyMap<PromptTemplateUseId, readonly TemplateUseVariableOccurrence[]> {
  const templatesById = new Map(templates.map((template) => [template.id, template]));
  const uses = new Map<PromptTemplateUseId, TemplateUseVariableOccurrence[]>();
  revisions.forEach((revision) => {
    revision.items.forEach((item) => {
      if (item.kind !== "template-use") return;
      const templateRevision = templatesById
        .get(item.use.templateId)
        ?.revisions.find(({ id }) => id === item.use.templateRevisionId);
      if (!templateRevision) return;
      const occurrences = uses.get(item.use.id) ?? [];
      occurrences.push({
        revisionId: revision.id,
        variables: new Set(
          discoverTemplateVariables(templateRevision.messages).variables.map(({ name }) => name),
        ),
      });
      uses.set(item.use.id, occurrences);
    });
  });
  return uses;
}
