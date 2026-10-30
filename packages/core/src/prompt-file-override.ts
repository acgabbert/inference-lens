import type { PromptFileSnapshot } from "./experiment.ts";
import { createFilePromptCandidate } from "./file-prompt-import.ts";
import { comparableText, filePromptReceipts, planFilePromptUpdate } from "./file-prompt-update.ts";
import type { ChatEvaluationSuite, ChatPromptTemplate, ProjectFile, PromptTemplateMessages } from "./project.ts";
import { sourceFileBasename } from "./source-root-rules.ts";
import { filePromptDrift, filePromptLink } from "./source-roots.ts";
import { stableJsonValue } from "./stable-json.ts";
import type { PromptTemplateId, PromptTemplateRevisionId, ResolvedTemplateUse } from "./run-kernel/types.ts";

/**
 * Run-only file overrides and drift for linked prompts
 * (docs/SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md, E4). Ordinary runs never
 * read a file; these read one only when a host explicitly asks, freeze what
 * they read, and never write a revision.
 */

/** A linked prompt and the file a host would read for it. */
export interface LinkedPromptFile {
  templateId: PromptTemplateId;
  templateName: string;
  sourceRootName: string;
  path: string;
}

/** One file as a host read it, in the service's read-result shape. */
export type PromptFileRead =
  | { ok: true; text: string }
  | { ok: false; reason: string; message: string };

export type PromptFileDriftState = "matches" | "file-changed" | "missing" | "unreadable";

export interface PromptFileDriftEntry extends LinkedPromptFile {
  state: PromptFileDriftState;
  /** Why a file is missing or unreadable, as the reader named it. */
  reason?: string;
  message?: string;
  /** The current revision is not the last one pulled; reported apart from the file. */
  localRevisions: boolean;
}

function linkedFile(project: ProjectFile, template: ChatPromptTemplate): LinkedPromptFile | undefined {
  const link = filePromptLink(project, template.id);
  return link
    ? { templateId: template.id, templateName: template.name, sourceRootName: link.root.name, path: link.path }
    : undefined;
}

/** Every non-archived linked prompt, in library order: what drift reports on. */
export function linkedPromptFiles(project: ProjectFile): LinkedPromptFile[] {
  return project.promptTemplates.flatMap((template) =>
    template.kind === "chat" && !template.archivedAt ? linkedFile(project, template) ?? [] : []);
}

/** The linked prompts a chat suite's conversation revision uses, in first-use order. */
export function suitePromptFiles(project: ProjectFile, suite: ChatEvaluationSuite): LinkedPromptFile[] {
  const revision = project.conversationRevisions.find(({ id }) => id === suite.input.conversationRevisionId);
  const files = new Map<PromptTemplateId, LinkedPromptFile>();
  for (const item of revision?.items ?? []) {
    if (item.kind !== "template-use" || files.has(item.use.templateId)) continue;
    const template = project.promptTemplates.find(({ id }) => id === item.use.templateId);
    const file = template?.kind === "chat" ? linkedFile(project, template) : undefined;
    if (file) files.set(file.templateId, file);
  }
  return [...files.values()];
}

/** Names the prompt and its file, so a setup error says which one failed. */
export function describeLinkedPromptFile(file: Pick<LinkedPromptFile, "templateName" | "sourceRootName" | "path">): string {
  return `Prompt “${file.templateName}” (${file.sourceRootName}/${file.path})`;
}

function sameMessages(left: PromptTemplateMessages, right: PromptTemplateMessages): boolean {
  const comparable = (messages: PromptTemplateMessages) =>
    JSON.stringify(stableJsonValue(messages.map(({ role, content }) => ({ role, content: comparableText(content) }))));
  return comparable(left) === comparable(right);
}

/**
 * Freezes each linked prompt the suite uses from its file's text. The text is
 * read as the last pull read it (role and interpretation) and projected
 * through the same plan a Pull previews, so variable names are reused exactly
 * as a Pull would reuse them. Throws, naming the prompt, for anything the
 * update dialog would refuse; nothing falls back to the saved text.
 */
