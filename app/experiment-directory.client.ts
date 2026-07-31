"use client";

import {
  assertExperimentEntryName,
  isExperimentEntryName,
} from "../packages/core/src/experiment.ts";
import type {
  FileSystemDirectoryHandleLike,
  StoredRunTraceFile,
} from "./project-directory.client.ts";

export const EXPERIMENTS_DIRECTORY_NAME = "experiments";
export type StoredExperimentArtifactFile = StoredRunTraceFile;

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/**
 * Browser-side counterpart to the native experiment-artifact directory
 * operations. Entries are discovered defensively and ordered by code point so
 * listing produces the same result in browser and Tauri workspaces.
 */
export async function listExperimentArtifactsFromDirectory(
  directory: FileSystemDirectoryHandleLike,
): Promise<StoredExperimentArtifactFile[]> {
  let experiments: FileSystemDirectoryHandleLike;
  try {
    experiments = await directory.getDirectoryHandle(EXPERIMENTS_DIRECTORY_NAME);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const files: StoredExperimentArtifactFile[] = [];
  for await (const entry of experiments.values()) {
    if (entry.kind !== "file" || !isExperimentEntryName(entry.name)) continue;
    files.push({
      fileName: entry.name,
      contents: await (await entry.getFile()).text(),
    });
  }
  return files.sort((left, right) =>
    left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0,
  );
}

export async function readExperimentArtifactFromDirectory(
  directory: FileSystemDirectoryHandleLike,
  fileName: string,
): Promise<string> {
  const experiments = await directory.getDirectoryHandle(EXPERIMENTS_DIRECTORY_NAME);
  const fileHandle = await experiments.getFileHandle(assertExperimentEntryName(fileName));
  return (await fileHandle.getFile()).text();
}
