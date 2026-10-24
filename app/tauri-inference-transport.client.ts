"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CredentialSelection,
  DecisionExecutionRequest,
  DecisionStream,
  DecisionTransport,
  ModelDiscoveryRequest,
  ModelDiscoveryResponse,
  ProviderTurnRequest,
  ProviderTurnStream,
  ProviderTurnTransport,
} from "../packages/contracts/src";
import type {
  DecisionExecution,
  DecisionTransportEvent,
} from "../packages/core/src/decision.ts";
import { discoverDecisionModels } from "../packages/core/src/decision-discovery.ts";
import type { ModelListing } from "../packages/core/src/decision-discovery.ts";
import {
  buildDecisionHttpRequest,
  decisionRequestEvent,
  decisionResponseEvents,
} from "../packages/core/src/decision-execution.ts";
import { parseModelsResponse } from "../packages/core/src/openai-compatible.ts";
import {
  buildProviderHttpRequest,
  providerProtocolAdapter,
  providerRequestEvent,
} from "../packages/core/src/provider-adapters.ts";
import type { ProviderHttpRequest } from "../packages/core/src/provider-adapters.ts";
import {
  ProviderProtocolError,
  ProviderReportedError,
} from "../packages/core/src/provider-protocols.ts";
import type {
  ProviderExecution,
  ProviderTransportEvent,
  RunError,
} from "../packages/core/src/run-kernel";
import {
  isRetryableRunError,
} from "../packages/core/src/run-kernel";
import { HttpInferenceTransport } from "./http-inference-transport.client";
import { randomUUID } from "../packages/core/src/random-id.ts";
import { isTauriRuntime } from "./runtime.client.ts";

export { isTauriRuntime } from "./runtime.client.ts";

type NativeCredentialSelection = Extract<
  CredentialSelection,
  { kind: "native-keychain" } | { kind: "provided" } | { kind: "none" }
>;

export type CredentialStatus = {
  canPersist: boolean;
  isStored: boolean;
  isApprovedForEndpoint: boolean;
};

type ProviderTurnAccepted = { status: number };

/**
 * The raw-proxy channel payload emitted on
 * `inference-lens://provider-turn/{requestId}`. Rust forwards bytes; parsing and
 * normalizing them into ProviderEvents happens here, on the TypeScript side,
 * using the same core adapter the web transport uses.
 */
type RawStreamEvent =
  | { type: "response"; status: number; headers: Record<string, string> }
  | { type: "lines"; lines: string[] }
  | { type: "body"; body: string }
  | { type: "end" }
  | {
      type: "error";
      kind: "transport" | "provider";
      message: string;
      status?: number;
    }
  | { type: "cancelled" };

