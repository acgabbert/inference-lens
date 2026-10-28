"use client";
import type { ProjectId } from "../packages/core/src/run-kernel/types.ts";
import type { FileSystemDirectoryHandleLike } from "./project-directory.client.ts";
import { openWorkspaceDatabase } from "./workspace-handle-store.client.ts";

export interface BrowserProjectLocation {
  version: 1;
  locationId: string;
  projectId: ProjectId;
  displayName: string;
  lastAccessAt: number;
  handle: FileSystemDirectoryHandleLike;
}
const STORE = "project-locations";
function isLocation(value: unknown): value is BrowserProjectLocation {
  if (!value || typeof value !== "object") return false;
  const r = value as BrowserProjectLocation;
  return r.version === 1 && typeof r.locationId === "string" && typeof r.projectId === "string" && typeof r.displayName === "string" && typeof r.lastAccessAt === "number" && r.handle?.kind === "directory" && typeof r.handle.getFileHandle === "function";
}
export async function listProjectLocations(projectId: ProjectId): Promise<BrowserProjectLocation[]> {
  const db = await openWorkspaceDatabase(); if (!db) return [];
  try {
    const values = await new Promise<unknown[]>((resolve) => {
      const request = db.transaction(STORE).objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve([]);
    });
    return values.filter(isLocation).filter(r => r.projectId === projectId);
  } catch { return []; } finally { db.close(); }
}
async function mutate(operation: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openWorkspaceDatabase(); if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      try { operation(tx.objectStore(STORE)); } catch { resolve(); }
    });
  } catch { /* Local discovery is best-effort; manual opening stays available. */ }
  finally { db.close(); }
}
async function rememberLocation(projectId: ProjectId, displayName: string, handle: FileSystemDirectoryHandleLike): Promise<void> {
  const locations = await listProjectLocations(projectId);
  let match: BrowserProjectLocation | undefined;
  for (const location of locations) {
    try { if (handle === location.handle || await handle.isSameEntry?.(location.handle)) { match = location; break; } } catch { /* stale handle */ }
  }
  const record: BrowserProjectLocation = { version: 1, locationId: match?.locationId ?? crypto.randomUUID(), projectId, displayName, lastAccessAt: Date.now(), handle };
  await mutate(store => { store.put(record); });
}
export function forgetProjectLocation(locationId: string): Promise<void> {
  return mutate(store => { store.delete(locationId); });
}

/** Serialize same-origin deduplication, including simultaneous tab adoptions. */
export async function rememberProjectLocation(projectId: ProjectId, displayName: string, handle: FileSystemDirectoryHandleLike): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request("inference-lens:project-locations", () => rememberLocation(projectId, displayName, handle));
    } else await rememberLocation(projectId, displayName, handle);
  } catch { /* Registry persistence must never prevent working in the folder. */ }
}
