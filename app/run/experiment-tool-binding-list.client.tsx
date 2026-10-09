"use client";

import { experimentToolBindingLabel } from "./experiment-tool-bindings.client.ts";
import type { ExperimentToolBinding } from "../../packages/core/src/tool-binding-resolution.ts";

/**
 * What will serve each exposed tool, at the moment cost is confirmed.
 *
 * Shared by the repeated-run and evaluation confirmations. A batch answers its
 * own tool calls without another prompt, so this is the last point at which a
 * stale grant can be noticed — and, for MCP, where the user learns that
 * confirming approves every call the batch makes.
 */
export function ExperimentToolBindingList({ toolBindings }: { toolBindings: readonly ExperimentToolBinding[] }) {
  const servesMcp = toolBindings.some(({ binding }) => binding?.kind === "mcp");
  return (
    <div className="repeat-experiment-tools">
      <h3>Tools served automatically</h3>
      <ul>
        {toolBindings.map(({ tool, binding }) => (
          <li key={tool.id} className={binding ? undefined : "repeat-experiment-tool-unbound"}>
            <code>{tool.name}</code> → {experimentToolBindingLabel({ tool, ...(binding ? { binding } : {}) })}
          </li>
        ))}
      </ul>
      {servesMcp && (
        <p className="repeat-experiment-tools-note">
          Starting approves every MCP call this batch makes, without asking per call. MCP tools may change
          data on their server. Each server is checked before the first request; if one becomes unavailable
          mid-batch, the batch stops. Revoke a permission from the Tools tab.
        </p>
      )}
    </div>
  );
}
