import type { DecisionInput } from "./decision.ts";
import {
  parseProjectFile, ProjectValidationError,
  type ProjectFile, type DecisionPromptTemplate, type DecisionPromptTemplateRevision,
  type PromptTemplateRecommendedTarget,
} from "./project.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type { PromptTemplateId, PromptTemplateRevisionId } from "./run-kernel/types.ts";
import { randomUUID } from "./random-id.ts";
import { stableJsonValue } from "./stable-json.ts";

interface DecisionTemplateContent {
  decision: DecisionInput;
  variableDefaults?: Record<string, string>;
}

export interface CreateDecisionPromptTemplateOptions extends DecisionTemplateContent {
  name: string;
  recommendedTarget?: PromptTemplateRecommendedTarget;
  idSuffix?: string;
  revisionIdSuffix?: string;
  createdAt?: string;
}

/** Captures authored content, without changing Compose's active request or target. */
export function createDecisionPromptTemplate(project: ProjectFile, {
  name, decision, variableDefaults = {}, recommendedTarget,
  idSuffix = randomUUID(), revisionIdSuffix = randomUUID(), createdAt = new Date().toISOString(),
}: CreateDecisionPromptTemplateOptions): ProjectFile {
  const revisionId = createEntityId("template-revision", revisionIdSuffix);
  return parseProjectFile({ ...project, promptTemplates: [...project.promptTemplates, {
    kind: "decision", id: createEntityId("template", idSuffix), name, currentRevisionId: revisionId,
    ...(recommendedTarget ? { recommendedTarget: { ...recommendedTarget } } : {}),
    revisions: [{ id: revisionId, createdAt, decision: structuredClone(decision), variableDefaults: { ...variableDefaults } }],
  }] });
}

function findDecisionTemplate(project: ProjectFile, templateId: PromptTemplateId): DecisionPromptTemplate {
  const template = project.promptTemplates.find(({ id }) => id === templateId);
  if (!template || template.kind !== "decision") throw new ProjectValidationError([{
    code: "custom", path: ["promptTemplates", templateId], message: "Expected a decision template.",
  }]);
  return template;
}

function sameContent(before: DecisionTemplateContent, after: DecisionTemplateContent): boolean {
  return JSON.stringify(stableJsonValue({ decision: before.decision, variableDefaults: before.variableDefaults ?? {} }))
    === JSON.stringify(stableJsonValue({ decision: after.decision, variableDefaults: after.variableDefaults ?? {} }));
}

export interface AppendDecisionPromptTemplateRevisionOptions extends DecisionTemplateContent {
  templateId: PromptTemplateId;
  name?: string;
  idSuffix?: string;
  createdAt?: string;
}

export function appendDecisionPromptTemplateRevision(project: ProjectFile, {
  templateId, decision, variableDefaults = {}, name, idSuffix = randomUUID(), createdAt = new Date().toISOString(),
}: AppendDecisionPromptTemplateRevisionOptions): ProjectFile {
  const template = findDecisionTemplate(project, templateId);
  const current = template.revisions.find(({ id }) => id === template.currentRevisionId)!;
  if (sameContent(current, { decision, variableDefaults })) return project;
  const revision: DecisionPromptTemplateRevision = { id: createEntityId("template-revision", idSuffix), createdAt,
    ...(name?.trim() ? { name: name.trim() } : {}), decision: structuredClone(decision), variableDefaults: { ...variableDefaults } };
  return parseProjectFile({ ...project, promptTemplates: project.promptTemplates.map((entry) => entry.id === templateId
    ? { ...template, currentRevisionId: revision.id, draft: undefined, revisions: [...template.revisions, revision] } : entry) });
}

export interface UpdateDecisionPromptTemplateDraftOptions extends DecisionTemplateContent {
  templateId: PromptTemplateId;
  sourceRevisionId: PromptTemplateRevisionId;
  revisionName?: string;
}

/** The same draft envelope as chat; immutable revisions and existing pins stay untouched. */
export function updateDecisionPromptTemplateDraft(project: ProjectFile, {
  templateId, sourceRevisionId, revisionName, decision, variableDefaults = {},
}: UpdateDecisionPromptTemplateDraftOptions): ProjectFile {
  const template = findDecisionTemplate(project, templateId);
  const source = template.revisions.find(({ id }) => id === sourceRevisionId);
  if (!source) throw new ProjectValidationError([{
    code: "custom", path: ["promptTemplates", templateId, "draft", "sourceRevisionId"], message: "Decision draft source revision does not exist.",
  }]);
  const draft = sameContent(source, { decision, variableDefaults }) && !revisionName ? undefined : {
    sourceRevisionId, ...(revisionName ? { revisionName } : {}), decision: structuredClone(decision), variableDefaults: { ...variableDefaults },
  };
  return parseProjectFile({ ...project, promptTemplates: project.promptTemplates.map((entry) =>
    entry.id === templateId ? { ...template, draft } : entry) });
}
