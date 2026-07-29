"use client";

import { PROJECT_FILE_NAME } from "../packages/core/src/project.ts";
import type {
  FileSystemDirectoryHandleLike,
  WorkspacePermissionState,
} from "./project-directory.client.ts";

export interface StoredWorkspaceRecord {
  version: 1;
  recordId: string;
  kind: "browser-directory";
  displayName: string;
  projectName?: string;
  handle: FileSystemDirectoryHandleLike;
  savedAt: number;
}

export type PickerFailure = "cancelled" | "not-allowed" | "other";
export type WorkspaceReadFailure =
  | "not-found"
  | "not-allowed"
  | "unreadable";
export type WorkspaceForgetReason = "permission-denied" | "project-missing";
export type ResumeMode = "silent" | "interactive";

export type StoredWorkspaceAccess =
  | { kind: "none" }
  | { kind: "read" }
  | { kind: "request-permission" }
  | { kind: "offer-reconnect"; message: string }
  | {
      kind: "forget";
      reason: WorkspaceForgetReason;
      message: string;
    };

export type WorkspaceReadResult =
  | { kind: "ok"; contents: string }
  | {
      kind: "failed";
      failure: WorkspaceReadFailure;
      message?: string;
    };

export type StoredWorkspaceLoad =
  | { kind: "open"; contents: string }
  | { kind: "offer-reconnect"; message: string }
  | {
      kind: "forget";
      reason: WorkspaceForgetReason;
      message: string;
    };

function domErrorName(error: unknown): string | undefined {
  return error instanceof DOMException ? error.name : undefined;
}

export function classifyPickerError(error: unknown): PickerFailure {
  switch (domErrorName(error)) {
    case "AbortError":
      return "cancelled";
    case "NotAllowedError":
      return "not-allowed";
    default:
      return "other";
  }
}

export function classifyWorkspaceReadError(
  error: unknown,
): WorkspaceReadFailure {
  switch (domErrorName(error)) {
    case "NotFoundError":
      return "not-found";
    case "NotAllowedError":
    case "SecurityError":
      return "not-allowed";
    default:
      return "unreadable";
  }
}

export function pickerNotAllowedMessage(): string {
  return "Inference Lens does not have permission to open that folder. Allow file editing for this site and try again.";
}

function permissionDeniedMessage(displayName: string): string {
  return `Permission to reopen ${displayName} was denied. The remembered project has been removed.`;
}

function reconnectMessage(displayName: string): string {
  return `Reconnect ${displayName} to continue working with your last project.`;
}

function missingProjectMessage(displayName: string): string {
  return `${displayName} or its ${PROJECT_FILE_NAME} file is no longer available. The remembered project has been removed.`;
}

export function isStoredWorkspaceRecord(
  value: unknown,
): value is StoredWorkspaceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredWorkspaceRecord>;
  const handle = record.handle as
    | Partial<FileSystemDirectoryHandleLike>
    | undefined;
  return (
    record.version === 1 &&
    record.kind === "browser-directory" &&
    typeof record.recordId === "string" &&
    record.recordId.trim().length > 0 &&
    typeof record.displayName === "string" &&
    record.displayName.trim().length > 0 &&
    (record.projectName === undefined ||
      typeof record.projectName === "string") &&
    typeof record.savedAt === "number" &&
    Number.isFinite(record.savedAt) &&
    handle?.kind === "directory" &&
    typeof handle.name === "string" &&
    typeof handle.getFileHandle === "function" &&
    typeof handle.getDirectoryHandle === "function"
  );
}

export function resolveStoredWorkspaceAccess(input: {
  record: StoredWorkspaceRecord | null;
  permission: WorkspacePermissionState;
  mode: ResumeMode;
}): StoredWorkspaceAccess {
  const { record, permission, mode } = input;
  if (!record) return { kind: "none" };
  if (permission === "granted") return { kind: "read" };
  if (permission === "denied") {
    return {
      kind: "forget",
      reason: "permission-denied",
      message: permissionDeniedMessage(record.displayName),
    };
  }
  return mode === "interactive"
    ? { kind: "request-permission" }
    : {
        kind: "offer-reconnect",
        message: reconnectMessage(record.displayName),
      };
}

export function resolveStoredWorkspaceLoad(input: {
  displayName: string;
  mode: ResumeMode;
  read: WorkspaceReadResult;
}): StoredWorkspaceLoad {
  const { displayName, mode, read } = input;
  if (read.kind === "ok") return { kind: "open", contents: read.contents };
  if (read.failure === "not-found") {
    return {
      kind: "forget",
      reason: "project-missing",
      message: missingProjectMessage(displayName),
    };
  }
  if (read.failure === "not-allowed") {
    return mode === "interactive"
      ? {
          kind: "forget",
          reason: "permission-denied",
          message: permissionDeniedMessage(displayName),
        }
      : {
          kind: "offer-reconnect",
          message: reconnectMessage(displayName),
        };
  }
  return {
    kind: "offer-reconnect",
    message:
      read.message ??
      `Could not read ${PROJECT_FILE_NAME} from ${displayName}. Reconnect to try again.`,
  };
}
