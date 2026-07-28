"use client";

import {
  ToolRegistryValidationError,
  emptyToolRegistry,
  mergeToolRegistries,
  parseToolRegistry,
  parseToolRegistryFile,
} from "../packages/core/src/tool-registry";
import type {
  RegistryToolId,
  ToolRegistrySnapshot,
  ToolRegistryV1,
} from "../packages/core/src/tool-registry";

const STORAGE_KEY = "inference-lens:tool-registry:v1";
const CACHE_VERSION = 2;

export type ToolRegistrySyncStatus =
  | { kind: "server" }
  | { kind: "local" }
  | { kind: "saving" }
  | { kind: "degraded"; message: string }
  | { kind: "conflict"; message: string; toolIds: RegistryToolId[] };

export interface ToolRegistrySession {
  source: "server" | "local";
  base: ToolRegistrySnapshot | null;
  registry: ToolRegistryV1;
  pending: boolean;
}

interface ToolRegistryClientCache {
  version: 2;
  registry: ToolRegistryV1;
  serverBase?: ToolRegistrySnapshot;
  pendingServerRegistry?: ToolRegistryV1;
}

type Fetcher = typeof fetch;

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function snapshot(value: unknown): ToolRegistrySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolRegistryValidationError([{ code: "custom", path: [], message: "Server response must be an object." }]);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !("registry" in record) || !("revision" in record) || (record.revision !== null && typeof record.revision !== "string")) {
    throw new ToolRegistryValidationError([{ code: "custom", path: [], message: "Server response is not a registry snapshot." }]);
  }
  return { registry: parseToolRegistryFile(record.registry), revision: record.revision };
}

function readCache(): ToolRegistryClientCache {
  if (typeof window === "undefined") return { version: CACHE_VERSION, registry: emptyToolRegistry() };
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (value && typeof value === "object" && !Array.isArray(value) && (value as { version?: unknown }).version === CACHE_VERSION) {
      const cache = value as Record<string, unknown>;
      const result: ToolRegistryClientCache = { version: CACHE_VERSION, registry: parseToolRegistryFile(cache.registry) };
      if (cache.serverBase !== undefined) result.serverBase = snapshot(cache.serverBase);
      if (cache.pendingServerRegistry !== undefined) result.pendingServerRegistry = parseToolRegistryFile(cache.pendingServerRegistry);
      return result;
    }
    return { version: CACHE_VERSION, registry: parseToolRegistry(value) };
  } catch {
    return { version: CACHE_VERSION, registry: emptyToolRegistry() };
  }
}

function writeCache(cache: ToolRegistryClientCache): void {
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
}

function cacheSession(session: ToolRegistrySession): void {
  writeCache({
    version: CACHE_VERSION,
    registry: session.registry,
    ...(session.base ? { serverBase: session.base } : {}),
    ...(session.pending && session.source === "server" ? { pendingServerRegistry: session.registry } : {}),
  });
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new ToolRegistryValidationError([{ code: "custom", path: [], message: "Server returned invalid JSON." }]); }
}

async function fetchSnapshot(fetcher: Fetcher): Promise<ToolRegistrySnapshot> {
  const response = await fetcher("/api/tool-registry", { cache: "no-store" });
  if (!response.ok) throw new Error(`Server returned ${response.status}.`);
  return snapshot(await json(response));
}

