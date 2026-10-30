import type { ExternalPromptCandidate } from "./external-prompt-import.ts";
import {
  externalPromptRevisionAddition,
  projectExternalPromptTemplate,
  type ExternalPromptTemplateProjection,
  type ExternalTemplateVariableProjection,
} from "./external-prompt-project.ts";
import {
  parseProjectFile,
  type ChatPromptTemplate,
  type ChatPromptTemplateRevision,
  type ExternalImportReceipt,
  type ProjectFile,
  type PromptTemplateMessages,
} from "./project.ts";
import { stableJsonValue } from "./stable-json.ts";
import { discoverTemplateVariables } from "./template-engine.ts";
import type { PromptTemplateId, PromptTemplateRevisionId } from "./run-kernel/types.ts";
import { n8nExpressionIdentity } from "../../n8n/src/expression-naming.ts";
import { sourceFileBasename } from "./source-root-rules.ts";

export interface FilePromptUpdateVariable extends ExternalTemplateVariableProjection {
  /** True when an earlier pull already gave this expression its name. */
  reused: boolean;
}

/**
 * What a pull would append, and how it relates to the last pull and to the
 * current revision. Text, role, interpretation and filename differences are
 * reported separately; none of them is inferred from the receipt digest.
 */
export interface FilePromptUpdatePlan {
  candidate: ExternalPromptCandidate;
  projection: ExternalPromptTemplateProjection;
  messages: PromptTemplateMessages;
  variableDefaults: Record<string, string>;
  variables: FilePromptUpdateVariable[];
  lastPulled: { receipt: ExternalImportReceipt; revision: ChatPromptTemplateRevision };
  current: ChatPromptTemplateRevision;
  /** Revisions saved after the last pull, in order; the pull supersedes them as current. */
  localRevisionIds: PromptTemplateRevisionId[];
  textChanged: boolean;
  roleChanged: boolean;
  interpretationChanged: boolean;
  filenameChanged: boolean;
  /** False when the result would equal the current revision. */
  wouldChange: boolean;
  /** Why reusing a name would be unsafe; the pull cannot be applied. */
  blocked?: string;
}

/** A template's own whole-file receipts, in import order. */
export function filePromptReceipts(
  project: Pick<ProjectFile, "externalImports">,
  templateId: PromptTemplateId,
): ExternalImportReceipt[] {
  return project.externalImports.filter((receipt) =>
    receipt.source.adapter === "file" &&
    receipt.projection.kind === "prompt-template" &&
    receipt.projection.templateId === templateId,
  );
}

function mappedVariables(receipt: ExternalImportReceipt): ExternalTemplateVariableProjection[] {
  return receipt.projection.kind === "prompt-template" ? receipt.projection.variables : [];
}

function variableNames(messages: PromptTemplateMessages): Set<string> {
  return new Set(discoverTemplateVariables(messages).variables.map(({ name }) => name));
}

