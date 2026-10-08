import {
  buildChatCompletionsRequest,
  normalizeOpenAICompatibleResponse,
  normalizeOpenAICompatibleStream,
  redactedProviderHeaders,
  redactedProviderUrl,
  sseLines,
} from "./openai-compatible.ts";
import {
  buildResponsesRequest,
  normalizeResponsesResponse,
  normalizeResponsesStream,
} from "./openai-responses.ts";
import {
  credentialHeaders,
  protocolHeaders,
  protocolLabel,
  ProviderProtocolError,
  redactedCredentialHeaders,
} from "./provider-protocols.ts";
import type {
  JsonObject,
  ProviderEvent,
  ProviderExecution,
  ProviderProtocol,
  ProviderWireProtocol,
} from "./run-kernel/types.ts";

/**
 * One wire protocol's serialization and normalization. Pure and secret-free:
 * the host that owns the credential and the network attaches the first and
 * performs the second, so the web service and the desktop shell share every
 * byte of protocol handling.
 */
export interface ProviderProtocolAdapter {
  readonly protocol: ProviderWireProtocol;
  buildRequest(execution: ProviderExecution): { url: string; body: JsonObject };
  normalizeStream(
    execution: ProviderExecution,
    lines: AsyncIterable<string>,
  ): AsyncGenerator<ProviderEvent>;
  normalizeResponse(
    execution: ProviderExecution,
    raw: string,
  ): AsyncGenerator<ProviderEvent>;
}

const chatCompletionsAdapter: ProviderProtocolAdapter = {
  protocol: "openai-compatible-chat-completions",
  buildRequest: buildChatCompletionsRequest,
  normalizeStream: normalizeOpenAICompatibleStream,
  normalizeResponse: normalizeOpenAICompatibleResponse,
};

const responsesAdapter: ProviderProtocolAdapter = {
  protocol: "openai-responses",
  buildRequest: buildResponsesRequest,
  normalizeStream: normalizeResponsesStream,
  normalizeResponse: normalizeResponsesResponse,
};

const adapters: Partial<Record<ProviderWireProtocol, ProviderProtocolAdapter>> = {
  "openai-compatible-chat-completions": chatCompletionsAdapter,
  "openai-responses": responsesAdapter,
};

export function providerProtocolAdapter(
  protocol: ProviderProtocol,
): ProviderProtocolAdapter {
  const adapter = protocol === "mock" ? undefined : adapters[protocol];
  if (!adapter) {
    throw new ProviderProtocolError(
      protocol === "mock"
        ? "A mock target cannot be sent to a provider."
        : `${protocolLabel(protocol)} is not supported yet.`,
    );
  }
  return adapter;
}

/** Everything but the credential: what a host sends and what evidence records. */
export interface ProviderHttpRequest {
  protocol: ProviderWireProtocol;
  url: string;
  body: JsonObject;
  bodyText: string;
  /** Non-secret headers. A host adds `credentialHeaders` itself. */
  headers: Record<string, string>;
}

export function buildProviderHttpRequest(
  execution: ProviderExecution,
): ProviderHttpRequest {
  const adapter = providerProtocolAdapter(execution.input.target.protocol);
  const { url, body } = adapter.buildRequest(execution);
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
export function providerRequestEvent(
  request: ProviderHttpRequest,
  hasCredential: boolean,
): Extract<ProviderEvent, { type: "request" }> {
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
 * Executes one provider turn over `fetch`, for a host that holds the
 * credential in-process. Hosts that proxy bytes elsewhere use the adapter's
 * pieces directly.
 */
export async function* streamProviderTurn(
  execution: ProviderExecution,
  apiKey: string,
  signal?: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const request = buildProviderHttpRequest(execution);
  const adapter = providerProtocolAdapter(request.protocol);

  yield providerRequestEvent(request, Boolean(apiKey));

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

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 4_000);
    throw Object.assign(
      new Error(detail || `Provider returned HTTP ${response.status}.`),
      { status: response.status },
    );
  }

  if (execution.input.responseMode === "buffered") {
    yield* adapter.normalizeResponse(execution, await response.text());
    return;
  }
  if (!response.body) throw new Error("Provider returned an empty response.");
  yield* adapter.normalizeStream(execution, sseLines(response.body));
}
