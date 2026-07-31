import type { CredentialSelection, ProviderTurnTransport } from "../../packages/contracts/src";
import type { ProviderExecution, ProviderTransportEvent, RunCoordinator, RunState } from "../../packages/core/src/run-kernel";
import { InferenceTransportError } from "../inference-transport-error.ts";

/**
 * Observability belongs to the caller. The driver deliberately has no
 * dependency on a diagnostic capture, React state, or a particular renderer.
 */
export interface ProviderTurnDriverDiagnosticHooks {
  onResponseReceived?(response: { status: number; headers: Headers }): void;
  onTransportEvent?(event: ProviderTransportEvent): void;
}

export interface ProviderTurnDriverOptions {
  coordinator: RunCoordinator;
  execution: ProviderExecution;
  transport: ProviderTurnTransport;
  prepareCredential(): Promise<CredentialSelection>;
  signal: AbortSignal;
  /** Called after every normalized event and stream finalization. */
  onStateChange?(state: RunState): void;
  diagnostics?: ProviderTurnDriverDiagnosticHooks;
  /** Prevents an older request from mutating a coordinator after replacement. */
  isCurrent?(): boolean;
}

export type ProviderTurnDriverOutcome = "settled" | "aborted" | "superseded";

function retryableTransportError(error: unknown) {
  const status = error instanceof InferenceTransportError ? error.status : undefined;
  return {
    code: error instanceof SyntaxError ? "protocol_error" as const : "transport_error" as const,
    message: error instanceof Error ? error.message : "Request failed.",
    retryable: !(error instanceof SyntaxError) && (
      status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599)
    ),
  };
}

/**
 * Drives exactly one coordinator command through a provider transport.
 *
 * Interactive retry and tool-result policy intentionally remain outside this
 * seam: a paused coordinator is a successful settled outcome for this turn.
 */
export async function driveProviderTurn({
  coordinator,
  execution,
  transport,
  prepareCredential,
  signal,
  onStateChange,
  diagnostics,
  isCurrent = () => true,
}: ProviderTurnDriverOptions): Promise<ProviderTurnDriverOutcome> {
  try {
    const credential = await prepareCredential();
    const stream = await transport.executeTurn({ execution, credential }, signal);
    diagnostics?.onResponseReceived?.({ status: stream.status, headers: stream.headers });
    for await (const event of stream.events) {
      diagnostics?.onTransportEvent?.(event);
      if (!isCurrent()) continue;
      coordinator.accept(event);
      onStateChange?.(coordinator.state);
    }
    if (!isCurrent()) return "superseded";
    coordinator.finishTurnStream();
    onStateChange?.(coordinator.state);
    return "settled";
  } catch (error) {
    if (signal.aborted) return "aborted";
    if (!isCurrent()) return "superseded";
    coordinator.accept({ type: "failed", error: retryableTransportError(error) });
    onStateChange?.(coordinator.state);
    return "settled";
  }
}
