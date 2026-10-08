import { streamProviderTurn } from "../../../packages/core/src/provider-adapters.ts";
import { ProviderProtocolError } from "../../../packages/core/src/provider-protocols.ts";
import type {
  ProviderExecution,
  ProviderTransportEvent,
} from "../../../packages/core/src/run-kernel/index.ts";
import {
  isRetryableRunError,
} from "../../../packages/core/src/run-kernel/index.ts";
import { explainProviderTransportError } from "./provider-reachability.ts";

/**
 * Executes exactly one provider turn. Complete-run orchestration belongs to
 * the shared client-side RunCoordinator.
 */
export interface ProviderTurnEnvironment {
  /** Lets a transport failure name the container-specific cause. */
  containerized?: boolean;
}

export async function* executeProviderTurn(
  execution: ProviderExecution,
  apiKey: string,
  signal?: AbortSignal,
  environment: ProviderTurnEnvironment = {},
): AsyncGenerator<ProviderTransportEvent> {
  try {
    for await (const providerEvent of streamProviderTurn(
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
    const code =
      error instanceof ProviderProtocolError
        ? "protocol_error" as const
        : status === undefined
          ? "transport_error" as const
          : "provider_error" as const;
    const failure = {
      code,
      // Only a transport failure means nothing answered. A provider that
      // returned a status was reachable, so its own message stands.
      message:
        code === "transport_error"
          ? explainProviderTransportError(
              message,
              execution.input.target.endpoint,
              environment.containerized ?? false,
            )
          : message,
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
