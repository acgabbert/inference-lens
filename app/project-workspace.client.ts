"use client";

/**
 * Project folder storage for both hosts. The rules below are the ones review
 * keeps rediscovering; `tests/project-workspace-invariants.test.ts` and lint
 * hold the ones that can be checked mechanically, and the use-site rules are
 * in `use-project-workspace.client.ts`.
 *
 * W1. A handle is one read, not a folder. A `ProjectWorkspaceHandle`'s
 *     storage expects the manifest contents it was opened with, so reopening
 *     always mints a new handle and never revives an old one. Compare handles
 *     with `===` only to ask "is this still the same read/write session"
 *     (queued writes, async continuations). To ask "is this the same project
 *     folder" — selection, navigation, links, anything the user would expect
 *     to survive an editor handover — use `isSameProjectWorkspace`.
 *
 * W2. Manifest reads of an adopted workspace take the project's write scope.
 *     `reopenProjectWorkspace` reads inside `coordinateProjectWrites`, so it
 *     never sees a save half-way and can check the project ID under the same
 *     lock; any later read goes through it. The only reads outside the scope
 *     happen before the project ID is known — picking, creating, resuming and
 *     inspecting a link candidate — and they precede adoption.
 *
 * W3. Manifest writes are checked against the last read. `save` re-reads the
 *     file inside the write scope and throws `ProjectManifestConflictError`
 *     when it differs from what this handle last read or wrote. Tab
 *     coordination narrows who writes; this check is still the only
 *     protection against other origins, the desktop app and other machines.
 *
 * W4. The last-project record is written only by
 *     `rememberAcceptedProjectWorkspace`, after the project owner accepts a
 *     workspace, and only when the folder changes. Its `recordId` is a
 *     compare-and-delete token, so rewriting the record for the same folder
 *     silently disarms "Forget location".
 */

import {
  PROJECT_FILE_NAME,
  projectGitignoreContents,
  projectDirectoryName,
  projectExportFileName,
} from "../packages/core/src/project.ts";
import type { ProjectFile, ProjectGitPolicy } from "../packages/core/src/project.ts";
import type { WorkbenchFile, WorkbenchMutationResult, WorkbenchStorage } from "../packages/core/src/workbench-store.ts";
import { nativeMigrationCompletionStorage, nativeMigrationStorage } from "./migration-native.client.ts";
import type { MigrationStorage } from "../packages/core/src/migration-journal.ts";
import type { MigrationCompletionStorage } from "../packages/core/src/migration-completion.ts";
import { browserMigrationCompletionStorage, browserMigrationStorage, browserWorkbenchStorage, coordinateProjectWrites } from "./workbench-directory.client.ts";
import {
  assertTraceEntryName,
  serializeDecisionRunTrace,
  serializeRunTrace,
  TRACES_DIRECTORY_NAME,
  traceFileName,
} from "../packages/core/src/run-trace.ts";
import type { SavedRunTrace } from "../packages/core/src/run-trace.ts";
import {
  EVALUATION_ASSESSMENT_FILE_SUFFIX,
  assertExperimentEntryName,
  EXPERIMENTS_DIRECTORY_NAME,
  experimentPlanFileName,
  experimentResultFileName,
  serializeExperimentPlan,
  serializeExperimentResult,
} from "../packages/core/src/experiment.ts";
import type {
  ExperimentResult,
  ExperimentPlanV3,
} from "../packages/core/src/experiment.ts";
import {
  evaluationAssessmentFileName,
  parseEvaluationAssessmentJson,
  serializeEvaluationAssessment,
} from "../packages/core/src/evaluation-assessment.ts";
import type { EvaluationAssessmentV1 } from "../packages/core/src/evaluation-assessment.ts";
import type { EvaluationAssessmentId } from "../packages/core/src/run-kernel/types.ts";
import {
  EVALUATION_BASELINES_FILE_NAME,
  emptyEvaluationBaselines,
  parseEvaluationBaselinesJson,
  serializeEvaluationBaselines,
} from "../packages/core/src/evaluation-baselines.ts";
import type { EvaluationBaselinesFileV2 } from "../packages/core/src/evaluation-baselines.ts";
import {
  EVALUATION_CASE_SOURCES_FILE_NAME,
  emptyEvaluationCaseSources,
  parseEvaluationCaseSourcesJson,
  serializeEvaluationCaseSources,
} from "../packages/core/src/evaluation-case-sources.ts";
import type { EvaluationCaseSourcesFileV1 } from "../packages/core/src/evaluation-case-sources.ts";
import {
  listExperimentArtifactsFromDirectory,
  readExperimentArtifactFromDirectory,
} from "./experiment-directory.client.ts";
import type { StoredExperimentArtifactFile } from "./experiment-directory.client.ts";
import {
  listTracesFromDirectory,
  readTraceFromDirectory,
} from "./project-directory.client.ts";
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
  StoredRunTraceFile,
} from "./project-directory.client.ts";
import { rememberProjectLocation } from "./project-location-registry.client.ts";
import { personalWorkbenchEnabled } from "./workbench/personal-workbench-gate.ts";
import {
  LEGACY_FOLDER_SAVE_BLOCKED_MESSAGE,
  readProjectManifest,
  serializeProjectManifest,
} from "./workbench/project-manifest.ts";
import type {
  ProjectManifestFormat,
  ProjectManifestRead,
  ProjectSessionMode,
} from "./workbench/project-manifest.ts";
import type { WorkbenchPromptDraftV1 } from "../packages/core/src/personal-workbench.ts";
import { isTauriRuntime } from "./runtime.client.ts";
import {
  clearStoredWorkspace,
  queryWorkspacePermission,
  readStoredWorkspace,
  requestWorkspacePermission,
  writeStoredWorkspace,
} from "./workspace-handle-store.client.ts";
import {
  classifyPickerError,
  classifyWorkspaceReadError,
  pickerNotAllowedMessage,
  resolveStoredWorkspaceAccess,
  resolveStoredWorkspaceLoad,
} from "./workspace-resume.client.ts";
import type {
  ResumeMode,
  StoredWorkspaceAccess,
  StoredWorkspaceRecord,
  WorkspaceReadResult,
} from "./workspace-resume.client.ts";

