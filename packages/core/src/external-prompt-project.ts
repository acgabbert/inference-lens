import {
  computeExternalPromptSourceDigest,
  parseExternalPromptCandidate,
} from "./external-prompt-import.ts";
import type {
  ExternalPromptCandidate,
  ExpressionBinding,
} from "./external-prompt-import.ts";
import {
  isSensitiveTemplateVariableName,
  parseProjectFile,
} from "./project.ts";
import type {
  ExternalImportReceipt,
  ProjectFile,
  ProjectConversationItem,
  PromptTemplateMessages,
} from "./project.ts";
import { createEntityId } from "./run-kernel/types.ts";
import {
  allocateN8nVariableName,
  n8nExpressionIdentity,
  suggestN8nExpressionName,
} from "../../n8n/src/expression-naming.ts";
import type {
  ConversationRevisionId,
  ExternalImportId,
  MessageId,
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
} from "./run-kernel/types.ts";

export const EXTERNAL_PROMPT_IMPORTER_VERSION = 1;

export interface ImportExternalPromptOptions {
  importedAt?: string;
  importerVersion?: number;
}

export interface ImportExternalPromptTemplateOptions
  extends ImportExternalPromptOptions {
  /**
   * Records the source execution's model as the new template's recommended
   * target, paired with the project's default connection requirement.
   *
   * Opt-in, and false by default, because the pairing is an assertion the
   * importer cannot verify: the model comes from the external execution's own
   * provider, while the connection is one this project already owns. Callers
   * that offer it should show the exact pair being recorded.
   */
  recommendModel?: boolean;
}

export interface ImportedExternalPrompt {
  project: ProjectFile;
  externalImportId: ExternalImportId;
  conversationRevisionId: ConversationRevisionId;
  messageIds: MessageId[];
}

export interface ExternalTemplateVariableProjection {
  bindingIndex: number;
  authoredPath: string;
  expression: string;
  variableName: string;
}

export interface ExternalPromptTemplateProjection {
  name: string;
  messages: PromptTemplateMessages;
  values: Record<string, string>;
  variables: ExternalTemplateVariableProjection[];
}

export interface ImportedExternalPromptTemplate {
  project: ProjectFile;
  externalImportId: ExternalImportId;
  conversationRevisionId: ConversationRevisionId;
  templateId: PromptTemplateId;
  templateRevisionId: PromptTemplateRevisionId;
  templateUseId: PromptTemplateUseId;
  messageIds: MessageId[];
}

function occupiedMessageIds(project: ProjectFile): Set<string> {
  return new Set(
    project.conversationRevisions.flatMap((revision) =>
      revision.items.flatMap((item) =>
        item.kind === "message"
          ? [item.message.id]
          : item.use.outputMessageIds,
      ),
    ),
  );
}

function collisionSafeSuffix(
  project: ProjectFile,
  digest: string,
  messageCount: number,
): string {
  const receiptIds = new Set(project.externalImports.map(({ id }) => id));
  const revisionIds = new Set(
    project.conversationRevisions.map(({ id }) => id),
  );
  const messageIds = occupiedMessageIds(project);
  const base = digest.slice(0, 16);
  for (let occurrence = 1; ; occurrence += 1) {
    const suffix = occurrence === 1 ? base : `${base}-${occurrence}`;
    const receiptId = createEntityId("external-import", suffix);
    const revisionId = createEntityId("revision", `import-${suffix}`);
    const candidateMessageIds = Array.from({ length: messageCount }, (_, index) =>
      createEntityId("message", `import-${suffix}-${index + 1}`),
    );
    if (
      !receiptIds.has(receiptId) &&
      !revisionIds.has(revisionId) &&
      candidateMessageIds.every((id) => !messageIds.has(id))
    ) {
      return suffix;
    }
  }
}

