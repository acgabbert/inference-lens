import type { DecisionInput } from "../../packages/core/src/decision";
import { createDecisionPromptTemplate } from "../../packages/core/src/decision-template.ts";
import type { DecisionPromptTemplate, ProjectFile } from "../../packages/core/src/project";

/**
 * Publishes a session-only decision prompt as its first persisted revision.
 *
 * The session template's ids carry over, so selection and navigation that
 * already point at it stay valid. Its staged revision is replaced by the
 * reviewed content; any recommendation set during the session is kept.
 */
export function materializeSessionDecisionTemplate(
  project: ProjectFile,
  template: DecisionPromptTemplate,
  content: {
    name: string;
    decision: DecisionInput;
    variableDefaults: Record<string, string>;
    revisionName?: string;
  },
): ProjectFile {
  const created = createDecisionPromptTemplate(project, {
    name: content.name,
    decision: content.decision,
    variableDefaults: content.variableDefaults,
    recommendedTarget: template.recommendedTarget,
    idSuffix: template.id.replace(/^template_/, ""),
    revisionIdSuffix: template.currentRevisionId.replace(/^template-revision_/, ""),
  });
  const revisionName = content.revisionName?.trim();
  if (!revisionName) return created;
  return {
    ...created,
    promptTemplates: created.promptTemplates.map((entry) =>
      entry.id !== template.id || entry.kind !== "decision"
        ? entry
        : { ...entry, revisions: entry.revisions.map((revision) => ({ ...revision, name: revisionName })) },
    ),
  };
}