/** A checkout's line endings are not drift: CRLF and lone CR compare as LF. */
export function comparableText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function comparableMessages(messages: PromptTemplateMessages) {
  return messages.map(({ role, content }) => ({ role, content: comparableText(content) }));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

function trackedTemplate(project: ProjectFile, templateId: PromptTemplateId): ChatPromptTemplate {
  const template = project.promptTemplates.find(({ id }) => id === templateId);
  if (!template || template.kind !== "chat") throw new Error("Choose a saved chat prompt to update.");
  if (template.archivedAt) throw new Error("Restore this prompt before updating it from a file.");
  return template;
}

/**
 * True when a revision that is not a file pull uses `name` after a pulled
 * revision that lacked it. That local use may mean something else, so handing
 * the name back to its historical expression would change saved inputs.
 */
function locallyReintroduced(
  template: ChatPromptTemplate,
  receipts: ReadonlyMap<string, ExternalImportReceipt>,
  name: string,
): boolean {
  let pulledHad: boolean | undefined;
  for (const revision of template.revisions) {
    const receipt = revision.externalImportId ? receipts.get(revision.externalImportId) : undefined;
    if (receipt) {
      pulledHad = mappedVariables(receipt).some(({ variableName }) => variableName === name);
    } else if (pulledHad === false && variableNames(revision.messages).has(name)) {
      return true;
    }
  }
  return false;
}

/** Pure preview of a pull into an existing file-tracked prompt. */
export function planFilePromptUpdate(
  project: ProjectFile,
  templateId: PromptTemplateId,
  candidate: ExternalPromptCandidate,
): FilePromptUpdatePlan {
  if (candidate.source.adapter !== "file" || candidate.authored.length !== 1) {
    throw new Error("Update from file requires one whole-file prompt.");
  }
  const template = trackedTemplate(project, templateId);
  const receipts = filePromptReceipts(project, templateId);
  const lastReceipt = receipts.at(-1);
  const lastRevision = template.revisions.find(({ id }) =>
    lastReceipt?.projection.kind === "prompt-template" && id === lastReceipt.projection.templateRevisionId,
  );
  if (!lastReceipt || !lastRevision) throw new Error("This prompt is not tracked from a file.");
  const current = template.revisions.find(({ id }) => id === template.currentRevisionId)!;

  const namesByExpression = new Map<string, Set<string>>();
  const expressionsByName = new Map<string, Set<string>>();
  const priorNames = new Map<string, string>();
  for (const receipt of receipts) {
    for (const { expression, variableName } of mappedVariables(receipt)) {
      const key = n8nExpressionIdentity(expression).key;
      if (!priorNames.has(key)) priorNames.set(key, variableName);
      namesByExpression.set(key, (namesByExpression.get(key) ?? new Set()).add(variableName));
      expressionsByName.set(variableName, (expressionsByName.get(variableName) ?? new Set()).add(key));
    }
  }
  // Receipts alone are not the whole history: removing a revision removes its
  // receipt. Every name still in use anywhere for this prompt stays reserved.
  const reserved = new Set(expressionsByName.keys());
  for (const revision of template.revisions) variableNames(revision.messages).forEach((name) => reserved.add(name));
  if (template.draft) variableNames(template.draft.messages).forEach((name) => reserved.add(name));
  for (const revision of project.conversationRevisions) {
    for (const item of revision.items) {
      if (item.kind === "template-use" && item.use.templateId === templateId) {
        Object.keys(item.use.values).forEach((name) => reserved.add(name));
      }
    }
  }

  const projection = projectExternalPromptTemplate(candidate, { priorNames, reserved });
  const receiptsById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const ambiguous = new Set<string>();
  const reintroduced = new Set<string>();
  const variables = projection.variables.map((variable): FilePromptUpdateVariable => {
    const key = n8nExpressionIdentity(variable.expression).key;
    const reused = namesByExpression.has(key);
    if (reused) {
      if (namesByExpression.get(key)!.size > 1 || (expressionsByName.get(variable.variableName)?.size ?? 0) > 1) {
        ambiguous.add(variable.variableName);
      } else if (locallyReintroduced(template, receiptsById, variable.variableName)) {
        reintroduced.add(variable.variableName);
      }
    }
    return { ...variable, reused };
  });
  const list = (names: Set<string>) => [...names].map((name) => `{{${name}}}`).join(", ");
  const problems = [
    ...(ambiguous.size ? [`Earlier pulls mapped ${list(ambiguous)} to more than one n8n expression.`] : []),
    ...(reintroduced.size ? [`A local revision uses ${list(reintroduced)} after the file had dropped it, so reusing the name could change what saved inputs mean.`] : []),
  ];

  const used = new Set(projection.variables.map(({ variableName }) => variableName));
  const variableDefaults = Object.fromEntries(
    Object.entries(current.variableDefaults).filter(([name]) => used.has(name)),
  );
  const authored = candidate.authored[0]!;
  const lastAuthored = lastReceipt.authored[0]!;
  return {
    candidate,
    projection,
    messages: projection.messages,
    variableDefaults,
    variables,
    lastPulled: { receipt: lastReceipt, revision: lastRevision },
    current,
    localRevisionIds: template.revisions
      .slice(template.revisions.indexOf(lastRevision) + 1)
      .map(({ id }) => id),
    textChanged: comparableText(authored.text) !== comparableText(lastAuthored.text),
    roleChanged: authored.role !== lastAuthored.role,
    interpretationChanged: candidate.invocation.version !== lastReceipt.invocation.version,
    // Basenames, so a linked pull after a bare-filename import does not warn.
    filenameChanged:
      sourceFileBasename(candidate.source.resource.id) !== sourceFileBasename(lastReceipt.source.resource.id),
    wouldChange:
      !sameJson(comparableMessages(projection.messages), comparableMessages(current.messages)) ||
      !sameJson(variableDefaults, current.variableDefaults),
    ...(problems.length
      ? { blocked: `${problems.join(" ")} Rename it in a new revision, or import the file as a new prompt.` }
      : {}),
  };
}

/**
 * Appends the pulled revision with its receipt and makes it current. The
 * template's draft keeps its source revision and edits, and pinned uses stay
 * where they are.
 */
export async function applyFilePromptUpdate(
  projectValue: ProjectFile,
  templateId: PromptTemplateId,
  candidate: ExternalPromptCandidate,
  options: { importedAt?: string; importerVersion?: number } = {},
): Promise<{ project: ProjectFile; revisionId: PromptTemplateRevisionId }> {
  const project = parseProjectFile(projectValue);
  const plan = planFilePromptUpdate(project, templateId, candidate);
  if (plan.blocked) throw new Error(plan.blocked);
  if (!plan.wouldChange) throw new Error("The current revision already matches this file.");
  const { revision, receipt } = await externalPromptRevisionAddition(
    project,
    templateId,
    candidate,
    plan.projection,
    { ...options, variableDefaults: plan.variableDefaults },
  );
  const next = parseProjectFile({
    ...project,
    // Not appendPromptTemplateRevision: that clears the draft.
    promptTemplates: project.promptTemplates.map((template) =>
      template.id === templateId && template.kind === "chat"
        ? { ...template, currentRevisionId: revision.id, revisions: [...template.revisions, revision] }
        : template,
    ),
    externalImports: [...project.externalImports, receipt],
  });
  return { project: next, revisionId: revision.id };
}
