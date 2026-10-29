import type {
  DecisionEvent,
  DecisionExecution,
  DecisionProtocolAdapter,
  DecisionWireProtocol,
} from "./decision.ts";
import {
  redactedProviderHeaders,
  redactedProviderUrl,
} from "./openai-compatible.ts";
import {
  credentialHeaders,
  protocolHeaders,
  redactedCredentialHeaders,
} from "./provider-protocols.ts";
import type { JsonObject } from "./run-kernel/types.ts";
import { systemOneAdapter } from "./system-one.ts";

/**
 * The host-side pieces of one decision exchange (D12). Every host builds the
 * request and reads the body with these, so the web service and the Tauri
 * webview record the same evidence and normalize with the same adapter; only
 * who holds the credential and the socket differs.
 */

const adapters = {
  systemone: systemOneAdapter,
} as const satisfies Record<DecisionWireProtocol, DecisionProtocolAdapter>;

export function decisionProtocolAdapter(
  protocol: DecisionWireProtocol,
): DecisionProtocolAdapter {
  return adapters[protocol];
}

export interface DecisionHttpRequest {
  protocol: DecisionWireProtocol;
  url: string;
  body: JsonObject;
  bodyText: string;
  /** Non-secret headers. A host adds `credentialHeaders` itself. */
  headers: Record<string, string>;
}

export function buildDecisionHttpRequest(
  execution: DecisionExecution,
): DecisionHttpRequest {
  const adapter = decisionProtocolAdapter(execution.input.target.protocol);
  const { url, body } = adapter.buildRequest(execution.input);
  return {
    protocol: adapter.protocol,
    url,
    body,
    bodyText: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...protocolHeaders(adapter.protocol),
    },
  };
}

/** The `request` evidence event for a built request. */
export function decisionRequestEvent(
  request: DecisionHttpRequest,
  hasCredential: boolean,
): Extract<DecisionEvent, { type: "request" }> {
  return {
    type: "request",
    request: {
      url: redactedProviderUrl(request.url),
      method: "POST",
      headers: {
        ...redactedCredentialHeaders(request.protocol, hasCredential),
        ...request.headers,
      },
      body: request.bodyText,
    },
  };
}

/**
 * The events for a response body a host has read whole. The body is always
 * recorded as frame 0, an error body included, so the evidence holds what the
 * server said. A non-2xx status then throws an error carrying that status,
 * with the protocol's own message when the body is in a documented shape.
 * A malformed success body throws ProviderProtocolError.
 */
export function* decisionResponseEvents(
  execution: DecisionExecution,
  status: number,
  raw: string,
): Generator<DecisionEvent> {
  const adapter = decisionProtocolAdapter(execution.input.target.protocol);
  if (raw) yield { type: "frame", frame: { index: 0, raw } };
  if (status < 200 || status >= 300) {
    const message = adapter.errorMessage(raw) ??
      (raw.slice(0, 4_000) || `Provider returned HTTP ${status}.`);
    throw Object.assign(new Error(message), { status });
  }
  yield {
    type: "completed",
    result: adapter.normalizeResponse(execution.input, raw),
  };
}

/**
 * Executes one decision exchange over `fetch`, for a host that holds the
 * credential in-process.
 */
export async function* streamDecision(
  execution: DecisionExecution,
  apiKey: string,
  signal?: AbortSignal,
): AsyncGenerator<DecisionEvent> {
  const request = buildDecisionHttpRequest(execution);
  yield decisionRequestEvent(request, Boolean(apiKey));

  const response = await fetch(request.url, {
    method: "POST",
    headers: {
      ...request.headers,
      ...credentialHeaders(request.protocol, apiKey),
    },
    body: request.bodyText,
    signal,
  });

  yield {
    type: "response_started",
    response: {
      status: response.status,
      headers: redactedProviderHeaders(response.headers),
    },
  };
  yield* decisionResponseEvents(execution, response.status, await response.text());
}