function templateCollisionSafeSuffix(
  project: ProjectFile,
  digest: string,
  messageCount: number,
): string {
  const receiptIds = new Set(project.externalImports.map(({ id }) => id));
  const revisionIds = new Set(
    project.conversationRevisions.map(({ id }) => id),
  );
  const templateIds = new Set(project.promptTemplates.map(({ id }) => id));
  const templateRevisionIds = new Set(
    project.promptTemplates.flatMap(({ revisions }) =>
      revisions.map(({ id }) => id),
    ),
  );
  const templateUseIds = new Set(
    project.conversationRevisions.flatMap(({ items }) =>
      items.flatMap((item) =>
        item.kind === "template-use" ? [item.use.id] : [],
      ),
    ),
  );
  const messageIds = occupiedMessageIds(project);
  const base = digest.slice(0, 16);
  for (let occurrence = 1; ; occurrence += 1) {
    const suffix = occurrence === 1 ? base : `${base}-${occurrence}`;
    if (
      !receiptIds.has(createEntityId("external-import", suffix)) &&
      !revisionIds.has(createEntityId("revision", `import-${suffix}`)) &&
      !templateIds.has(createEntityId("template", `import-${suffix}`)) &&
      !templateRevisionIds.has(
        createEntityId("template-revision", `import-${suffix}-1`),
      ) &&
      !templateUseIds.has(
        createEntityId("template-use", `import-${suffix}`),
      ) &&
      Array.from({ length: messageCount }, (_, index) =>
        createEntityId("message", `import-${suffix}-${index + 1}`),
      ).every((id) => !messageIds.has(id))
    ) {
      return suffix;
    }
  }
}

/**
 * Groups bindings that should share one native template variable.
 *
 * Identical expression text is treated as one variable. This is a deliberate
 * approximation, not an equivalence proof: the same n8n expression evaluated at
 * two points in a run can legitimately yield different values, so collapsing
 * them loses that distinction. It is accepted because a reusable template is
 * more useful with one named variable than with several identical-looking ones,
 * and because the loss is bounded — {@link projectExternalPromptTemplate} only
 * carries a captured value across when every binding mapped to the variable
 * resolved to the same string, and the authored expressions remain verbatim in
 * the import receipt either way.
 */
function bindingKey(binding: ExpressionBinding): string {
  return n8nExpressionIdentity(binding.expression).key;
}

export function projectExternalPromptTemplate(
  candidateValue: ExternalPromptCandidate,
): ExternalPromptTemplateProjection {
  const candidate = parseExternalPromptCandidate(candidateValue);
  if (candidate.authored.some(({ role }) => !role)) {
    throw new Error(
      "Authored template fields require an explicit message role.",
    );
  }

  const usedNames = new Set<string>();
  const variableByExpression = new Map<string, string>();
  const fallbackIndex = { value: 0 };
  const variables = candidate.bindings.map((binding, bindingIndex) => {
    const key = bindingKey(binding);
    let variableName = variableByExpression.get(key);
    if (!variableName) {
      const suggestion = suggestN8nExpressionName(
        binding.expression,
        isSensitiveTemplateVariableName,
      );
      variableName = allocateN8nVariableName(
        suggestion.name,
        usedNames,
        fallbackIndex,
      );
      variableByExpression.set(key, variableName);
    }
    return {
      bindingIndex,
      authoredPath: binding.authoredPath,
      expression: binding.expression,
      variableName,
    };
  });

  const variableByBindingIndex = new Map(
    variables.map(({ bindingIndex, variableName }) => [
      bindingIndex,
      variableName,
    ]),
  );
  const messages = candidate.authored.map((field) => {
    const contentStart = field.contentSpan?.startOffset ?? 0;
    const contentEnd = field.contentSpan?.endOffset ?? field.text.length;
    const indexedBindings = candidate.bindings
      .map((binding, bindingIndex) => ({ binding, bindingIndex }))
      .filter(({ binding }) => binding.authoredPath === field.path);
    if (
      field.syntax === "external-expression" &&
      indexedBindings.length === 0
    ) {
      throw new Error(
        `Authored field "${field.path}" has no safely parsed expression bindings.`,
      );
    }
    const wholeField = indexedBindings.find(
      ({ binding }) => binding.source.kind === "whole-field",
    );
    let content: string;
    if (wholeField) {
      content = `{{${variableByBindingIndex.get(wholeField.bindingIndex)!}}}`;
    } else {
      const ordered = indexedBindings.sort((left, right) => {
        const leftStart =
          left.binding.source.kind === "expression-span"
            ? left.binding.source.startOffset
            : 0;
        const rightStart =
          right.binding.source.kind === "expression-span"
            ? right.binding.source.startOffset
            : 0;
        return leftStart - rightStart;
      });
      let cursor = contentStart;
      const parts: string[] = [];
      for (const { binding, bindingIndex } of ordered) {
        if (binding.source.kind !== "expression-span") continue;
        parts.push(field.text.slice(cursor, binding.source.startOffset));
        parts.push(`{{${variableByBindingIndex.get(bindingIndex)!}}}`);
        cursor = binding.source.endOffset;
      }
      parts.push(field.text.slice(cursor, contentEnd));
      content = parts.join("");
    }
    return {
      role: field.role!,
      content,
    };
  });

  const values: Record<string, string> = {};
  for (const variableName of usedNames) {
    const mappedBindings = variables
      .filter((variable) => variable.variableName === variableName)
      .map((variable) => candidate.bindings[variable.bindingIndex]!);
    const resolvedValues = mappedBindings.map((binding) =>
      binding.status === "resolved" && typeof binding.resolvedValue === "string"
        ? binding.resolvedValue
        : undefined,
    );
    if (
      resolvedValues.length > 0 &&
      resolvedValues.every(
        (value) => value !== undefined && value === resolvedValues[0],
      )
    ) {
      values[variableName] = resolvedValues[0]!;
    }
  }

  return {
    name: candidate.source.resource.name
      ? `${candidate.source.resource.name} — ${candidate.invocation.name}`
      : candidate.invocation.name,
    messages: messages as PromptTemplateMessages,
    values,
    variables,
  };
}

