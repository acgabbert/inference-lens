"use client";

import type { WorkspacePermissionState } from "./project-directory.client.ts";
import {
  isStoredWorkspaceRecord,
  type StoredWorkspaceRecord,
} from "./workspace-resume.client.ts";

const DB_NAME = "inference-lens";
const DB_VERSION = 1;
const STORE_NAME = "workspace-handles";
const RECORD_KEY = "last-project";

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

function transactionFinished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function readStoredWorkspace(): Promise<StoredWorkspaceRecord | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const value = await requestResult(
      transaction.objectStore(STORE_NAME).get(RECORD_KEY),
    );
    return isStoredWorkspaceRecord(value) ? value : null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export async function writeStoredWorkspace(
  record: StoredWorkspaceRecord,
): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record, RECORD_KEY);
    await transactionFinished(transaction);
  } catch {
    // Some picker implementations cannot structured-clone directory handles.
  } finally {
    database.close();
  }
}

export async function clearStoredWorkspace(
  expectedRecordId: string,
): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const current = await requestResult(store.get(RECORD_KEY));
    if (
      isStoredWorkspaceRecord(current) &&
      current.recordId === expectedRecordId
    ) {
      store.delete(RECORD_KEY);
    }
    await transactionFinished(transaction);
  } catch {
    // Persistence is best-effort; browser workspace access still works.
  } finally {
    database.close();
  }
}

export async function queryWorkspacePermission(
  record: StoredWorkspaceRecord,
): Promise<WorkspacePermissionState> {
  if (!record.handle.queryPermission) return "prompt";
  try {
    return await record.handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "prompt";
  }
}

export async function requestWorkspacePermission(
  record: StoredWorkspaceRecord,
): Promise<WorkspacePermissionState> {
  if (!record.handle.requestPermission) return "granted";
  try {
    return await record.handle.requestPermission({ mode: "readwrite" });
  } catch {
    // Only an explicit "denied" result authorizes forgetting the capability.
    // A transient browser error leaves it available for a later retry.
    return "prompt";
  }
}