export type { StoredRunTraceFile };
export type { StoredExperimentArtifactFile };

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandleLike>;
}

/**
 * Listing and reading are separate operations because they serve different
 * costs: the drawer lists every artifact once when it opens, but opens exactly
 * one of them. Reading the selected trace again keeps the parsed history in
 * memory as compact summaries rather than as every trace the folder holds.
 */
interface WorkspaceStorage {
  /** Opt-in recovery adapter. Creating a handle never creates recovery files. */
  workbench: WorkbenchStorage;
  /** Opt-in byte-preserving migration staging; never replaces the manifest. */
  migration: MigrationStorage;
  /**
   * Opt-in completion of a staged migration; the only writer of a v19
   * manifest. Once it attempts that write, or finds it already done, this
   * handle's `save` rejects with `ProjectHandleInvalidatedError`.
   */
  migrationCompletion: MigrationCompletionStorage;
  /**
   * `precondition` runs inside the project's write scope before the manifest
   * is read, so nothing can change the answer before the write lands. It throws
   * to refuse the write.
   */
  save(contents: string, precondition?: () => Promise<void>): Promise<void>;
  saveTrace(runId: string, fileName: string, contents: string): Promise<void>;
  listTraces(): Promise<StoredRunTraceFile[]>;
  readTrace(fileName: string): Promise<string>;
  saveExperimentArtifact(fileName: string, contents: string): Promise<void>;
  listExperimentArtifacts(): Promise<StoredExperimentArtifactFile[]>;
  readExperimentArtifact(fileName: string): Promise<string>;
  /** `null` when the project has never pinned a baseline. */
  readEvaluationBaselines(): Promise<string | null>;
  saveEvaluationBaselines(contents: string): Promise<void>;
  /** Optional local annotations connecting authored cases to captured evidence. */
  readEvaluationCaseSources(): Promise<string | null>;
  saveEvaluationCaseSources(contents: string): Promise<void>;
}

export interface ProjectWorkspaceHandle {
  kind: "browser-directory" | "tauri-directory";
  displayName: string;
  /** Human-readable only; never passed back to a filesystem command. */
  displayPath: string;
  storage: WorkspaceStorage;
}

export interface OpenedProjectWorkspace {
  project: ProjectFile;
  handle: ProjectWorkspaceHandle;
}

/**
 * What one manifest read (W1) found, kept beside its handle. The session mode
 * is the gate's value when the read happened, and the owner adopts it with the
 * handle, so an open session never changes mode (D2).
 */
export interface ProjectWorkspaceManifest {
  mode: ProjectSessionMode;
  format: ProjectManifestFormat;
  /** Template drafts lifted out of a legacy document read in a `personal` session. */
  personalSeeds: WorkbenchPromptDraftV1[];
}

const workspaceManifests = new WeakMap<ProjectWorkspaceHandle, ProjectWorkspaceManifest>();

/** The session mode the gate selects now. Read only before a document is adopted. */
export function currentProjectSessionMode(): ProjectSessionMode {
  return personalWorkbenchEnabled() ? "personal" : "legacy";
}

export function projectWorkspaceManifest(handle: ProjectWorkspaceHandle): ProjectWorkspaceManifest {
  const manifest = workspaceManifests.get(handle);
  if (!manifest) throw new Error("Unknown project workspace handle.");
  return manifest;
}

/** A gated session refuses to write a legacy manifest (S1); opening never migrates. */
export class SharedSaveBlockedError extends Error {
  constructor(message = LEGACY_FOLDER_SAVE_BLOCKED_MESSAGE) {
    super(message);
    this.name = "SharedSaveBlockedError";
  }
}

function readManifest(contents: string): ProjectManifestRead & { mode: ProjectSessionMode } {
  const mode = currentProjectSessionMode();
  return { ...readProjectManifest(contents, mode), mode };
}

function withManifest(
  handle: ProjectWorkspaceHandle,
  read: { mode: ProjectSessionMode; format: ProjectManifestFormat; personalSeeds: WorkbenchPromptDraftV1[] },
): ProjectWorkspaceHandle {
  workspaceManifests.set(handle, { mode: read.mode, format: read.format, personalSeeds: read.personalSeeds });
  return handle;
}

/** A manifest this build just wrote: v19 in a `personal` session. */
function writtenManifest(mode: ProjectSessionMode): ProjectWorkspaceManifest {
  return {
    mode,
    format: mode === "personal" ? { kind: "shared" } : { kind: "legacy", sourceVersion: 18 },
    personalSeeds: [],
  };
}

