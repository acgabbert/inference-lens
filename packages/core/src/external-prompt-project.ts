import {
  computeExternalPromptSourceDigest,
  parseExternalPromptCandidate,
} from "./external-prompt-import.ts";
import type { ExternalPromptCandidate } from "./external-prompt-import.ts";
import { parseProjectFile } from "./project.ts";
import type {
  ExternalImportReceipt,
  ProjectFile,
  ProjectConversationItem,
} from "./project.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type {
  ConversationRevisionId,
  ExternalImportId,
  MessageId,
} from "./run-kernel/types.ts";

export const EXTERNAL_PROMPT_IMPORTER_VERSION = 1;

export interface ImportExternalPromptOptions {
  importedAt?: string;
  importerVersion?: number;
}

export interface ImportedExternalPrompt {
  project: ProjectFile;
  externalImportId: ExternalImportId;
  conversationRevisionId: ConversationRevisionId;
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
