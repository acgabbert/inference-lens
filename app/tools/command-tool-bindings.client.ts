"use client";

import type { CommandToolDeclaration } from "../../packages/core/src/command-tool-catalog.ts";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";
import type { CommandToolGrant } from "./local-tool-grants.client.ts";

/**
 * What a command grant stands for on this device.
 *
 * The grant is deliberately thin: which declared command a tool may run, and
 * when that was granted. The executable, its arguments, and its timeout stay
 * in the operator's catalog, so the grant is safe in browser storage — losing
 * it costs a re-grant, and stealing it reveals a command id. Grants themselves
 * live in the shared local record (`local-tool-grants.client.ts`).
 *
 * The grant *is* the consent. There is no separate approval flag, because a
 * second toggle would let a stored grant mean two different things.
 */

export type { CommandToolGrant } from "./local-tool-grants.client.ts";

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