export type WorkspaceResumeOutcome =
  | { kind: "resumed"; project: ProjectFile; handle: ProjectWorkspaceHandle }
  | { kind: "reconnect-required"; message: string }
  | { kind: "forgotten"; message: string }
  | { kind: "none" };

export interface ProjectCreationOptions {
  name: string;
  gitPolicy: ProjectGitPolicy;
}

interface NativeWorkspace {
  workspaceId: string;
  displayName: string;
  displayPath: string;
  contents: string;
}

export type RunTraceExportResult =
  | { kind: "saved"; location: string }
  | { kind: "downloaded"; fileName: string }
  | { kind: "cancelled" };

function picker(): DirectoryPickerWindow["showDirectoryPicker"] {
  return (window as DirectoryPickerWindow).showDirectoryPicker;
}

export function browserFolderAccessAvailable(): boolean {
  return typeof window !== "undefined" && typeof picker() === "function";
}

export function projectFolderAccessAvailable(): boolean {
  return isTauriRuntime() || browserFolderAccessAvailable();
}

async function readBrowserManifest(
  directory: FileSystemDirectoryHandleLike,
): Promise<string> {
  const fileHandle: FileSystemFileHandleLike =
    await directory.getFileHandle(PROJECT_FILE_NAME);
  return (await fileHandle.getFile()).text();
}

/**
 * The manifest on disk no longer matches what this handle last read or wrote.
 * The storage cannot tell who changed it; the project owner can, because it
 * hears other tabs of this app announce their saves.
 */
export class ProjectManifestConflictError extends Error {
  constructor() {
    super(`${PROJECT_FILE_NAME} changed outside Inference Lens. Reopen the project before saving.`);
    this.name = "ProjectManifestConflictError";
  }
}

/**
 * Migration completion wrote, or tried to write, a shared manifest this handle
 * never read. Its expected contents are no longer a safe basis for a save,
 * even if the write left the old bytes in place.
 */
export class ProjectHandleInvalidatedError extends Error {
  constructor() {
    super(`This window started migrating ${PROJECT_FILE_NAME} to a newer format. Reopen the project before saving.`);
    this.name = "ProjectHandleInvalidatedError";
  }
}

function browserStorage(
  directory: FileSystemDirectoryHandleLike,
  initialContents: string,
  projectId: ProjectFile["projectId"],
): WorkspaceStorage {
  let lastContents = initialContents;
  let valid = true;
  return {
    workbench: browserWorkbenchStorage(directory),
    migration: browserMigrationStorage(directory),
    migrationCompletion: browserMigrationCompletionStorage(directory, projectId, () => { valid = false; }),
    save(contents: string, precondition?: () => Promise<void>): Promise<void> {
      return coordinateProjectWrites(projectId, async () => {
        if (!valid) throw new ProjectHandleInvalidatedError();
        await precondition?.();
        const fileHandle = await directory.getFileHandle(PROJECT_FILE_NAME);
        const currentContents = await (await fileHandle.getFile()).text();
        if (currentContents !== lastContents) throw new ProjectManifestConflictError();
        const writable = await fileHandle.createWritable();
        await writable.write(contents);
        await writable.close();
        lastContents = contents;
      });
    },
    async saveTrace(
      _runId: string,
      fileName: string,
      contents: string,
    ): Promise<void> {
      const traces = await directory.getDirectoryHandle(TRACES_DIRECTORY_NAME, {
        create: true,
      });
      let fileHandle: FileSystemFileHandleLike;
      try {
        fileHandle = await traces.getFileHandle(fileName);
        const existing = await (await fileHandle.getFile()).text();
        if (existing === contents) return;
        throw new Error(
          `${fileName} already exists with different contents. Run traces are immutable.`,
        );
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
          throw error;
        }
        fileHandle = await traces.getFileHandle(fileName, { create: true });
      }
      const writable = await fileHandle.createWritable();
      await writable.write(contents);
      await writable.close();
    },
    async listTraces(): Promise<StoredRunTraceFile[]> {
      return listTracesFromDirectory(directory);
    },
    async readTrace(fileName: string): Promise<string> {
      return readTraceFromDirectory(directory, fileName);
    },
    async saveExperimentArtifact(fileName: string, contents: string): Promise<void> {
      const experiments = await directory.getDirectoryHandle(EXPERIMENTS_DIRECTORY_NAME, {
        create: true,
      });
      const safeName = assertExperimentEntryName(fileName);
      let fileHandle: FileSystemFileHandleLike;
      try {
        fileHandle = await experiments.getFileHandle(safeName);
        const existing = await (await fileHandle.getFile()).text();
        if (existing === contents) return;
        throw new Error(
          `${safeName} already exists with different contents. Experiment artifacts are immutable.`,
        );
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
          throw error;
        }
        fileHandle = await experiments.getFileHandle(safeName, { create: true });
      }
      const writable = await fileHandle.createWritable();
      await writable.write(contents);
      await writable.close();
    },
    async listExperimentArtifacts(): Promise<StoredExperimentArtifactFile[]> {
      return listExperimentArtifactsFromDirectory(directory);
    },
    async readExperimentArtifact(fileName: string): Promise<string> {
      return readExperimentArtifactFromDirectory(directory, fileName);
    },
    async readEvaluationBaselines(): Promise<string | null> {
      try {
        const fileHandle = await directory.getFileHandle(EVALUATION_BASELINES_FILE_NAME);
        return await (await fileHandle.getFile()).text();
      } catch (error) {
        // A project that has pinned nothing has no file. That is the ordinary
        // state, not a failure to report.
        if (error instanceof DOMException && error.name === "NotFoundError") return null;
        throw error;
      }
    },
    async saveEvaluationBaselines(contents: string): Promise<void> {
      const fileHandle = await directory.getFileHandle(EVALUATION_BASELINES_FILE_NAME, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(contents);
      await writable.close();
    },
    async readEvaluationCaseSources(): Promise<string | null> {
      try {
        const fileHandle = await directory.getFileHandle(EVALUATION_CASE_SOURCES_FILE_NAME);
        return await (await fileHandle.getFile()).text();
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") return null;
        throw error;
      }
    },
    async saveEvaluationCaseSources(contents: string): Promise<void> {
      const fileHandle = await directory.getFileHandle(EVALUATION_CASE_SOURCES_FILE_NAME, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(contents);
      await writable.close();
    },
  };
}

