"use client";

import { useSyncExternalStore } from "react";

import type { McpServerSummary } from "../../packages/contracts/src/mcp-discovery.ts";
import type { ToolBindingCheckItem } from "../../packages/contracts/src/tool-binding-check.ts";
import type { ToolDefinition, ToolId } from "../../packages/core/src/run-kernel/index.ts";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";

/**
 * The one device-local record of what the user allowed each tool to run.
 *
 * A grant is the user's intent, not an authorization boundary: the host checks
 * every call against its own catalogs, which are the ceiling. That is why it
 * can live in browser storage, and why command and MCP grants share one
 * record — one grant per tool, one revocation path, one preflight.
 *
 * Grants never enter a project, run input, experiment plan, or trace.
 */

export const LOCAL_TOOL_GRANTS_STORAGE_KEY = "inference-lens:tool-grants:v2";
/** Command grants before MCP shared the record. Read once, then removed. */
export const LEGACY_COMMAND_TOOL_GRANTS_STORAGE_KEY = "inference-lens:command-tool-grants:v1";

export interface CommandToolGrant {
  kind: "command";
  toolId: ToolId;
  /** A command id from the host's catalog. */
  commandId: string;
  /** When the user allowed this tool to run that command, ISO 8601. */
  grantedAt: string;
}

export interface McpToolGrant {
  kind: "mcp";
  toolId: ToolId;
  serverId: string;
  remoteToolName: string;
  /** The discovery fingerprint of the snapshot the user granted. */
  discoveryFingerprint: string;
  /**
   * Interactive approval only: ask at every call, or run without asking. A
   * batch ignores it — its confirmation is the approval for every call.
   */
  mode: "ask" | "automatic";
  grantedAt: string;
}

export type LocalToolGrant = CommandToolGrant | McpToolGrant;

type GrantStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isGrant(value: unknown): value is LocalToolGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Record<string, unknown>;
  if (!isString(grant.toolId) || !isString(grant.grantedAt)) return false;
  if (grant.kind === "command") return isString(grant.commandId);
  return grant.kind === "mcp" &&
    isString(grant.serverId) &&
    isString(grant.remoteToolName) &&
    isString(grant.discoveryFingerprint) &&
    (grant.mode === "ask" || grant.mode === "automatic");
}

function parseArray(raw: string | null): unknown[] | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function defaultStorage(): GrantStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Reads every grant, migrating Version 1 command grants on first read.
 *
 * Version 2 wins when both keys exist, and the Version 1 key is removed once a
 * Version 2 record is in place, so a grant revoked after migration can never
 * come back from the old key.
 */
export function readLocalToolGrants(storage: GrantStorage | undefined = defaultStorage()): LocalToolGrant[] {
  if (!storage) return [];
  try {
    const current = parseArray(storage.getItem(LOCAL_TOOL_GRANTS_STORAGE_KEY));
    const legacy = parseArray(storage.getItem(LEGACY_COMMAND_TOOL_GRANTS_STORAGE_KEY));
    if (current) {
      if (legacy) storage.removeItem(LEGACY_COMMAND_TOOL_GRANTS_STORAGE_KEY);
      return current.filter(isGrant);
    }
    if (!legacy) return [];
    const migrated = legacy
      .map((value) => (value && typeof value === "object" ? { ...value, kind: "command" } : value))
      .filter(isGrant);
    storage.setItem(LOCAL_TOOL_GRANTS_STORAGE_KEY, JSON.stringify(migrated));
    storage.removeItem(LEGACY_COMMAND_TOOL_GRANTS_STORAGE_KEY);
    return migrated;
  } catch {
    return [];
  }
}

export function writeLocalToolGrants(
  grants: readonly LocalToolGrant[],
  storage: GrantStorage | undefined = defaultStorage(),
): void {
  storage?.setItem(LOCAL_TOOL_GRANTS_STORAGE_KEY, JSON.stringify(grants));
}

/**
 * One grant per tool, of any kind. A tool call has exactly one answer, so a
 * second grant replaces the first rather than leaving the run to choose.
 */
export function withLocalToolGrant(
  grants: readonly LocalToolGrant[],
  grant: LocalToolGrant,
): LocalToolGrant[] {
  return [...grants.filter(({ toolId }) => toolId !== grant.toolId), grant];
}

export function withoutLocalToolGrant(
  grants: readonly LocalToolGrant[],
  toolId: ToolId,
): LocalToolGrant[] {
  return grants.filter((grant) => grant.toolId !== toolId);
}

/** How the host is asked whether a grant can still be served. */
export function localToolGrantCheckItem(grant: LocalToolGrant): ToolBindingCheckItem {
  return grant.kind === "command"
    ? { toolId: grant.toolId, kind: "command", commandId: grant.commandId }
    : {
        toolId: grant.toolId,
        kind: "mcp",
        serverId: grant.serverId,
        remoteToolName: grant.remoteToolName,
        discoveryFingerprint: grant.discoveryFingerprint,
      };
}

/**
 * The binding an MCP grant stands for, or nothing.
 *
 * It resolves only for the snapshot it was granted against and only while the
 * server is still declared. Whether the live server still matches is the
 * host's to check, at preflight and before every call.
 */
export function mcpToolBinding(
  grant: McpToolGrant,
  tool: ToolDefinition,
  servers: readonly McpServerSummary[],
): ToolBinding | undefined {
  if (tool.id !== grant.toolId || tool.source?.kind !== "mcp" ||
      tool.source.remoteToolName !== grant.remoteToolName ||
      tool.source.discoveryFingerprint !== grant.discoveryFingerprint) return undefined;
  const server = servers.find(({ id }) => id === grant.serverId);
  if (!server) return undefined;
  return {
    kind: "mcp",
    toolId: tool.id,
    executorId: `${grant.remoteToolName}@${grant.discoveryFingerprint.slice(0, 12)}`,
    label: server.label,
    serverId: grant.serverId,
    remoteToolName: grant.remoteToolName,
    discoveryFingerprint: grant.discoveryFingerprint,
  };
}

// One snapshot shared by every subscriber, so the command and MCP owners can
// never hold two different copies of the same record.
const EMPTY: readonly LocalToolGrant[] = Object.freeze([]);
let snapshot: readonly LocalToolGrant[] | undefined;
const listeners = new Set<() => void>();

function currentSnapshot(): readonly LocalToolGrant[] {
  snapshot ??= readLocalToolGrants();
  return snapshot;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== LOCAL_TOOL_GRANTS_STORAGE_KEY && event.key !== null) return;
    snapshot = undefined;
    notify();
  };
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/** Replaces the record through `update` and tells every subscriber. */
export function updateLocalToolGrants(
  update: (grants: readonly LocalToolGrant[]) => LocalToolGrant[],
): void {
  const next = update(readLocalToolGrants());
  writeLocalToolGrants(next);
  snapshot = next;
  notify();
}

/** Every grant on this device. Empty during server rendering. */
export function useLocalToolGrants(): readonly LocalToolGrant[] {
  return useSyncExternalStore(subscribe, currentSnapshot, () => EMPTY);
}
