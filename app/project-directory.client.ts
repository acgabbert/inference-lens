"use client";

import {
  assertTraceEntryName,
  isTraceEntryName,
} from "../packages/core/src/run-trace.ts";

export const TRACES_DIRECTORY_NAME = "traces";

export type WorkspacePermissionState = "granted" | "denied" | "prompt";

export interface FileSystemFileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
}

export interface FileSystemDirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  queryPermission?(descriptor?: {
    mode?: "read" | "readwrite";
  }): Promise<WorkspacePermissionState>;
  requestPermission?(descriptor?: {
    mode?: "read" | "readwrite";
  }): Promise<WorkspacePermissionState>;
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
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface StoredRunTraceFile {
  fileName: string;
  contents: string;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/**
 * Reads every run trace in a project folder's `traces/` directory.
 *
 * This is the browser half of a contract Rust implements natively in
 * `src-tauri/src/lib.rs`, and it carries the same three obligations: a folder
 * with no `traces/` directory yet is empty rather than broken, names that are
 * not trace artifacts are skipped rather than surfaced as damage, and the
 * result is ordered by code point so both runtimes agree. Locale-aware
 * comparison is deliberately avoided here: it would order the same folder
 * differently than the native listing does.
 */
export async function listTracesFromDirectory(
  directory: FileSystemDirectoryHandleLike,
): Promise<StoredRunTraceFile[]> {
  let traces: FileSystemDirectoryHandleLike;
  try {
    traces = await directory.getDirectoryHandle(TRACES_DIRECTORY_NAME);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const files: StoredRunTraceFile[] = [];
  for await (const entry of traces.values()) {
    if (entry.kind !== "file" || !isTraceEntryName(entry.name)) continue;
    files.push({
      fileName: entry.name,
      contents: await (await entry.getFile()).text(),
    });
  }
  return files.sort((left, right) =>
    left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0,
  );
}

/** Reads one artifact by the name it was listed under. */
export async function readTraceFromDirectory(
  directory: FileSystemDirectoryHandleLike,
  fileName: string,
): Promise<string> {
  const traces = await directory.getDirectoryHandle(TRACES_DIRECTORY_NAME);
  const fileHandle = await traces.getFileHandle(
    assertTraceEntryName(fileName),
  );
  return (await fileHandle.getFile()).text();
}