/** Kept off the public handle: only a reopen needs the directory again. */
const browserDirectories = new WeakMap<ProjectWorkspaceHandle, FileSystemDirectoryHandleLike>();
const browserProjectIds = new WeakMap<ProjectWorkspaceHandle, ProjectFile["projectId"]>();
const browserManifestContents = new WeakMap<ProjectWorkspaceHandle, string>();
let rememberTail: Promise<void> = Promise.resolve();

/** Reopen retains its directory identity; a separately opened copy does not. */
export function isSameProjectWorkspace(previous: ProjectWorkspaceHandle | null | undefined, next: ProjectWorkspaceHandle | null | undefined): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  const directory = browserDirectories.get(previous);
  return Boolean(directory && directory === browserDirectories.get(next) && browserProjectIds.get(previous) === browserProjectIds.get(next));
}

function browserWorkspace(
  directory: FileSystemDirectoryHandleLike,
  contents: string,
  projectId: ProjectFile["projectId"],
): ProjectWorkspaceHandle {
  const handle: ProjectWorkspaceHandle = {
    kind: "browser-directory",
    displayName: directory.name,
    displayPath: directory.name,
    storage: browserStorage(directory, contents, projectId),
  };
  browserDirectories.set(handle, directory);
  browserProjectIds.set(handle, projectId);
  browserManifestContents.set(handle, contents);
  return handle;
}

/**
 * Reads the manifest again into a fresh handle, for a tab that becomes the
 * project's editor. The read runs in the project's write scope so it cannot
 * observe a save half-way, and the old handle is never revived: its expected
 * contents belong to the document it was opened with.
 */
export async function reopenProjectWorkspace(
  handle: ProjectWorkspaceHandle,
  projectId: ProjectFile["projectId"],
): Promise<OpenedProjectWorkspace> {
  const directory = browserDirectories.get(handle);
  if (!directory) throw new Error("Only a browser project folder can be reopened.");
  const contents = await coordinateProjectWrites(projectId, () => readBrowserManifest(directory));
  const read = readManifest(contents);
  const { project } = read;
  if (project.projectId !== projectId) {
    throw new Error(`${directory.name} now holds a different project. Open it again from the Project menu.`);
  }
  return { project, handle: withManifest(browserWorkspace(directory, contents, projectId), read) };
}

/** Revalidate a preflighted target after any replacement dialog or queued save.
 * A changed target must be inspected afresh rather than adopted from a stale read. */
export async function revalidateLinkedProjectWorkspace(opened: OpenedProjectWorkspace): Promise<void> {
  const refreshed = await reopenProjectWorkspace(opened.handle, opened.project.projectId);
  if (browserManifestContents.get(refreshed.handle) !== browserManifestContents.get(opened.handle)) {
    throw new Error("The linked project changed while waiting to open. Retry to read its latest contents.");
  }
}

async function rememberBrowserWorkspace(
  directory: FileSystemDirectoryHandleLike,
  project: ProjectFile,
): Promise<void> {
  const previous = await readStoredWorkspace();
  // Preserve compare-and-delete tokens across restore and folder refreshes.
  if (previous) {
    try {
      if (directory === previous.handle || await directory.isSameEntry?.(previous.handle)) return;
    } catch { /* A stale handle must not prevent remembering the accepted folder. */ }
  }
  await writeStoredWorkspace({
    version: 1,
    recordId: crypto.randomUUID(),
    kind: "browser-directory",
    displayName: directory.name,
    projectName: project.name,
    handle: directory,
    savedAt: Date.now(),
  });
}

/** Persist discovery only after the project owner accepts a workspace. */
export async function rememberAcceptedProjectWorkspace(opened: OpenedProjectWorkspace): Promise<void> {
  const directory = browserDirectories.get(opened.handle);
  if (!directory) return;
  const remember = rememberTail.catch(() => undefined).then(async () => {
    await rememberBrowserWorkspace(directory, opened.project);
    await rememberProjectLocation(opened.project.projectId, opened.project.name, directory);
  });
  rememberTail = remember;
  await remember;
}

