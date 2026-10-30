import type { PromptFileSnapshot } from "../../core/src/experiment.ts";
import type { ChatEvaluationSuite, ProjectFile } from "../../core/src/project.ts";
import {
  buildPromptFileSnapshots,
  describeLinkedPromptFile,
  linkedPromptFiles,
  promptFileDriftEntries,
  promptFileSnapshotChangesText,
  suitePromptFiles,
} from "../../core/src/prompt-file-override.ts";
import type { LinkedPromptFile, PromptFileDriftState, PromptFileRead } from "../../core/src/prompt-file-override.ts";
import type { PromptTemplateId } from "../../core/src/run-kernel/types.ts";
import {
  readSourceRootCatalog,
  readSourceRootFiles,
  sourceRootCatalogFromMappings,
  SOURCE_ROOTS_VARIABLE,
} from "../../../services/api/src/source-root-files.ts";
import type { SourceRootCatalogSource } from "../../../services/api/src/source-root-files.ts";
import { HeadlessSetupError } from "./headless-experiment.ts";
import { openNodeProjectFolder } from "./project-folder.ts";
import { EXIT_SETUP } from "./summary.ts";
import type { HeadlessPromptSourceSummary } from "./summary.ts";

/**
 * Linked prompt files for the CLI (docs/SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md,
 * E4): `--source-root`, `run --prompts-from-files` and `drift`. Files are
 * read only when one of these asks, through the server's confined reads, and
 * nothing here writes a project or a source file.
 */

/** `--source-root <name>=<path>`, as given. Paths resolve against the current directory when read. */
export function parseSourceRootFlags(entries: readonly string[]): Map<string, string> {
  const mappings = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, Math.max(separator, 0));
    const folder = entry.slice(separator + 1);
    if (separator <= 0 || !folder) throw new Error(`--source-root takes <name>=<path>, not "${entry}".`);
    if (mappings.has(name)) throw new Error(`--source-root names ${name} more than once.`);
    mappings.set(name, folder);
  }
  return mappings;
}

export interface SourceRootOptions {
  /** `--source-root` mappings; each wins over the catalog for its name. */
  sourceRoots?: ReadonlyMap<string, string>;
  environment: Readonly<Record<string, string | undefined>>;
  /** Where a relative `--source-root` path resolves. The current directory when omitted. */
  workingDirectory?: string;
}

/**
 * The folders this invocation may read: `INFERENCE_LENS_SOURCE_ROOTS` for
 * names no flag gives, then the flags. A flag for a name the project does not
 * declare is a usage error rather than a mapping nothing reads.
 */
export function sourceRootCatalogForProject(project: ProjectFile, options: SourceRootOptions): SourceRootCatalogSource {
  const flags = options.sourceRoots ?? new Map<string, string>();
  for (const name of flags.keys()) {
    if (!project.sourceRoots.some((root) => root.name === name)) {
      throw new HeadlessSetupError(
        `This project does not declare a source root named “${name}”. It declares: ${project.sourceRoots.map((root) => root.name).join(", ") || "none"}.`,
      );
    }
  }
  const catalog = readSourceRootCatalog(options.environment as Record<string, string | undefined>);
  if (catalog.problem) throw new HeadlessSetupError(catalog.problem);
  const fromFlags = sourceRootCatalogFromMappings(
    [...flags].map(([name, path]) => ({ name, path })),
    options.workingDirectory ?? process.cwd(),
  );
  return {
    available: true,
    roots: [...catalog.roots.filter(({ name }) => !flags.has(name)), ...fromFlags.roots],
  };
}

/** Reads each file, after checking every root is mapped, so a gap is a setup error rather than a missing file. */
async function readLinkedFiles(
  catalog: SourceRootCatalogSource,
  files: readonly LinkedPromptFile[],
): Promise<Map<PromptTemplateId, PromptFileRead>> {
  for (const file of files) {
    if (!catalog.roots.some(({ name }) => name === file.sourceRootName)) {
      throw new HeadlessSetupError(
        `${describeLinkedPromptFile(file)}: no folder is mapped to source root “${file.sourceRootName}”. ` +
          `Pass --source-root ${file.sourceRootName}=<path>, or declare it in ${SOURCE_ROOTS_VARIABLE}.`,
      );
    }
  }
  const reads = await readSourceRootFiles(catalog, files.map(({ sourceRootName, path }) => ({ root: sourceRootName, path })));
  return new Map(files.map((file, index) => [file.templateId, reads[index]!]));
}

/**
 * `--prompts-from-files`: every linked prompt the suite uses, read and frozen.
 * Any prompt that cannot be read or projected stops the run before anything is
 * sent; there is no fallback to the saved text.
 */
