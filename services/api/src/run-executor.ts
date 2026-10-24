import type {
  DecisionExecution,
  DecisionTransportEvent,
} from "../../../packages/core/src/decision.ts";
import { streamDecision } from "../../../packages/core/src/decision-execution.ts";
import { streamProviderTurn } from "../../../packages/core/src/provider-adapters.ts";
import {
  ProviderProtocolError,
  ProviderReportedError,
} from "../../../packages/core/src/provider-protocols.ts";
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
    yield failureEvent(
      error,
      signal,
      execution.input.target.endpoint,
      environment,
    );
  }
}

/** Executes exactly one decision exchange (D12). */
export async function* executeDecision(
  execution: DecisionExecution,
  apiKey: string,
  signal?: AbortSignal,
  environment: ProviderTurnEnvironment = {},
): AsyncGenerator<DecisionTransportEvent> {
  try {
    yield* streamDecision(execution, apiKey, signal);
  } catch (error) {
    yield failureEvent(
      error,
      signal,
      execution.input.target.endpoint,
      environment,
    );
  }
}

/** The terminal event for whatever ended an exchange early. */
function failureEvent(
  error: unknown,
  signal: AbortSignal | undefined,
  endpoint: string,
  environment: ProviderTurnEnvironment,
): Extract<ProviderTransportEvent, { type: "failed" | "cancelled" }> {
  const message = error instanceof Error ? error.message : "Request failed.";
  const status =
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  if (signal?.aborted) {
    return { type: "cancelled", reason: "Request aborted." };
  }
  if (error instanceof ProviderReportedError) {
    // The provider answered and named its own failure. With no status to
    // judge it by, it is not retried automatically; the user can retry.
    return {
      type: "failed",
      error: { code: "provider_error", message, retryable: false },
    };
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
            endpoint,
            environment.containerized ?? false,
          )
        : message,
    providerStatus: status,
  };
  return {
    type: "failed",
    error: {
      ...failure,
      retryable: isRetryableRunError(failure),
    },
  };
}