/** Inspect a registry candidate without adoption, writes or last-project effects. */
export async function inspectBrowserProjectDirectory(directory: FileSystemDirectoryHandleLike, projectId: ProjectFile["projectId"]): Promise<OpenedProjectWorkspace> {
  const contents = await readBrowserManifest(directory);
  const read = readManifest(contents);
  const { project } = read;
  if (project.projectId !== projectId) throw new Error(`Wrong project: ${directory.name} contains ${project.projectId}, but this link requests ${projectId}. Locate the matching project folder.`);
  return { project, handle: withManifest(browserWorkspace(directory, contents, project.projectId), read) };
}

export async function locateLinkedProject(projectId: ProjectFile["projectId"]): Promise<OpenedProjectWorkspace | null> {
  const opened = await openBrowserProjectFolder();
  if (opened && opened.project.projectId !== projectId) throw new Error(`Wrong project: ${opened.project.name} contains ${opened.project.projectId}, but this link requests ${projectId}. Locate the matching project folder.`);
  return opened;
}

async function openBrowserProjectFolder(): Promise<OpenedProjectWorkspace | null> {
  const showDirectoryPicker = picker();
  if (!showDirectoryPicker) {
    throw new Error(
      "This browser does not support project folders. Use Import instead.",
    );
  }
  try {
    const directory = await showDirectoryPicker({
      id: "inference-lens-project",
      mode: "readwrite",
    });
    let contents: string;
    try {
      contents = await readBrowserManifest(directory);
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "NotFoundError"
      ) {
        throw new Error(
          `The selected folder does not contain ${PROJECT_FILE_NAME}.`,
        );
      }
      throw error;
    }
    const read = readManifest(contents);
    const { project } = read;
    return {
      project,
      handle: withManifest(browserWorkspace(directory, contents, project.projectId), read),
    };
  } catch (error) {
    const failure = classifyPickerError(error);
    if (failure === "cancelled") return null;
    if (failure === "not-allowed") {
      throw new Error(pickerNotAllowedMessage());
    }
    throw error;
  }
}

async function createBrowserProjectFolder(
  project: ProjectFile,
  options: ProjectCreationOptions,
): Promise<OpenedProjectWorkspace | null> {
  const showDirectoryPicker = picker();
  if (!showDirectoryPicker) {
    throw new Error(
      "This browser does not support project folders. Use Export instead.",
    );
  }
  try {
    const parent = await showDirectoryPicker({
      id: "inference-lens-project",
      mode: "readwrite",
    });
    const bundleName = projectDirectoryName(options.name);
    try {
      await parent.getDirectoryHandle(bundleName);
      throw new Error(
        `${bundleName} already exists in the selected folder. Open it instead or choose another name.`,
      );
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
        throw error;
      }
    }
    const directory = await parent.getDirectoryHandle(bundleName, { create: true });
    try {
      const gitignoreContents = projectGitignoreContents(options.gitPolicy);
      if (gitignoreContents !== null) {
        const ignoreFile = await directory.getFileHandle(".gitignore", {
          create: true,
        });
        const ignoreWritable = await ignoreFile.createWritable();
        await ignoreWritable.write(gitignoreContents);
        await ignoreWritable.close();
      }
      const mode = currentProjectSessionMode();
      const contents = serializeProjectManifest(project, mode);
      const fileHandle = await directory.getFileHandle(PROJECT_FILE_NAME, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(contents);
      await writable.close();
      return {
        project,
        handle: withManifest(browserWorkspace(directory, contents, project.projectId), writtenManifest(mode)),
      };
    } catch (error) {
      try {
        await parent.removeEntry(bundleName, { recursive: true });
      } catch {
        // Preserve the creation error. A failed best-effort rollback should not
        // disguise the operation that left the bundle incomplete.
      }
      throw error;
    }
  } catch (error) {
    const failure = classifyPickerError(error);
    if (failure === "cancelled") return null;
    if (failure === "not-allowed") {
      throw new Error(pickerNotAllowedMessage());
    }
    throw error;
  }
}

async function forgetStoredWorkspace(
  record: StoredWorkspaceRecord,
  message: string,
): Promise<WorkspaceResumeOutcome> {
  await clearStoredWorkspace(record.recordId);
  return { kind: "forgotten", message };
}

async function resumeStoredWorkspace(
  mode: ResumeMode,
): Promise<WorkspaceResumeOutcome> {
  if (isTauriRuntime() || !browserFolderAccessAvailable()) {
    return { kind: "none" };
  }
  const record = await readStoredWorkspace();
  if (!record) return { kind: "none" };

  let access: StoredWorkspaceAccess = resolveStoredWorkspaceAccess({
    record,
    permission: await queryWorkspacePermission(record),
    mode,
  });
  if (access.kind === "request-permission") {
    access = resolveStoredWorkspaceAccess({
      record,
      permission: await requestWorkspacePermission(record),
      mode,
    });
  }
  if (access.kind === "none") return { kind: "none" };
  if (access.kind === "offer-reconnect") {
    return { kind: "reconnect-required", message: access.message };
  }
  if (access.kind === "forget") {
    return forgetStoredWorkspace(record, access.message);
  }
  if (access.kind === "request-permission") {
    return {
      kind: "reconnect-required",
      message: `Reconnect ${record.displayName} to continue working with your last project.`,
    };
  }

  let read: WorkspaceReadResult;
  try {
    const contents = await readBrowserManifest(record.handle);
    readManifest(contents);
    read = { kind: "ok", contents };
  } catch (error) {
    read = {
      kind: "failed",
      failure: classifyWorkspaceReadError(error),
      ...(error instanceof Error ? { message: error.message } : {}),
    };
  }
  const load = resolveStoredWorkspaceLoad({
    displayName: record.displayName,
    mode,
    read,
  });
  if (load.kind === "offer-reconnect") {
    return { kind: "reconnect-required", message: load.message };
  }
  if (load.kind === "forget") {
    return forgetStoredWorkspace(record, load.message);
  }
  const manifest = readManifest(load.contents);
  const { project } = manifest;
  return {
    kind: "resumed",
    project,
    handle: withManifest(browserWorkspace(record.handle, load.contents, project.projectId), manifest),
  };
}

