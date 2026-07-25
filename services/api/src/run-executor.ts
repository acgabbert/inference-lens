import {
  OpenAICompatibleStreamProtocolError,
  streamOpenAICompatibleProvider,
} from "../../../packages/core/src/openai-compatible.ts";
import type {
  ProviderExecution,
  ProviderTransportEvent,
} from "../../../packages/core/src/run-kernel/index.ts";
import {
  isRetryableRunError,
} from "../../../packages/core/src/run-kernel/index.ts";

/**
 * Executes exactly one provider turn. Complete-run orchestration belongs to
 * the shared client-side RunCoordinator.
 */
export async function* executeProviderTurn(
  execution: ProviderExecution,
  apiKey: string,
  signal?: AbortSignal,
): AsyncGenerator<ProviderTransportEvent> {
  try {
    for await (const providerEvent of streamOpenAICompatibleProvider(
      execution,
      apiKey,
      signal,
    )) {
      yield providerEvent;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : undefined;
    if (signal?.aborted) {
      yield { type: "cancelled", reason: "Request aborted." };
      return;
    }
    const failure = {
      code:
        error instanceof OpenAICompatibleStreamProtocolError
          ? "protocol_error" as const
          : status === undefined
            ? "transport_error" as const
            : "provider_error" as const,
      message,
      providerStatus: status,
    };
    yield {
      type: "failed",
      error: {
        ...failure,
        retryable: isRetryableRunError(failure),
      },
    };
  }
}