function nativeCredential(
  credential: CredentialSelection,
): NativeCredentialSelection {
  if (credential.kind === "environment-default") {
    throw new Error("The desktop app requires an entered or stored credential.");
  }
  return credential;
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private waiting?: (result: IteratorResult<T>) => void;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting) waiting({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.({ done: true, value: undefined });
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.closed) return { done: true, value: undefined };
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

function isTerminalStreamEvent(event: RawStreamEvent): boolean {
  return event.type === "end" || event.type === "error" || event.type === "cancelled";
}

/** Distinguishes a queue-carried terminal signal from a thrown protocol error. */
class TerminalStreamSignal extends Error {}

/**
 * Exposes the `lines` payloads on the queue as an async iterable of SSE
 * lines for the core normalizer, while capturing whichever terminal event
 * ended the stream. Throws for `error`/`cancelled` so the normalizer's
 * "ended without a terminal signal" check is never reached for those cases
 * — the real transport/cancellation error must not be masked as a protocol
 * error.
 */
async function* linesFromQueue(
  queue: AsyncEventQueue<RawStreamEvent>,
  onTerminal: (event: RawStreamEvent) => void,
): AsyncGenerator<string> {
  while (true) {
    const next = await queue.next();
    if (next.done) return;
    const event = next.value;
    if (event.type === "lines") {
      yield* event.lines;
      continue;
    }
    onTerminal(event);
    if (event.type === "end") return;
    throw new TerminalStreamSignal();
  }
}

async function bodyFromQueue(
  queue: AsyncEventQueue<RawStreamEvent>,
  onTerminal: (event: RawStreamEvent) => void,
): Promise<string> {
  let body = "";
  while (true) {
    const next = await queue.next();
    if (next.done) return body;
    const event = next.value;
    if (event.type === "body") {
      body += event.body;
      continue;
    }
    onTerminal(event);
    if (event.type === "end") return body;
    throw new TerminalStreamSignal();
  }
}

function* terminalTransportEvent(
  event: RawStreamEvent | undefined,
): Generator<Extract<ProviderTransportEvent, { type: "failed" | "cancelled" }>> {
  if (!event) return;
  switch (event.type) {
    case "error":
      const failure = {
        code: event.kind === "provider" ? "provider_error" as const : "transport_error" as const,
        message: event.message,
        providerStatus: event.status,
      };
      yield {
        type: "failed",
        error: {
          ...failure,
          retryable: isRetryableRunError(failure),
        },
      };
      return;
    case "cancelled":
      yield { type: "cancelled", reason: "Request aborted." };
      return;
    default:
      return;
  }
}

async function* toProviderTransportEvents(
  execution: ProviderExecution,
  request: ProviderHttpRequest,
  credential: NativeCredentialSelection,
  queue: AsyncEventQueue<RawStreamEvent>,
  signal: AbortSignal | undefined,
  abort: () => void,
  unlisten: () => void,
): AsyncGenerator<ProviderTransportEvent> {
  try {
    yield providerRequestEvent(request, credential.kind !== "none");

    const first = await queue.next();
    if (first.done) return;

    if (first.value.type !== "response") {
      yield* terminalTransportEvent(first.value);
      return;
    }

    yield {
      type: "response_started",
      response: { status: first.value.status, headers: first.value.headers },
    };

    let terminal: RawStreamEvent | undefined;
    const adapter = providerProtocolAdapter(request.protocol);
    try {
      if (execution.input.responseMode === "buffered") {
        const raw = await bodyFromQueue(queue, (event) => {
          terminal = event;
        });
        yield* adapter.normalizeResponse(execution, raw);
      } else {
        yield* adapter.normalizeStream(
          execution,
          linesFromQueue(queue, (event) => {
            terminal = event;
          }),
        );
      }
    } catch (error) {
      if (error instanceof ProviderProtocolError) {
        yield {
          type: "failed",
          error: { code: "protocol_error", message: error.message },
        };
        return;
      }
      if (error instanceof ProviderReportedError) {
        yield {
          type: "failed",
          error: { code: "provider_error", message: error.message, retryable: false },
        };
        return;
      }
      if (!(error instanceof TerminalStreamSignal)) throw error;
    }
    yield* terminalTransportEvent(terminal);
  } finally {
    signal?.removeEventListener("abort", abort);
    unlisten();
  }
}

/**
 * The decision counterpart of `toProviderTransportEvents`. A decision is
 * always buffered, and Rust relays an error body as the error's message, so
 * both outcomes reach the same core reader and record the same evidence.
 */
async function* toDecisionTransportEvents(
  execution: DecisionExecution,
  hasCredential: boolean,
  queue: AsyncEventQueue<RawStreamEvent>,
  signal: AbortSignal | undefined,
  abort: () => void,
  unlisten: () => void,
): AsyncGenerator<DecisionTransportEvent> {
  try {
    yield decisionRequestEvent(buildDecisionHttpRequest(execution), hasCredential);

    const first = await queue.next();
    if (first.done) return;
    if (first.value.type !== "response") {
      yield* terminalTransportEvent(first.value);
      return;
    }
    const { status } = first.value;
    yield {
      type: "response_started",
      response: { status, headers: first.value.headers },
    };

    let terminal: RawStreamEvent | undefined;
    let raw: string;
    try {
      raw = await bodyFromQueue(queue, (event) => {
        terminal = event;
      });
    } catch (error) {
      if (!(error instanceof TerminalStreamSignal)) throw error;
      const failed = terminal;
      if (failed?.type !== "error" || failed.kind !== "provider" || failed.status === undefined) {
        yield* terminalTransportEvent(failed);
        return;
      }
      raw = failed.message;
    }
    try {
      yield* decisionResponseEvents(execution, status, raw);
    } catch (error) {
      yield { type: "failed", error: decisionFailure(error) };
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    unlisten();
  }
}

function decisionFailure(error: unknown): RunError {
  if (error instanceof ProviderProtocolError) {
    return { code: "protocol_error", message: error.message };
  }
  const status =
    error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
  const failure = {
    code: status === undefined ? "internal_error" as const : "provider_error" as const,
    message: error instanceof Error ? error.message : "Request failed.",
    providerStatus: status,
  };
  return { ...failure, retryable: isRetryableRunError(failure) };
}

export class TauriInferenceTransport implements ProviderTurnTransport, DecisionTransport {
  async discoverModels(
    request: ModelDiscoveryRequest,
  ): Promise<ModelDiscoveryResponse> {
    if (!request.capabilities?.modelDiscovery) {
      throw new Error("Model discovery is not supported by this profile.");
    }
    const credential = nativeCredential(request.credential);
    const protocol = request.protocol ?? "openai-compatible-chat-completions";
    // Rust builds each listing's URL from its name and relays the body; the
    // decision steps and every parse happen here (D13).
    const fetchListing = async (listing: ModelListing): Promise<unknown> => {
      const { status, body } = await invoke<{ status: number; body: string }>(
        "discover_models",
        { endpoint: request.endpoint, protocol, listing, credential },
      );
      if (status < 200 || status >= 300) {
        const detail = body.slice(0, 4_000);
        throw Object.assign(
          new Error(detail || `Provider returned HTTP ${status}.`),
          { status },
        );
      }
      return JSON.parse(body);
    };
    if (protocol === "systemone") {
      return discoverDecisionModels(request.endpoint, fetchListing);
    }
    return { models: parseModelsResponse(await fetchListing("chat")) };
  }

  async executeTurn(
    request: ProviderTurnRequest,
    signal?: AbortSignal,
  ): Promise<ProviderTurnStream> {
    const credential = nativeCredential(request.credential);
    const providerRequest = buildProviderHttpRequest(request.execution);
    const requestId = `provider-turn_${randomUUID()}`;
    const queue = new AsyncEventQueue<RawStreamEvent>();
    const unlisten = await listen<RawStreamEvent>(
      `inference-lens://provider-turn/${requestId}`,
      ({ payload }) => {
        queue.push(payload);
        if (isTerminalStreamEvent(payload)) queue.close();
      },
    );
    const abort = () => {
      void invoke("cancel_provider_turn", { requestId });
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const accepted = await invoke<ProviderTurnAccepted>("start_provider_turn", {
        requestId,
        credential,
        request: {
          endpoint: request.execution.input.target.endpoint,
          protocol: providerRequest.protocol,
          body: providerRequest.bodyText,
          streaming: request.execution.input.responseMode === "streaming",
        },
      });
      return {
        status: accepted.status,
        headers: new Headers({ "x-inference-lens-transport": "tauri" }),
        events: toProviderTransportEvents(
          request.execution,
          providerRequest,
          credential,
          queue,
          signal,
          abort,
          unlisten,
        ),
      };
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      unlisten();
      throw error;
    }
  }

  async executeDecision(
    request: DecisionExecutionRequest,
    signal?: AbortSignal,
  ): Promise<DecisionStream> {
    const credential = nativeCredential(request.credential);
    const decisionRequest = buildDecisionHttpRequest(request.execution);
    const requestId = `provider-turn_${randomUUID()}`;
    const queue = new AsyncEventQueue<RawStreamEvent>();
    const unlisten = await listen<RawStreamEvent>(
      `inference-lens://provider-turn/${requestId}`,
      ({ payload }) => {
        queue.push(payload);
        if (isTerminalStreamEvent(payload)) queue.close();
      },
    );
    const abort = () => {
      void invoke("cancel_provider_turn", { requestId });
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // The same raw proxy as a buffered chat turn: Rust derives the URL from
      // the endpoint and protocol, so the body is all the webview supplies.
      const accepted = await invoke<ProviderTurnAccepted>("start_provider_turn", {
        requestId,
        credential,
        request: {
          endpoint: request.execution.input.target.endpoint,
          protocol: decisionRequest.protocol,
          body: decisionRequest.bodyText,
          streaming: false,
        },
      });
      return {
        status: accepted.status,
        headers: new Headers({ "x-inference-lens-transport": "tauri" }),
        events: toDecisionTransportEvents(
          request.execution,
          credential.kind !== "none",
          queue,
          signal,
          abort,
          unlisten,
        ),
      };
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      unlisten();
      throw error;
    }
  }
}

export const desktopCredentialStore = {
  async status(profileId: string, endpoint: string): Promise<CredentialStatus> {
    return invoke<CredentialStatus>("credential_status", { profileId, endpoint });
  },
  async save(profileId: string, endpoint: string, apiKey: string): Promise<void> {
    await invoke("store_credential", { profileId, endpoint, apiKey });
  },
};

export function createInferenceTransport(): ProviderTurnTransport {
  return isTauriRuntime()
    ? new TauriInferenceTransport()
    : new HttpInferenceTransport();
}