export function restoreProjectWorkspace(): Promise<WorkspaceResumeOutcome> {
  return resumeStoredWorkspace("silent");
}

export function reconnectProjectWorkspace(): Promise<WorkspaceResumeOutcome> {
  return resumeStoredWorkspace("interactive");
}

async function invokeNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function nativeWorkspaceHandle(
  workspace: NativeWorkspace,
  projectId: ProjectFile["projectId"],
): ProjectWorkspaceHandle {
  return {
    kind: "tauri-directory",
    displayName: workspace.displayName,
    displayPath: workspace.displayPath,
    storage: {
      migration: nativeMigrationStorage(workspace.workspaceId, invokeNative),
      migrationCompletion: nativeMigrationCompletionStorage(workspace.workspaceId, projectId, invokeNative),
      workbench: {
        list: () => invokeNative<WorkbenchFile[]>("list_workbench_records", { workspaceId: workspace.workspaceId }),
        mutate: (path, expectedContents, contents, projectId) => invokeNative<WorkbenchMutationResult>("mutate_workbench_record", {
          workspaceId: workspace.workspaceId, path, expectedContents, contents, projectId,
        }),
      },
      async save(contents: string): Promise<void> {
        try {
          await invokeNative("save_project_workspace", {
            workspaceId: workspace.workspaceId,
            contents,
          });
        } catch (error) {
          // The command refuses with this exact text once completion has invalidated the workspace.
          const invalidated = new ProjectHandleInvalidatedError();
          if (error === invalidated.message || (error instanceof Error && error.message === invalidated.message)) throw invalidated;
          throw error;
        }
      },
      async saveTrace(
        runId: string,
        _fileName: string,
        contents: string,
      ): Promise<void> {
        await invokeNative("save_run_trace", {
          workspaceId: workspace.workspaceId,
          runId,
          contents,
        });
      },
      async listTraces(): Promise<StoredRunTraceFile[]> {
        return invokeNative<StoredRunTraceFile[]>("list_run_traces", {
          workspaceId: workspace.workspaceId,
        });
      },
      async readTrace(fileName: string): Promise<string> {
        return invokeNative<string>("read_run_trace", {
          workspaceId: workspace.workspaceId,
          fileName: assertTraceEntryName(fileName),
        });
      },
      async saveExperimentArtifact(fileName: string, contents: string): Promise<void> {
        await invokeNative("save_experiment_artifact", {
          workspaceId: workspace.workspaceId,
          fileName: assertExperimentEntryName(fileName),
          contents,
        });
      },
      async listExperimentArtifacts(): Promise<StoredExperimentArtifactFile[]> {
        return invokeNative<StoredExperimentArtifactFile[]>("list_experiment_artifacts", {
          workspaceId: workspace.workspaceId,
        });
      },
      async readExperimentArtifact(fileName: string): Promise<string> {
        return invokeNative<string>("read_experiment_artifact", {
          workspaceId: workspace.workspaceId,
          fileName: assertExperimentEntryName(fileName),
        });
      },
      async readEvaluationBaselines(): Promise<string | null> {
        return invokeNative<string | null>("read_evaluation_baselines", {
          workspaceId: workspace.workspaceId,
        });
      },
      async saveEvaluationBaselines(contents: string): Promise<void> {
        await invokeNative("save_evaluation_baselines", {
          workspaceId: workspace.workspaceId,
          contents,
        });
      },
      async readEvaluationCaseSources(): Promise<string | null> {
        return invokeNative<string | null>("read_evaluation_case_sources", {
          workspaceId: workspace.workspaceId,
        });
      },
      async saveEvaluationCaseSources(contents: string): Promise<void> {
        await invokeNative("save_evaluation_case_sources", {
          workspaceId: workspace.workspaceId,
          contents,
        });
      },
    },
  };
}

async function openNativeProjectFolder(): Promise<OpenedProjectWorkspace | null> {
  const workspace = await invokeNative<NativeWorkspace | null>(
    "open_project_workspace",
  );
  if (!workspace) return null;
  const read = readManifest(workspace.contents);
  const { project } = read;
  return {
    project,
    handle: withManifest(nativeWorkspaceHandle(workspace, project.projectId), read),
  };
}