export async function buildPromptFileSnapshots(
  project: ProjectFile,
  suite: ChatEvaluationSuite,
  texts: ReadonlyMap<PromptTemplateId, string>,
): Promise<PromptFileSnapshot[]> {
  const revision = project.conversationRevisions.find(({ id }) => id === suite.input.conversationRevisionId);
  const snapshots: PromptFileSnapshot[] = [];
  for (const file of suitePromptFiles(project, suite)) {
    const named = describeLinkedPromptFile(file);
    const text = texts.get(file.templateId);
    if (text === undefined) throw new Error(`${named} was not read.`);
    const pinned = new Set<PromptTemplateRevisionId>();
    for (const item of revision?.items ?? []) {
      if (item.kind === "template-use" && item.use.templateId === file.templateId) pinned.add(item.use.templateRevisionId);
    }
    if (pinned.size !== 1) {
      throw new Error(`${named} is pinned at more than one revision in the suite's conversation, so its file cannot replace one.`);
    }
    const baseTemplateRevisionId = [...pinned][0]!;
    const lastReceipt = filePromptReceipts(project, file.templateId).at(-1);
    const role = lastReceipt?.authored[0]?.role ?? "user";
    const plainText = lastReceipt?.invocation.version === "plain-text-v1";
    let snapshot: PromptFileSnapshot;
    try {
      const candidate = await createFilePromptCandidate({
        filename: sourceFileBasename(file.path),
        path: file.path,
        text,
        role,
        plainText,
      });
      const update = planFilePromptUpdate(project, file.templateId, candidate);
      if (update.blocked) throw new Error(update.blocked);
      snapshot = {
        templateId: file.templateId,
        baseTemplateRevisionId,
        sourceRootName: file.sourceRootName,
        path: file.path,
        sourceDigest: candidate.sourceDigest,
        authored: { role, text: candidate.authored[0]!.text },
        interpretation: plainText ? "plain-text-v1" : "expression-v1",
        bindings: update.variables.map(({ expression, variableName }) => ({ expression, variableName })),
        messages: structuredClone(update.messages) as PromptFileSnapshot["messages"],
        variableDefaults: { ...update.variableDefaults },
        replacedLocalRevisions: baseTemplateRevisionId !== update.lastPulled.revision.id,
      };
    } catch (error) {
      throw new Error(`${named}: ${error instanceof Error ? error.message : String(error)}`);
    }
    snapshots.push(snapshot);
  }
  return snapshots;
}

/**
 * The project as the run sees it: each snapshot's messages and defaults in
 * place of its pinned revision's. In memory only, for preflight and plan
 * resolution; it is never parsed as a project or saved.
 */
export function projectWithPromptFileSnapshots(
  project: ProjectFile,
  snapshots: readonly PromptFileSnapshot[],
): ProjectFile {
  if (snapshots.length === 0) return project;
  const byTemplate = new Map(snapshots.map((snapshot) => [snapshot.templateId as string, snapshot]));
  return {
    ...project,
    promptTemplates: project.promptTemplates.map((template) => {
      const snapshot = byTemplate.get(template.id);
      if (!snapshot || template.kind !== "chat") return template;
      return {
        ...template,
        revisions: template.revisions.map((revision) => revision.id === snapshot.baseTemplateRevisionId
          ? { ...revision, messages: structuredClone(snapshot.messages), variableDefaults: { ...snapshot.variableDefaults } }
          : revision),
      };
    }),
  };
}

/** Marks each resolution a snapshot replaced with the file it came from. */
export function withPromptFileSources(
  resolutions: readonly ResolvedTemplateUse[],
  snapshots: readonly PromptFileSnapshot[],
): ResolvedTemplateUse[] {
  const byTemplate = new Map(snapshots.map((snapshot) => [snapshot.templateId as string, snapshot]));
  return resolutions.map((resolution) => {
    const snapshot = byTemplate.get(resolution.templateId);
    return snapshot
      ? {
          ...resolution,
          fileSource: {
            sourceRootName: snapshot.sourceRootName,
            path: snapshot.path,
            sourceDigest: snapshot.sourceDigest,
            baseTemplateRevisionId: resolution.templateRevisionId,
          },
        }
      : resolution;
  });
}

/** Whether the file's projected text differs from the pinned revision it replaced. */
export function promptFileSnapshotChangesText(project: ProjectFile, snapshot: PromptFileSnapshot): boolean {
  const template = project.promptTemplates.find(({ id }) => id === snapshot.templateId);
  const revision = template?.kind === "chat"
    ? template.revisions.find(({ id }) => id === snapshot.baseTemplateRevisionId)
    : undefined;
  return !revision || !sameMessages(revision.messages, snapshot.messages);
}

/**
 * Each read file against its prompt's last pull, using E3's comparison.
 * Local revisions are reported apart and never make a file drift.
 */
export function promptFileDriftEntries(
  project: ProjectFile,
  reads: ReadonlyMap<PromptTemplateId, PromptFileRead>,
): PromptFileDriftEntry[] {
  return linkedPromptFiles(project).map((file) => {
    const read = reads.get(file.templateId);
    if (!read) throw new Error(`${describeLinkedPromptFile(file)} was not read.`);
    if (!read.ok) {
      const { localRevisions } = filePromptDrift(project, file.templateId, "");
      return {
        ...file,
        state: read.reason === "missing" ? "missing" : "unreadable",
        reason: read.reason,
        message: read.message,
        localRevisions,
      };
    }
    const drift = filePromptDrift(project, file.templateId, read.text);
    return { ...file, state: drift.fileChanged ? "file-changed" : "matches", localRevisions: drift.localRevisions };
  });
}
