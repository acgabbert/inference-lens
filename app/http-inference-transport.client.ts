"use client";

import {
  INFERENCE_API_PATH,
  MODELS_API_PATH,
} from "../packages/contracts/src/index.ts";
import type {
  ModelDiscoveryRequest,
  ModelDiscoveryResponse,
  ProviderTurnRequest,
  ProviderTurnStream,
  ProviderTurnTransport,
} from "../packages/contracts/src/index.ts";
import type {
  ProviderTransportEvent,
} from "../packages/core/src/run-kernel/index.ts";

export class InferenceTransportError extends Error {
  readonly status?: number;

  constructor(
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "InferenceTransportError";
    this.status = status;
  }
}

async function responseError(response: Response): Promise<InferenceTransportError> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new InferenceTransportError(
    typeof body?.error === "string"
      ? body.error
      : `Request failed (${response.status}).`,
    response.status,
  );
}

async function* readProviderEvents(
  response: Response,
): AsyncGenerator<ProviderTransportEvent> {
  if (!response.body) {
    throw new InferenceTransportError("The API response did not include a stream.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedTerminalEvent = false;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as ProviderTransportEvent;
      receivedTerminalEvent ||= [
        "completed",
        "cancelled",
        "failed",
      ].includes(event.type);
      yield event;
    }
    if (done) break;
  }

  if (!receivedTerminalEvent) {
    throw new InferenceTransportError(
      "The response stream ended before the provider turn reached a terminal state.",
    );
  }
}

export class HttpInferenceTransport implements ProviderTurnTransport {
  async discoverModels(
    request: ModelDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<ModelDiscoveryResponse> {
    const response = await fetch(MODELS_API_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as ModelDiscoveryResponse;
    if (!Array.isArray(body.models) || !body.models.every((model) => typeof model === "string")) {
      throw new InferenceTransportError("The API returned an invalid model list.");
    }
    return body;
  }

  async executeTurn(
    request: ProviderTurnRequest,
    signal?: AbortSignal,
  ): Promise<ProviderTurnStream> {
    const response = await fetch(INFERENCE_API_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await responseError(response);
    return {
      status: response.status,
      headers: response.headers,
      events: readProviderEvents(response),
    };
  }
}
