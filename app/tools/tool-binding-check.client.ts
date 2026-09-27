"use client";

import { TOOL_BINDING_CHECK_API_PATH } from "../../packages/contracts/src/tool-binding-check.ts";
import type {
  ToolBindingCheckItem,
  ToolBindingCheckResponse,
  ToolBindingCheckResult,
} from "../../packages/contracts/src/tool-binding-check.ts";
import type { ToolId } from "../../packages/core/src/run-kernel/index.ts";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";

/** What the host must verify for a binding; mocks need no host. */
export function toolBindingCheckItem(binding: ToolBinding): ToolBindingCheckItem | undefined {
  switch (binding.kind) {
    case "mock":
      return undefined;
    case "command":
      return { toolId: binding.toolId, kind: "command", commandId: binding.executorId };
    case "mcp":
      return {
        toolId: binding.toolId,
        kind: "mcp",
        serverId: binding.serverId,
        remoteToolName: binding.remoteToolName,
        discoveryFingerprint: binding.discoveryFingerprint,
      };
  }
}

/** Asks the host whether each binding can be served right now. */
export async function checkToolBindingsOnHost(
  items: readonly ToolBindingCheckItem[],
  fetchImpl: typeof fetch = fetch,
): Promise<ToolBindingCheckResult[]> {
  if (items.length === 0) return [];
  const response = await fetchImpl(TOOL_BINDING_CHECK_API_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bindings: items }),
  });
  const body = await response.json().catch(() => null) as (ToolBindingCheckResponse & { error?: string }) | null;
  if (!response.ok || !Array.isArray(body?.results)) {
    throw new Error(body?.error ?? "The local service could not check tool bindings.");
  }
  return body.results;
}

/**
 * The batch preflight: resolves when every host-served binding is ready,
 * otherwise rejects naming each tool that is not and why.
 */
export async function verifyToolBindingsOnHost(
  bindings: readonly ToolBinding[],
  nameFor: (toolId: ToolId) => string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const items = bindings.flatMap((binding) => {
    const item = toolBindingCheckItem(binding);
    return item ? [item] : [];
  });
  const unavailable = (await checkToolBindingsOnHost(items, fetchImpl))
    .filter(({ status }) => status === "unavailable");
  if (unavailable.length === 0) return;
  throw new Error(`Nothing was sent. ${unavailable
    .map(({ toolId, message }) => `${nameFor(toolId as ToolId)} cannot run: ${message ?? "unavailable"}`)
    .join(" ")}`);
}
