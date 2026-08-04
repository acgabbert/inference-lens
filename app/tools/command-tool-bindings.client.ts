"use client";

import type { CommandToolDeclaration } from "../../packages/core/src/command-tool-catalog.ts";
import type { ToolId } from "../../packages/core/src/run-kernel/index.ts";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";

/**
 * The device-local binding registry T1 left for the first executor that has
 * something device-local to remember.
 *
 * What it remembers is deliberately thin: which declared command a tool may
 * run, and when that was granted. The executable, its arguments, and its
 * timeout stay in the operator's catalog, so this record is safe in browser
 * storage — losing it costs a re-grant, and stealing it reveals a command id.
 *
 * The grant *is* the consent. There is no separate approval flag, because a
 * second toggle would let a stored grant mean two different things.
 */

export const COMMAND_TOOL_GRANTS_STORAGE_KEY =
  "inference-lens:command-tool-grants:v1";

export interface CommandToolGrant {
  toolId: ToolId;
  /** A command id from the host's catalog. */
  commandId: string;
  /** When the user allowed this tool to run that command, ISO 8601. */
  grantedAt: string;
}

/**
 * One grant per tool. A tool call has exactly one answer, so a second grant
 * replaces the first rather than accumulating an ambiguity the run would have
 * to resolve at the worst possible moment.
 */
export function withCommandToolGrant(
  grants: readonly CommandToolGrant[],
  toolId: ToolId,
  commandId: string,
  grantedAt: string,
): CommandToolGrant[] {
  return [
    ...grants.filter((grant) => grant.toolId !== toolId),
    { toolId, commandId, grantedAt },
  ];
}

export function withoutCommandToolGrant(
  grants: readonly CommandToolGrant[],
  toolId: ToolId,
): CommandToolGrant[] {
  return grants.filter((grant) => grant.toolId !== toolId);
}

export function findCommandToolGrant(
  grants: readonly CommandToolGrant[],
  toolId: ToolId,
): CommandToolGrant | undefined {
  return grants.find((grant) => grant.toolId === toolId);
}

/**
 * The binding a grant stands for, or nothing when the command it names is no
 * longer declared.
 *
 * A grant that outlives its declaration must not resolve: an operator removing
 * a command from the catalog is revoking it, and a binding derived from a
 * remembered label would keep claiming a tool is served.
 */
export function commandToolBinding(
  grant: CommandToolGrant,
  declarations: readonly CommandToolDeclaration[],
): ToolBinding | undefined {
  const declaration = declarations.find(({ id }) => id === grant.commandId);
  if (!declaration) return undefined;
  return {
    toolId: grant.toolId,
    kind: "command",
    executorId: declaration.id,
    label: declaration.label,
    grantedAt: grant.grantedAt,
  };
}

function isGrant(value: unknown): value is CommandToolGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Partial<CommandToolGrant>;
  return (
    typeof grant.toolId === "string" &&
    typeof grant.commandId === "string" &&
    typeof grant.grantedAt === "string"
  );
}

export function readCommandToolGrants(): CommandToolGrant[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(COMMAND_TOOL_GRANTS_STORAGE_KEY) ?? "null",
    );
    if (!Array.isArray(value)) return [];
    return value.filter(isGrant);
  } catch {
    return [];
  }
}

export function writeCommandToolGrants(
  grants: readonly CommandToolGrant[],
): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    COMMAND_TOOL_GRANTS_STORAGE_KEY,
    JSON.stringify(grants),
  );
}
