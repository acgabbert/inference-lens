import type { ToolExecutionOutcome } from "./run-kernel/types.ts";
import type {
  ToolBindingConfig,
  ToolExecutor,
  ToolExecutorRuntime,
} from "./tool-execution.ts";

/**
 * The project mock, expressed as an executor.
 *
 * It has no transport, so most of `ToolExecutionFailure` is unreachable here —
 * that is the point of shipping the wider vocabulary before the first executor
 * that can produce it. What the mock does contribute is the cancellation and
 * policy-rejection paths, which are real even for an instantaneous executor,
 * and provenance: a mocked result now says which binding produced it.
 */
export function createMockToolExecutor(
  binding: Extract<ToolBindingConfig, { kind: "mock" }>,
): ToolExecutor {
  return {
    kind: "mock",
    execute(
      _invocation,
      runtime: ToolExecutorRuntime,
    ): Promise<ToolExecutionOutcome> {
      if (runtime.signal?.aborted) {
        return Promise.resolve({
          status: "failed",
          failure: {
            kind: "cancelled",
            message: "The tool execution was cancelled before it began.",
          },
        });
      }
      return Promise.resolve({
        status: "completed",
        content: binding.result.content.map((part) => ({ ...part })),
        isError: binding.result.isError ?? false,
      });
    },
  };
}
