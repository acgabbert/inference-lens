"use client";

import { TOOL_EXECUTION_API_PATH } from "../../packages/contracts/src/index.ts";
import type { CommandToolExecutionRequest } from "../../packages/contracts/src/index.ts";
import type {
  ToolExecutionOutcome,
} from "../../packages/core/src/run-kernel/index.ts";
import type {
  ToolBindingConfig,
  ToolExecutor,
  ToolExecutorRuntime,
  ToolInvocation,
} from "../../packages/core/src/tool-execution.ts";

/**
 * The command executor as the run model sees it: an invocation in, a
 * normalized outcome out.
 *
 * The transport is the only reason this lives in `app/` rather than in core.
 * A browser cannot spawn a process, so the executor is a client of the local
 * service, and everything that can go wrong *with the transport* has to be
 * classified into the same vocabulary the service already answers in — a
 * service that never replied and a tool that never started are the same fact
 * from the run's point of view, and neither one may fabricate a result.
 */

function failure(
  kind: "execution_failed" | "cancelled",
  message: string,
): ToolExecutionOutcome {
  return { status: "failed", failure: { kind, message } };
}

/** Rejects a response body that is not an outcome rather than trusting it. */
function isOutcome(value: unknown): value is ToolExecutionOutcome {
  if (!value || typeof value !== "object") return false;
  const outcome = value as Partial<ToolExecutionOutcome>;
  if (outcome.status === "completed") {
    return Array.isArray((outcome as { content?: unknown }).content);
  }
  if (outcome.status === "failed") {
    const supplied = (outcome as { failure?: { kind?: unknown; message?: unknown } })
      .failure;
    return (
      typeof supplied?.kind === "string" && typeof supplied.message === "string"
    );
  }
  return false;
}

export interface CommandToolExecutorOptions {
  /** Injected by tests; the app uses the page's own fetch. */
  fetchImpl?: typeof fetch;
}

export function createCommandToolExecutor(
  binding: Extract<ToolBindingConfig, { kind: "command" }>,
  options: CommandToolExecutorOptions = {},
): ToolExecutor {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    kind: "command",
    async execute(
      invocation: ToolInvocation,
      runtime: ToolExecutorRuntime,
    ): Promise<ToolExecutionOutcome> {
      if (runtime.signal?.aborted) {
        return failure(
          "cancelled",
          "The tool execution was cancelled before it began.",
        );
      }
      const body: CommandToolExecutionRequest = {
        commandId: binding.executorId,
        tool: invocation.tool.name,
        toolCallId: invocation.toolCallId,
        arguments: invocation.call.arguments.text,
      };

      let response: Response;
      try {
        response = await fetchImpl(TOOL_EXECUTION_API_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(runtime.signal ? { signal: runtime.signal } : {}),
        });
      } catch (error) {
        if (runtime.signal?.aborted) {
          return failure("cancelled", "The tool execution was cancelled.");
        }
        return failure(
          "execution_failed",
          `The local service could not run this command tool: ${
            error instanceof Error ? error.message : "the request failed"
          }`,
        );
      }

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as
          | { error?: unknown }
          | null;
        return failure(
          "execution_failed",
          typeof detail?.error === "string"
            ? detail.error
            : `The local service refused to run this command tool (${response.status}).`,
        );
      }

      const parsed: unknown = await response.json().catch(() => null);
      if (!isOutcome(parsed)) {
        return failure(
          "execution_failed",
          "The local service returned an unreadable execution outcome.",
        );
      }
      return parsed;
    },
  };
}