export async function readPromptFileSnapshots(
  project: ProjectFile,
  suite: ChatEvaluationSuite,
  options: SourceRootOptions,
): Promise<PromptFileSnapshot[]> {
  const files = suitePromptFiles(project, suite);
  if (files.length === 0) {
    throw new HeadlessSetupError(`Suite “${suite.name}” uses no linked prompt, so --prompts-from-files has nothing to read.`);
  }
  const catalog = sourceRootCatalogForProject(project, options);
  const reads = await readLinkedFiles(catalog, files);
  const texts = new Map<PromptTemplateId, string>();
  for (const file of files) {
    const read = reads.get(file.templateId)!;
    if (!read.ok) throw new HeadlessSetupError(`${describeLinkedPromptFile(file)}: ${read.message}`);
    texts.set(file.templateId, read.text);
  }
  try {
    return await buildPromptFileSnapshots(project, suite, texts);
  } catch (error) {
    throw new HeadlessSetupError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Preflight findings about a use whose text came from a file name that file,
 * so "cannot resolve template variable" says which prompt to fix.
 */
export function namePromptFileDiagnostics<Diagnostic extends { message: string; templateUseId?: string }>(
  project: ProjectFile,
  suite: ChatEvaluationSuite,
  snapshots: readonly PromptFileSnapshot[],
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  if (snapshots.length === 0) return [...diagnostics];
  const files = new Map(suitePromptFiles(project, suite).map((file) => [file.templateId as string, file]));
  const revision = project.conversationRevisions.find(({ id }) => id === suite.input.conversationRevisionId);
  const fileByUse = new Map<string, LinkedPromptFile>();
  for (const item of revision?.items ?? []) {
    if (item.kind !== "template-use") continue;
    const file = files.get(item.use.templateId);
    if (file && snapshots.some(({ templateId }) => templateId === file.templateId)) fileByUse.set(item.use.id, file);
  }
  return diagnostics.map((diagnostic) => {
    const file = diagnostic.templateUseId ? fileByUse.get(diagnostic.templateUseId) : undefined;
    return file ? { ...diagnostic, message: `${describeLinkedPromptFile(file)}: ${diagnostic.message}` } : diagnostic;
  });
}

export function promptSourceSummaries(
  project: ProjectFile,
  snapshots: readonly PromptFileSnapshot[],
): HeadlessPromptSourceSummary[] {
  return snapshots.map((snapshot) => ({
    templateId: snapshot.templateId,
    name: project.promptTemplates.find(({ id }) => id === snapshot.templateId)?.name ?? snapshot.templateId,
    sourceRoot: snapshot.sourceRootName,
    path: snapshot.path,
    sourceDigest: snapshot.sourceDigest,
    textChanged: promptFileSnapshotChangesText(project, snapshot),
    replacedLocalRevisions: snapshot.replacedLocalRevisions,
  }));
}

/**
 * The `drift --json` summary: its own public contract, versioned apart from
 * the run summaries, under the same rules.
 */
export const DRIFT_SUMMARY_SCHEMA_VERSION = 1;

export interface DriftSummaryV1 {
  kind: "drift";
  schemaVersion: typeof DRIFT_SUMMARY_SCHEMA_VERSION;
  projectDirectory: string;
  /** `drift` when any file changed, is missing or is unreadable. */
  outcome: "matches" | "drift" | "nothing-linked";
  prompts: Array<{
    templateId: string;
    name: string;
    sourceRoot: string;
    path: string;
    state: PromptFileDriftState;
    reason?: string;
    message?: string;
    /** Reported apart; never changes the exit code. */
    localRevisions: boolean;
  }>;
}

export interface DriftOutcome {
  exitCode: number;
  summary?: DriftSummaryV1;
  error?: string;
}

/** `drift`: reads every non-archived linked prompt's file. Sends nothing and writes nothing. */
export async function runDrift(options: SourceRootOptions & { projectDirectory: string }): Promise<DriftOutcome> {
  try {
    const folder = await openNodeProjectFolder(options.projectDirectory);
    const { project } = folder;
    const catalog = sourceRootCatalogForProject(project, options);
    const files = linkedPromptFiles(project);
    const entries = promptFileDriftEntries(project, await readLinkedFiles(catalog, files));
    const drifted = entries.some(({ state }) => state !== "matches");
    return {
      exitCode: drifted ? 1 : 0,
      summary: {
        kind: "drift",
        schemaVersion: DRIFT_SUMMARY_SCHEMA_VERSION,
        projectDirectory: folder.directory,
        outcome: entries.length === 0 ? "nothing-linked" : drifted ? "drift" : "matches",
        prompts: entries.map(({ templateId, templateName, sourceRootName, path, state, reason, message, localRevisions }) => ({
          templateId,
          name: templateName,
          sourceRoot: sourceRootName,
          path,
          state,
          ...(reason === undefined ? {} : { reason }),
          ...(message === undefined ? {} : { message }),
          localRevisions,
        })),
      },
    };
  } catch (error) {
    return { exitCode: EXIT_SETUP, error: error instanceof Error ? error.message : String(error) };
  }
}

export function formatDriftSummary(summary: DriftSummaryV1): string {
  const total = summary.prompts.length;
  if (total === 0) return "No prompts in this project are linked to a source file.\n";
  const differing = summary.prompts.filter(({ state }) => state !== "matches").length;
  const lines = [
    differing === 0
      ? total === 1
        ? "All 1 linked prompt file matches its last pull."
        : `All ${total} linked prompt files match their last pull.`
      : `${differing} of ${total} linked prompt ${total === 1 ? "file differs" : "files differ"} from the last pull or cannot be read.`,
    ...summary.prompts.map((prompt) =>
      `  ${prompt.state.padEnd(13)}${prompt.name} ← ${prompt.sourceRoot}/${prompt.path}` +
        (prompt.message ? ` — ${prompt.message}` : "") +
        (prompt.localRevisions ? " (local revisions not from the file)" : "")),
  ];
  return `${lines.join("\n")}\n`;
}