async function createNativeProjectFolder(
  project: ProjectFile,
  options: ProjectCreationOptions,
): Promise<OpenedProjectWorkspace | null> {
  const mode = currentProjectSessionMode();
  const workspace = await invokeNative<NativeWorkspace | null>(
    "create_project_workspace",
    {
      contents: serializeProjectManifest(project, mode),
      bundleName: projectDirectoryName(options.name),
      gitignoreContents: projectGitignoreContents(options.gitPolicy),
    },
  );
  if (!workspace) return null;
  return {
    project,
    handle: withManifest(nativeWorkspaceHandle(workspace, project.projectId), writtenManifest(mode)),
  };
}

export async function openProjectFolder(): Promise<OpenedProjectWorkspace | null> {
  return isTauriRuntime()
    ? openNativeProjectFolder()
    : openBrowserProjectFolder();
}

export async function createProjectFolder(
  project: ProjectFile,
  options: ProjectCreationOptions,
): Promise<OpenedProjectWorkspace | null> {
  return isTauriRuntime()
    ? createNativeProjectFolder(project, options)
    : createBrowserProjectFolder(project, options);
}

export async function saveProjectWorkspace(
  handle: ProjectWorkspaceHandle,
  project: ProjectFile,
  precondition?: () => Promise<void>,
): Promise<void> {
  const { mode, format } = projectWorkspaceManifest(handle);
  if (mode === "personal" && format.kind === "legacy") throw new SharedSaveBlockedError();
  await handle.storage.save(serializeProjectManifest(project, mode), precondition);
}

/** Serializes a saved run by its kind (D22, D29). */
function serializeSavedRunTrace(saved: SavedRunTrace): string {
  return saved.kind === "decision"
    ? serializeDecisionRunTrace(saved.trace)
    : serializeRunTrace(saved.trace);
}

export async function saveRunTraceWorkspace(
  handle: ProjectWorkspaceHandle,
  saved: SavedRunTrace,
): Promise<void> {
  const contents = serializeSavedRunTrace(saved);
  await handle.storage.saveTrace(
    saved.trace.runId,
    traceFileName(saved.trace.runId),
    contents,
  );
}

export async function listRunTraceWorkspace(
  handle: ProjectWorkspaceHandle,
): Promise<StoredRunTraceFile[]> {
  return handle.storage.listTraces();
}

export async function readRunTraceWorkspace(
  handle: ProjectWorkspaceHandle,
  fileName: string,
): Promise<string> {
  return handle.storage.readTrace(fileName);
}

export async function saveExperimentPlanWorkspace(
  handle: ProjectWorkspaceHandle,
  plan: ExperimentPlanV3,
): Promise<void> {
  await handle.storage.saveExperimentArtifact(
    experimentPlanFileName(plan.experimentId),
    serializeExperimentPlan(plan),
  );
}

export async function saveExperimentResultWorkspace(
  handle: ProjectWorkspaceHandle,
  result: ExperimentResult,
  plan: ExperimentPlanV3,
): Promise<void> {
  await handle.storage.saveExperimentArtifact(
    experimentResultFileName(result.experimentId),
    serializeExperimentResult(result, plan),
  );
}

/**
 * Reassessments need no new storage API and no new Tauri command: they live in
 * the experiments directory, so they inherit its write-once, reject-a-different-
 * rewrite contract on both shells for free.
 */
export async function saveEvaluationAssessmentWorkspace(
  handle: ProjectWorkspaceHandle,
  assessment: EvaluationAssessmentV1,
  plan: ExperimentPlanV3,
): Promise<void> {
  await handle.storage.saveExperimentArtifact(
    evaluationAssessmentFileName(assessment.assessmentId),
    serializeEvaluationAssessment(assessment, plan),
  );
}

export async function readEvaluationAssessmentWorkspace(
  handle: ProjectWorkspaceHandle,
  assessmentId: EvaluationAssessmentId,
  plan: ExperimentPlanV3,
): Promise<EvaluationAssessmentV1> {
  const contents = await handle.storage.readExperimentArtifact(
    evaluationAssessmentFileName(assessmentId),
  );
  return parseEvaluationAssessmentJson(contents, plan);
}

export interface LoadedEvaluationAssessments {
  assessments: EvaluationAssessmentV1[];
  /** A damaged reassessment names itself rather than disappearing from the list. */
  failures: Array<{ fileName: string; message: string }>;
}

/**
 * Reads every saved reinterpretation of one execution.
 *
 * Listing already returns artifact contents, so this needs no second read and
 * no index: the artifact's own `experimentId` is what decides whether it
 * belongs to this execution, which is exactly why the file name does not carry
 * one.
 */
export async function listEvaluationAssessmentsWorkspace(
  handle: ProjectWorkspaceHandle,
  plan: ExperimentPlanV3,
): Promise<LoadedEvaluationAssessments> {
  const files = await handle.storage.listExperimentArtifacts();
  const assessments: EvaluationAssessmentV1[] = [];
  const failures: LoadedEvaluationAssessments["failures"] = [];
  for (const file of files) {
    if (!file.fileName.endsWith(EVALUATION_ASSESSMENT_FILE_SUFFIX)) continue;
    let assessment: EvaluationAssessmentV1;
    try {
      assessment = parseEvaluationAssessmentJson(file.contents, plan);
    } catch (error) {
      // A reassessment of a different execution is not damage — it is simply
      // not ours, and `parseEvaluationAssessmentJson` cannot tell us which
      // without reading the field itself.
      const experimentId = assessmentExperimentId(file.contents);
      if (experimentId !== undefined && experimentId !== plan.experimentId) continue;
      failures.push({
        fileName: file.fileName,
        message: error instanceof Error ? error.message : "The reassessment could not be read.",
      });
      continue;
    }
    assessments.push(assessment);
  }
  assessments.sort((left, right) => left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0);
  return { assessments, failures };
}