export async function loadToolRegistrySession(fetcher: Fetcher = fetch): Promise<{ session: ToolRegistrySession; status: ToolRegistrySyncStatus }> {
  const cache = readCache();
  try {
    const response = await fetcher("/api/tool-registry", { cache: "no-store" });
    if (response.status === 404) {
      const session = { source: "local" as const, base: null, registry: cache.registry, pending: false };
      cacheSession(session);
      return { session, status: { kind: "local" } };
    }
    if (!response.ok) throw new Error(`Server returned ${response.status}.`);
    const remote = snapshot(await json(response));
    if (cache.pendingServerRegistry) {
      if (!cache.serverBase) {
        const session = { source: "server" as const, base: remote, registry: cache.pendingServerRegistry, pending: true };
        cacheSession(session);
        return { session, status: { kind: "conflict", message: "A pending local edit has no server base to merge with.", toolIds: [] } };
      }
      const merged = mergeToolRegistries(cache.serverBase.registry, cache.pendingServerRegistry, remote.registry);
      if (merged.kind === "conflict") {
        const session = { source: "server" as const, base: remote, registry: cache.pendingServerRegistry, pending: true };
        cacheSession(session);
        return { session, status: { kind: "conflict", message: "The shared library changed the same tool.", toolIds: merged.toolIds } };
      }
      const session = { source: "server" as const, base: remote, registry: merged.registry, pending: true };
      return saveToolRegistrySession(session, merged.registry, fetcher);
    }
    const session = { source: "server" as const, base: remote, registry: remote.registry, pending: false };
    cacheSession(session);
    return { session, status: { kind: "server" } };
  } catch (error) {
    const session = { source: "server" as const, base: cache.serverBase ?? null, registry: cache.pendingServerRegistry ?? cache.registry, pending: Boolean(cache.pendingServerRegistry) };
    cacheSession(session);
    return { session, status: { kind: "degraded", message: message(error, "The shared library could not be loaded.") } };
  }
}

/** Tauri has no Node /data host, so its registry remains browser-local. */
export function loadLocalToolRegistrySession(): { session: ToolRegistrySession; status: ToolRegistrySyncStatus } {
  const cache = readCache();
  const session = { source: "local" as const, base: null, registry: cache.registry, pending: false };
  cacheSession(session);
  return { session, status: { kind: "local" } };
}

export async function saveToolRegistrySession(session: ToolRegistrySession, registry: ToolRegistryV1, fetcher: Fetcher = fetch): Promise<{ session: ToolRegistrySession; status: ToolRegistrySyncStatus }> {
  const desired = parseToolRegistryFile(registry);
  if (session.source === "local") {
    const next = { ...session, registry: desired, pending: false };
    cacheSession(next);
    return { session: next, status: { kind: "local" } };
  }
  if (!session.base) {
    const next = { ...session, registry: desired, pending: true };
    cacheSession(next);
    return { session: next, status: { kind: "conflict", message: "The shared library must be reloaded before saving.", toolIds: [] } };
  }
  async function put(expectedRevision: string | null, replacement: ToolRegistryV1): Promise<Response> {
    return fetcher("/api/tool-registry", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ registry: replacement, expectedRevision }) });
  }
  try {
    let response = await put(session.base.revision, desired);
    if (response.status === 409) {
      const remote = await fetchSnapshot(fetcher);
      const merged = mergeToolRegistries(session.base.registry, desired, remote.registry);
      if (merged.kind === "conflict") {
        const next = { ...session, registry: desired, pending: true };
        cacheSession(next);
        return { session: next, status: { kind: "conflict", message: "The shared library changed the same tool.", toolIds: merged.toolIds } };
      }
      response = await put(remote.revision, merged.registry);
      if (response.status === 409) throw new Error("The shared library changed again while merging. Retry the save.");
    }
    if (!response.ok) throw new Error(`Server returned ${response.status}.`);
    const saved = snapshot(await json(response));
    const next = { source: "server" as const, base: saved, registry: saved.registry, pending: false };
    cacheSession(next);
    return { session: next, status: { kind: "server" } };
  } catch (error) {
    const next = { ...session, registry: desired, pending: true };
    cacheSession(next);
    return { session: next, status: { kind: "degraded", message: message(error, "The shared library could not be saved.") } };
  }
}

export async function restoreServerToolRegistry(session: ToolRegistrySession, fetcher: Fetcher = fetch) {
  const remote = await fetchSnapshot(fetcher);
  const next = { source: "server" as const, base: remote, registry: remote.registry, pending: false };
  cacheSession(next);
  return { session: next, status: { kind: "server" } as ToolRegistrySyncStatus };
}

export async function overwriteServerToolRegistry(session: ToolRegistrySession, fetcher: Fetcher = fetch) {
  const remote = await fetchSnapshot(fetcher);
  return saveToolRegistrySession({ ...session, source: "server", base: remote }, session.registry, fetcher);
}
