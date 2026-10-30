import { comparableText, filePromptReceipts } from "./file-prompt-update.ts";
import {
  parseProjectFile,
  type ChatPromptTemplate,
  type ProjectFile,
  type SourceRootRequirement,
} from "./project.ts";
import { sourceFilePathProblem, sourceRootNameProblem } from "./source-root-rules.ts";
import { createEntityId, type PromptTemplateId } from "./run-kernel/types.ts";
import { randomUUID } from "./random-id.ts";

/**
 * Linked prompt sources (docs/SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md, E3).
 * A link is template state, not a revision: linking, unlinking and reading
 * drift never change what a prompt sends.
 */

export interface FilePromptLink {
  root: SourceRootRequirement;
  path: string;
}

/** The two drift indicators, which can hold at once. */
export interface FilePromptDrift {
  /** The file's text differs from the last pull's, with line endings compared as LF. */
  fileChanged: boolean;
  /** The current revision is not the last pulled one. */
  localRevisions: boolean;
}

function chatTemplate(project: ProjectFile, templateId: PromptTemplateId): ChatPromptTemplate {
  const template = project.promptTemplates.find(({ id }) => id === templateId);
  if (!template || template.kind !== "chat") throw new Error("Choose a saved chat prompt.");
  return template;
}

export function filePromptLink(project: ProjectFile, templateId: PromptTemplateId): FilePromptLink | undefined {
  const template = project.promptTemplates.find(({ id }) => id === templateId);
  if (template?.kind !== "chat" || !template.fileSource) return undefined;
  const { sourceRootId, path } = template.fileSource;
  const root = project.sourceRoots.find(({ id }) => id === sourceRootId);
  return root ? { root, path } : undefined;
}

/**
 * Links a file-tracked prompt to `path` in the root called `rootName`, adding
 * that root to the project when it is missing. Replaces an existing link.
 */
export function linkFilePrompt(
  projectValue: ProjectFile,
  templateId: PromptTemplateId,
  { rootName, path }: { rootName: string; path: string },
): ProjectFile {
  const project = parseProjectFile(projectValue);
  const template = chatTemplate(project, templateId);
  const problem = sourceRootNameProblem(rootName) ?? sourceFilePathProblem(path);
  if (problem) throw new Error(problem);
  if (filePromptReceipts(project, templateId).length === 0) {
    throw new Error("Only a prompt imported from a file can be linked to a source file.");
  }
  const existing = project.sourceRoots.find(({ name }) => name === rootName);
  const root = existing ?? { id: createEntityId("source-root", randomUUID()), name: rootName };
  const other = project.promptTemplates.find((entry) =>
    entry.id !== templateId && entry.kind === "chat" &&
    entry.fileSource?.sourceRootId === root.id && entry.fileSource.path === path);
  if (other) throw new Error(`“${other.name}” is already linked to ${rootName}/${path}.`);
  const linked = parseProjectFile({
    ...project,
    sourceRoots: existing ? project.sourceRoots : [...project.sourceRoots, root],
    promptTemplates: project.promptTemplates.map((entry) =>
      entry.id === template.id ? { ...template, fileSource: { sourceRootId: root.id, path } } : entry),
  });
  return dropUnusedSourceRoots(linked);
}

/** Removes the link, and the root when no other prompt uses it. Revisions are untouched. */
export function unlinkFilePrompt(projectValue: ProjectFile, templateId: PromptTemplateId): ProjectFile {
  const project = parseProjectFile(projectValue);
  const template = chatTemplate(project, templateId);
  if (!template.fileSource) return project;
  const unlinked = { ...template };
  delete unlinked.fileSource;
  return dropUnusedSourceRoots(parseProjectFile({
    ...project,
    promptTemplates: project.promptTemplates.map((entry) => (entry.id === templateId ? unlinked : entry)),
  }));
}

function dropUnusedSourceRoots(project: ProjectFile): ProjectFile {
  const used = new Set(project.promptTemplates.flatMap((template) =>
    template.kind === "chat" && template.fileSource ? [template.fileSource.sourceRootId] : []));
  if (project.sourceRoots.every(({ id }) => used.has(id))) return project;
  return parseProjectFile({ ...project, sourceRoots: project.sourceRoots.filter(({ id }) => used.has(id)) });
}

/** Compares a read file with the last pull and the current revision. */
export function filePromptDrift(project: ProjectFile, templateId: PromptTemplateId, fileText: string): FilePromptDrift {
  const template = chatTemplate(project, templateId);
  const last = filePromptReceipts(project, templateId).at(-1);
  if (!last || last.projection.kind !== "prompt-template") throw new Error("This prompt is not tracked from a file.");
  return {
    fileChanged: comparableText(fileText) !== comparableText(last.authored[0]!.text),
    localRevisions: template.currentRevisionId !== last.projection.templateRevisionId,
  };
}