export function canImportExternalPromptAsTemplate(
  candidate: ExternalPromptCandidate | undefined,
): boolean {
  if (!candidate) return false;
  try {
    projectExternalPromptTemplate(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Imports one reviewed, execution-backed candidate as literal messages on a
 * new active conversation revision. It never changes connection/model choices
 * and never introduces external syntax into the run-kernel message contract.
 */
export async function importExternalPromptCandidate(
  projectValue: ProjectFile,
  candidateValue: ExternalPromptCandidate,
  {
    importedAt = new Date().toISOString(),
    importerVersion = EXTERNAL_PROMPT_IMPORTER_VERSION,
  }: ImportExternalPromptOptions = {},
): Promise<ImportedExternalPrompt> {
  const project = parseProjectFile(projectValue);
  const candidate = parseExternalPromptCandidate(candidateValue);
  const expectedDigest = await computeExternalPromptSourceDigest(candidate);
  if (candidate.sourceDigest !== expectedDigest) {
    throw new Error(
      "External prompt candidate digest does not match its source evidence.",
    );
  }
  if (!candidate.resolved || candidate.fidelity === "authored-only") {
    throw new Error(
      "Only candidates with an execution-backed resolved snapshot can be imported.",
    );
  }

  const activeRevision = project.conversationRevisions.find(
    ({ id }) => id === project.defaults.conversationRevisionId,
  );
  if (!activeRevision) {
    throw new Error("Project has no active conversation revision.");
  }

  const suffix = collisionSafeSuffix(
    project,
    candidate.sourceDigest,
    candidate.resolved.messages.length,
  );
  const externalImportId = createEntityId("external-import", suffix);
  const conversationRevisionId = createEntityId(
    "revision",
    `import-${suffix}`,
  );
  const messageIds = candidate.resolved.messages.map((_, index) =>
    createEntityId("message", `import-${suffix}-${index + 1}`),
  );
  const items: ProjectConversationItem[] = candidate.resolved.messages.map(
    (message, index) => ({
      kind: "message",
      externalImportId,
      message: {
        id: messageIds[index]!,
        role: message.role,
        content: [{ type: "text", text: message.content }],
      },
    }),
  );
  const receipt: ExternalImportReceipt = {
    id: externalImportId,
    source: structuredClone(candidate.source),
    invocation: structuredClone(candidate.invocation),
    authored: structuredClone(candidate.authored),
    bindings: structuredClone(candidate.bindings),
    importedAt,
    importerVersion,
    sourceDigest: candidate.sourceDigest,
    fidelity: candidate.fidelity,
    warnings: structuredClone(candidate.warnings),
    projection: { kind: "literal-messages" },
  };

  const imported = parseProjectFile({
    ...project,
    conversationRevisions: [
      ...project.conversationRevisions,
      {
        id: conversationRevisionId,
        conversationId: activeRevision.conversationId,
        parentRevisionId: activeRevision.id,
        items,
        createdAt: importedAt,
      },
    ],
    externalImports: [...project.externalImports, receipt],
    defaults: {
      ...project.defaults,
      conversationRevisionId,
    },
  });
  return {
    project: imported,
    externalImportId,
    conversationRevisionId,
    messageIds,
  };
}

/**
 * Projects authored external expression regions into a project-owned native
 * template. External syntax remains receipt evidence and is never executable.
 */
export async function importExternalPromptTemplateCandidate(
  projectValue: ProjectFile,
  candidateValue: ExternalPromptCandidate,
  {
    importedAt = new Date().toISOString(),
    importerVersion = EXTERNAL_PROMPT_IMPORTER_VERSION,
    recommendModel = false,
  }: ImportExternalPromptTemplateOptions = {},
): Promise<ImportedExternalPromptTemplate> {
  const project = parseProjectFile(projectValue);
  const candidate = parseExternalPromptCandidate(candidateValue);
  const expectedDigest = await computeExternalPromptSourceDigest(candidate);
  if (candidate.sourceDigest !== expectedDigest) {
    throw new Error(
      "External prompt candidate digest does not match its source evidence.",
    );
  }
  const projection = projectExternalPromptTemplate(candidate);
  const activeRevision = project.conversationRevisions.find(
    ({ id }) => id === project.defaults.conversationRevisionId,
  );
  if (!activeRevision) {
    throw new Error("Project has no active conversation revision.");
  }

  const messageCount = projection.messages.length;
  const suffix = templateCollisionSafeSuffix(
    project,
    candidate.sourceDigest,
    messageCount,
  );
  const externalImportId = createEntityId("external-import", suffix);
  const conversationRevisionId = createEntityId(
    "revision",
    `import-${suffix}`,
  );
  const templateId = createEntityId("template", `import-${suffix}`);
  const templateRevisionId = createEntityId(
    "template-revision",
    `import-${suffix}-1`,
  );
  const templateUseId = createEntityId("template-use", `import-${suffix}`);
  const messageIds = Array.from({ length: messageCount }, (_, index) =>
    createEntityId("message", `import-${suffix}-${index + 1}`),
  );
  const receipt: ExternalImportReceipt = {
    id: externalImportId,
    source: structuredClone(candidate.source),
    invocation: structuredClone(candidate.invocation),
    authored: structuredClone(candidate.authored),
    bindings: structuredClone(candidate.bindings),
    importedAt,
    importerVersion,
    sourceDigest: candidate.sourceDigest,
    fidelity: candidate.fidelity,
    warnings: structuredClone(candidate.warnings),
    projection: {
      kind: "prompt-template",
      templateId,
      templateRevisionId,
      variables: structuredClone(projection.variables),
    },
  };
  const imported = parseProjectFile({
    ...project,
    promptTemplates: [
      ...project.promptTemplates,
      {
        id: templateId,
        name: projection.name,
        currentRevisionId: templateRevisionId,
        ...(recommendModel && candidate.resolved?.model
          ? {
              recommendedTarget: {
                connectionRequirementId:
                  project.defaults.target.connectionRequirementId,
                model: candidate.resolved.model,
              },
            }
          : {}),
        revisions: [
          {
            id: templateRevisionId,
            createdAt: importedAt,
            messages: structuredClone(projection.messages),
            variableDefaults: {},
            externalImportId,
          },
        ],
      },
    ],
    externalImports: [...project.externalImports, receipt],
    conversationRevisions: [
      ...project.conversationRevisions,
      {
        id: conversationRevisionId,
        conversationId: activeRevision.conversationId,
        parentRevisionId: activeRevision.id,
        items: [
          {
            kind: "template-use",
            use: {
              id: templateUseId,
              templateId,
              templateRevisionId,
              values: projection.values,
              outputMessageIds: messageIds,
            },
          },
        ],
        createdAt: importedAt,
      },
    ],
    defaults: {
      ...project.defaults,
      conversationRevisionId,
    },
  });
  return {
    project: imported,
    externalImportId,
    conversationRevisionId,
    templateId,
    templateRevisionId,
    templateUseId,
    messageIds,
  };
}
