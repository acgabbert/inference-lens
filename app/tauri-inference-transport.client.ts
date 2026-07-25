"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CredentialSelection,
  ModelDiscoveryRequest,
  ModelDiscoveryResponse,
  ProviderTurnRequest,
  ProviderTurnStream,
  ProviderTurnTransport,
} from "../packages/contracts/src";
import {
  buildChatCompletionsRequest,
  normalizeOpenAICompatibleStream,
  OpenAICompatibleStreamProtocolError,
  parseModelsResponse,
  redactedProviderUrl,
} from "../packages/core/src/openai-compatible.ts";
import type {
  ProviderExecution,
  ProviderTransportEvent,
} from "../packages/core/src/run-kernel";
import {
  isRetryableRunError,
} from "../packages/core/src/run-kernel";
import { HttpInferenceTransport } from "./http-inference-transport.client";

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
 * `trace-lens://provider-turn/{requestId}`. Rust forwards bytes; parsing and
 * normalizing them into ProviderEvents happens here, on the TypeScript side,
 * using the same core adapter the web transport uses.
 */
type RawStreamEvent =
  | { type: "response"; status: number; headers: Record<string, string> }
  | { type: "lines"; lines: string[] }
  | { type: "end" }
  | {
      type: "error";
      kind: "transport" | "provider";
      message: string;
      status?: number;
    }
  | { type: "cancelled" };

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

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

function* terminalTransportEvent(
  event: RawStreamEvent | undefined,
): Generator<ProviderTransportEvent> {
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
  url: string,
  bodyText: string,
  credential: NativeCredentialSelection,
  queue: AsyncEventQueue<RawStreamEvent>,
  signal: AbortSignal | undefined,
  abort: () => void,
  unlisten: () => void,
): AsyncGenerator<ProviderTransportEvent> {
  try {
    yield {
      type: "request",
      request: {
        url: redactedProviderUrl(url),
        method: "POST",
        headers: {
          authorization: credential.kind === "none" ? "(not set)" : "Bearer ••••••••",
          "content-type": "application/json",
        },
        body: bodyText,
      },
    };

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
    try {
      yield* normalizeOpenAICompatibleStream(
        execution,
        linesFromQueue(queue, (event) => {
          terminal = event;
        }),
      );
    } catch (error) {
      if (error instanceof OpenAICompatibleStreamProtocolError) {
        yield {
          type: "failed",
          error: { code: "protocol_error", message: error.message },
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

export class TauriInferenceTransport implements ProviderTurnTransport {
  async discoverModels(
    request: ModelDiscoveryRequest,
  ): Promise<ModelDiscoveryResponse> {
    if (!request.capabilities?.modelDiscovery) {
      throw new Error("Model discovery is not supported by this profile.");
    }
    const credential = nativeCredential(request.credential);
    const { status, body } = await invoke<{ status: number; body: string }>(
      "discover_models",
      { endpoint: request.endpoint, credential },
    );
    if (status < 200 || status >= 300) {
      const detail = body.slice(0, 4_000);
      throw Object.assign(
        new Error(detail || `Provider returned HTTP ${status}.`),
        { status },
      );
    }
    return { models: parseModelsResponse(JSON.parse(body)) };
  }

  async executeTurn(
    request: ProviderTurnRequest,
    signal?: AbortSignal,
  ): Promise<ProviderTurnStream> {
    const credential = nativeCredential(request.credential);
    const { url, body } = buildChatCompletionsRequest(request.execution);
    const bodyText = JSON.stringify(body);
    const requestId = `provider-turn_${crypto.randomUUID()}`;
    const queue = new AsyncEventQueue<RawStreamEvent>();
    const unlisten = await listen<RawStreamEvent>(
      `trace-lens://provider-turn/${requestId}`,
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
        endpoint: request.execution.input.target.endpoint,
        body: bodyText,
      });
      return {
        status: accepted.status,
        headers: new Headers({ "x-trace-lens-transport": "tauri" }),
        events: toProviderTransportEvents(
          request.execution,
          url,
          bodyText,
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
