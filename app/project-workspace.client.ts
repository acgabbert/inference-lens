"use client";

import {
  PROJECT_FILE_NAME,
  PROJECT_GITIGNORE_CONTENTS,
  parseProjectJson,
  projectDirectoryName,
  projectExportFileName,
  serializeProjectFile,
} from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import {
  assertTraceEntryName,
  serializeRunTrace,
  traceFileName,
} from "../packages/core/src/run-trace.ts";
import type { RunTrace } from "../packages/core/src/run-kernel/index.ts";
import {
  listTracesFromDirectory,
  readTraceFromDirectory,
  TRACES_DIRECTORY_NAME,
} from "./project-directory.client.ts";
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
  StoredRunTraceFile,
} from "./project-directory.client.ts";
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
  save(contents: string): Promise<void>;
  saveTrace(runId: string, fileName: string, contents: string): Promise<void>;
  listTraces(): Promise<StoredRunTraceFile[]>;
  readTrace(fileName: string): Promise<string>;
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

export type WorkspaceResumeOutcome =
  | { kind: "resumed"; project: ProjectFile; handle: ProjectWorkspaceHandle }
  | { kind: "reconnect-required"; message: string }
  | { kind: "forgotten"; message: string }
  | { kind: "none" };

export interface ProjectCreationOptions {
  name: string;
  protectFromGit: boolean;
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

function browserStorage(
  directory: FileSystemDirectoryHandleLike,
  initialContents: string,
): WorkspaceStorage {
  let lastContents = initialContents;
  return {
    async save(contents: string): Promise<void> {
      const fileHandle = await directory.getFileHandle(PROJECT_FILE_NAME);
      const currentContents = await (await fileHandle.getFile()).text();
      if (currentContents !== lastContents) {
        throw new Error(
          `${PROJECT_FILE_NAME} changed outside Inference Lens. Reopen the project before saving.`,
        );
      }
      const writable = await fileHandle.createWritable();
      await writable.write(contents);
      await writable.close();
      lastContents = contents;
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
  };
}

function browserWorkspace(
  directory: FileSystemDirectoryHandleLike,
  contents: string,
): ProjectWorkspaceHandle {
  return {
    kind: "browser-directory",
    displayName: directory.name,
    displayPath: directory.name,
    storage: browserStorage(directory, contents),
  };
}

async function rememberBrowserWorkspace(
  directory: FileSystemDirectoryHandleLike,
  project: ProjectFile,
): Promise<void> {
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
    const project = parseProjectJson(contents);
    await rememberBrowserWorkspace(directory, project);
    return {
      project,
      handle: browserWorkspace(directory, contents),
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
      if (options.protectFromGit) {
        const ignoreFile = await directory.getFileHandle(".gitignore", {
          create: true,
        });
        const ignoreWritable = await ignoreFile.createWritable();
        await ignoreWritable.write(PROJECT_GITIGNORE_CONTENTS);
        await ignoreWritable.close();
      }
      const contents = serializeProjectFile(project);
      const fileHandle = await directory.getFileHandle(PROJECT_FILE_NAME, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(contents);
      await writable.close();
      await rememberBrowserWorkspace(directory, project);
      return {
        project,
        handle: browserWorkspace(directory, contents),
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
    parseProjectJson(contents);
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
  return {
    kind: "resumed",
    project: parseProjectJson(load.contents),
    handle: browserWorkspace(record.handle, load.contents),
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
): ProjectWorkspaceHandle {
  return {
    kind: "tauri-directory",
    displayName: workspace.displayName,
    displayPath: workspace.displayPath,
    storage: {
      async save(contents: string): Promise<void> {
        await invokeNative("save_project_workspace", {
          workspaceId: workspace.workspaceId,
          contents,
        });
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
    },
  };
}

async function openNativeProjectFolder(): Promise<OpenedProjectWorkspace | null> {
  const workspace = await invokeNative<NativeWorkspace | null>(
    "open_project_workspace",
  );
  if (!workspace) return null;
  return {
    project: parseProjectJson(workspace.contents),
    handle: nativeWorkspaceHandle(workspace),
  };
}

async function createNativeProjectFolder(
  project: ProjectFile,
  options: ProjectCreationOptions,
): Promise<OpenedProjectWorkspace | null> {
  const workspace = await invokeNative<NativeWorkspace | null>(
    "create_project_workspace",
    {
      contents: serializeProjectFile(project),
      bundleName: projectDirectoryName(options.name),
      protectFromGit: options.protectFromGit,
    },
  );
  if (!workspace) return null;
  return {
    project,
    handle: nativeWorkspaceHandle(workspace),
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
): Promise<void> {
  await handle.storage.save(serializeProjectFile(project));
}

export async function saveRunTraceWorkspace(
  handle: ProjectWorkspaceHandle,
  trace: RunTrace,
): Promise<void> {
  const contents = serializeRunTrace(trace);
  await handle.storage.saveTrace(
    trace.runId,
    traceFileName(trace.runId),
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
  trace: RunTrace,
): string {
  return runTraceWorkspacePath(handle, traceFileName(trace.runId));
}

export function downloadRunTrace(trace: RunTrace): void {
  const blob = new Blob([serializeRunTrace(trace)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = traceFileName(trace.runId);
  link.click();
  URL.revokeObjectURL(url);
}

export async function exportRunTraceFile(
  trace: RunTrace,
): Promise<RunTraceExportResult> {
  const contents = serializeRunTrace(trace);
  const fileName = traceFileName(trace.runId);
  if (isTauriRuntime()) {
    const location = await invokeNative<string | null>("export_run_trace", {
      runId: trace.runId,
      contents,
    });
    return location ? { kind: "saved", location } : { kind: "cancelled" };
  }
  downloadRunTrace(trace);
  return { kind: "downloaded", fileName };
}

export function downloadProjectFile(project: ProjectFile): void {
  const blob = new Blob([serializeProjectFile(project)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = projectExportFileName(project.name);
  link.click();
  URL.revokeObjectURL(url);
}