/** Best-effort ownership read, used only to route a parse failure. */
function assessmentExperimentId(contents: string): string | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    const experimentId = (value as { experimentId?: unknown } | null)?.experimentId;
    return typeof experimentId === "string" ? experimentId : undefined;
  } catch {
    return undefined;
  }
}

export async function listExperimentArtifactsWorkspace(
  handle: ProjectWorkspaceHandle,
): Promise<StoredExperimentArtifactFile[]> {
  return handle.storage.listExperimentArtifacts();
}

export async function readExperimentArtifactWorkspace(
  handle: ProjectWorkspaceHandle,
  fileName: string,
): Promise<string> {
  return handle.storage.readExperimentArtifact(fileName);
}

/**
 * Reads the project's named evaluation baselines. A project that has never
 * pinned one reads as empty; a file that exists but cannot be parsed throws,
 * so a damaged annotation file is reported rather than quietly replaced on the
 * next pin.
 */
export async function readEvaluationBaselinesWorkspace(
  handle: ProjectWorkspaceHandle,
): Promise<EvaluationBaselinesFileV2> {
  const contents = await handle.storage.readEvaluationBaselines();
  return contents === null ? emptyEvaluationBaselines() : parseEvaluationBaselinesJson(contents);
}

export async function saveEvaluationBaselinesWorkspace(
  handle: ProjectWorkspaceHandle,
  file: EvaluationBaselinesFileV2,
): Promise<void> {
  await handle.storage.saveEvaluationBaselines(serializeEvaluationBaselines(file));
}

/** Like baselines, a missing source file is ordinary; a damaged file is surfaced. */
export async function readEvaluationCaseSourcesWorkspace(
  handle: ProjectWorkspaceHandle,
): Promise<EvaluationCaseSourcesFileV1> {
  const contents = await handle.storage.readEvaluationCaseSources();
  return contents === null ? emptyEvaluationCaseSources() : parseEvaluationCaseSourcesJson(contents);
}

export async function saveEvaluationCaseSourcesWorkspace(
  handle: ProjectWorkspaceHandle,
  file: EvaluationCaseSourcesFileV1,
): Promise<void> {
  await handle.storage.saveEvaluationCaseSources(serializeEvaluationCaseSources(file));
}

/**
 * Builds the display path for a name that already exists in the folder. A
 * discovered artifact is shown at the name it actually has, which need not be
 * the name its run ID would produce.
 */
export function runTraceWorkspacePath(
  handle: ProjectWorkspaceHandle,
  fileName: string,
): string {
  const separator =
    handle.kind === "tauri-directory" && handle.displayPath.includes("\\")
      ? "\\"
      : "/";
  return [
    handle.displayPath.replace(/[\\/]$/, ""),
    TRACES_DIRECTORY_NAME,
    fileName,
  ].join(separator);
}

export function runTraceWorkspaceLocation(
  handle: ProjectWorkspaceHandle,
  saved: SavedRunTrace,
): string {
  return runTraceWorkspacePath(handle, traceFileName(saved.trace.runId));
}

export function downloadRunTrace(saved: SavedRunTrace): void {
  const blob = new Blob([serializeSavedRunTrace(saved)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = traceFileName(saved.trace.runId);
  link.click();
  URL.revokeObjectURL(url);
}

export async function exportRunTraceFile(
  saved: SavedRunTrace,
): Promise<RunTraceExportResult> {
  const contents = serializeSavedRunTrace(saved);
  const fileName = traceFileName(saved.trace.runId);
  if (isTauriRuntime()) {
    const location = await invokeNative<string | null>("export_run_trace", {
      runId: saved.trace.runId,
      contents,
    });
    return location ? { kind: "saved", location } : { kind: "cancelled" };
  }
  downloadRunTrace(saved);
  return { kind: "downloaded", fileName };
}

/** A `personal` session exports v19 shared definitions only (S2). */
export function downloadProjectFile(project: ProjectFile, mode: ProjectSessionMode): void {
  const blob = new Blob([serializeProjectManifest(project, mode)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = projectExportFileName(project.name);
  link.click();
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  globalThis.setTimeout(() => revokeObjectURL(url), 0);
}

/** Revalidates the folder identity and exact evidence before copying a browser link. */
export async function savedRunReferenceForWorkspace(handle: ProjectWorkspaceHandle, runId: import("../packages/core/src/run-kernel/types.ts").RunId): Promise<import("../packages/core/src/run-reference.ts").RunReferenceV1> {
  const directory = browserDirectories.get(handle);
  if (!directory) throw new Error("Copying run links is currently available in the browser. Open this project folder in Chrome or Edge.");
  const { project } = await reopenProjectWorkspace(handle, browserProjectIds.get(handle)!);
  const reference = { version: 1 as const, projectId: project.projectId, runId };
  const { resolveRunReference } = await import("../packages/core/src/run-reference-resolution.ts");
  await resolveRunReference(reference, handle.storage);
  return reference;
}
