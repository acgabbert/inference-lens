"use client";

import {
  PROJECT_FILE_NAME,
  parseProjectJson,
  serializeProjectFile,
} from "../packages/core/src/project";
import type { ProjectFileV2 } from "../packages/core/src/project";
import {
  serializeRunTrace,
  traceFileName,
} from "../packages/core/src/run-trace";
import type { RunTrace } from "../packages/core/src/run-kernel";
import { isTauriRuntime } from "./tauri-inference-transport.client";

interface FileSystemFileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
}

interface FileSystemDirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterableIterator<
    FileSystemFileHandleLike | FileSystemDirectoryHandleLike
  >;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandleLike>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandleLike>;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandleLike>;
}

interface WorkspaceStorage {
  save(contents: string): Promise<void>;
  saveTrace(runId: string, fileName: string, contents: string): Promise<void>;
  listTraces(): Promise<StoredRunTraceFile[]>;
}

export interface ProjectWorkspaceHandle {
  kind: "browser-directory" | "tauri-directory";
  displayName: string;
  /** Human-readable only; never passed back to a filesystem command. */
  displayPath: string;
  storage: WorkspaceStorage;
}

export interface OpenedProjectWorkspace {
  project: ProjectFileV2;
  handle: ProjectWorkspaceHandle;
}

interface NativeWorkspace {
  workspaceId: string;
  displayName: string;
  displayPath: string;
  contents: string;
}

export interface StoredRunTraceFile {
  fileName: string;
  contents: string;
}

export type RunTraceExportResult =
  | { kind: "saved"; location: string }
  | { kind: "downloaded"; fileName: string }
  | { kind: "cancelled" };

function isPickerCancellation(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "NotAllowedError")
  );
}

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
  let fileHandle: FileSystemFileHandleLike;
  try {
    fileHandle = await directory.getFileHandle(PROJECT_FILE_NAME);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      throw new Error(
        `The selected folder does not contain ${PROJECT_FILE_NAME}.`,
      );
    }
    throw error;
  }
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
          `${PROJECT_FILE_NAME} changed outside Trace Lens. Reopen the project before saving.`,
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
      const traces = await directory.getDirectoryHandle("traces", {
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
      let traces: FileSystemDirectoryHandleLike;
      try {
        traces = await directory.getDirectoryHandle("traces");
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") {
          return [];
        }
        throw error;
      }

      const files: StoredRunTraceFile[] = [];
      for await (const entry of traces.values()) {
        if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
        files.push({
          fileName: entry.name,
          contents: await (await entry.getFile()).text(),
        });
      }
      return files.sort((left, right) =>
        left.fileName.localeCompare(right.fileName),
      );
    },
  };
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
      id: "trace-lens-project",
      mode: "readwrite",
    });
    const contents = await readBrowserManifest(directory);
    return {
      project: parseProjectJson(contents),
      handle: {
        kind: "browser-directory",
        displayName: directory.name,
        displayPath: directory.name,
        storage: browserStorage(directory, contents),
      },
    };
  } catch (error) {
    if (isPickerCancellation(error)) return null;
    throw error;
  }
}

async function createBrowserProjectFolder(
  project: ProjectFileV2,
): Promise<OpenedProjectWorkspace | null> {
  const showDirectoryPicker = picker();
  if (!showDirectoryPicker) {
    throw new Error(
      "This browser does not support project folders. Use Export instead.",
    );
  }
  try {
    const directory = await showDirectoryPicker({
      id: "trace-lens-project",
      mode: "readwrite",
    });
    try {
      await directory.getFileHandle(PROJECT_FILE_NAME);
      throw new Error(
        `The selected folder already contains ${PROJECT_FILE_NAME}. Open it instead.`,
      );
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
        throw error;
      }
    }
    const contents = serializeProjectFile(project);
    const fileHandle = await directory.getFileHandle(PROJECT_FILE_NAME, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
    return {
      project,
      handle: {
        kind: "browser-directory",
        displayName: directory.name,
        displayPath: directory.name,
        storage: browserStorage(directory, contents),
      },
    };
  } catch (error) {
    if (isPickerCancellation(error)) return null;
    throw error;
  }
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
  project: ProjectFileV2,
): Promise<OpenedProjectWorkspace | null> {
  const workspace = await invokeNative<NativeWorkspace | null>(
    "create_project_workspace",
    { contents: serializeProjectFile(project) },
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
  project: ProjectFileV2,
): Promise<OpenedProjectWorkspace | null> {
  return isTauriRuntime()
    ? createNativeProjectFolder(project)
    : createBrowserProjectFolder(project);
}

export async function saveProjectWorkspace(
  handle: ProjectWorkspaceHandle,
  project: ProjectFileV2,
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

export function runTraceWorkspaceLocation(
  handle: ProjectWorkspaceHandle,
  trace: RunTrace,
): string {
  const separator =
    handle.kind === "tauri-directory" && handle.displayPath.includes("\\")
      ? "\\"
      : "/";
  return [
    handle.displayPath.replace(/[\\/]$/, ""),
    "traces",
    traceFileName(trace.runId),
  ].join(separator);
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

export function downloadProjectFile(project: ProjectFileV2): void {
  const blob = new Blob([serializeProjectFile(project)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = PROJECT_FILE_NAME;
  link.click();
  URL.revokeObjectURL(url);
}
