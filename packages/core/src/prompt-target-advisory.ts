import type { ProjectConversationRevision, ProjectFile } from "./project.ts";
import type {
  ConnectionRequirementId,
  PromptTemplateId,
  PromptTemplateUseId,
} from "./run-kernel/types.ts";

export interface PromptTargetRecommendation {
  templateUseId: PromptTemplateUseId;
  templateId: PromptTemplateId;
  templateName: string;
  connectionRequirementId: ConnectionRequirementId;
  connectionName: string;
  model: string;
}

export interface PromptTargetAdvisories {
  /** Every recommendation carried by the revision's uses, in authored order. */
  recommendations: PromptTargetRecommendation[];
  /** Recommendations whose model is not the model the evaluation will send. */
  differing: PromptTargetRecommendation[];
  /**
   * The distinct recommended models, in authored order. More than one means the
   * revision's own prompts disagree with each other, which no target can
   * satisfy: a provider call carries one model.
   */
  recommendedModels: string[];
}

/**
 * Compares the advisory target recommendations of a revision's pinned prompts
 * against the target an evaluation will actually send.
 *
 * A recommendation records the target a template was authored against. It is
 * never selection input: one revision may pin several templates while a
 * provider call carries exactly one model, so honouring a recommendation
 * automatically would mean silently picking a winner. This projection therefore
 * only reports disagreement, and only the caller decides how loudly to say it.
 *
 * Comparison is by model. A recommendation's connection is reported for display
 * but not matched, because which local profile serves a project's connection
 * requirement is session state that portable project data cannot see.
 */
export function promptTargetAdvisories(
  project: Pick<ProjectFile, "promptTemplates" | "connectionRequirements">,
  revision: Pick<ProjectConversationRevision, "items">,
  target: { model: string },
): PromptTargetAdvisories {
  const templatesById = new Map(project.promptTemplates.map((template) => [template.id, template]));
  const connectionsById = new Map(
    project.connectionRequirements.map((requirement) => [requirement.id, requirement]),
  );

  const recommendations = revision.items.flatMap((item): PromptTargetRecommendation[] => {
    if (item.kind !== "template-use") return [];
    const template = templatesById.get(item.use.templateId);
    const recommendation = template?.recommendedTarget;
    if (!template || !recommendation) return [];
    return [{
      templateUseId: item.use.id,
      templateId: template.id,
      templateName: template.name,
      connectionRequirementId: recommendation.connectionRequirementId,
      connectionName:
        connectionsById.get(recommendation.connectionRequirementId)?.name ?? "Unknown connection",
      model: recommendation.model,
    }];
  });

  return {
    recommendations,
    differing: recommendations.filter(({ model }) => model !== target.model),
    recommendedModels: [...new Set(recommendations.map(({ model }) => model))],
  };
}
