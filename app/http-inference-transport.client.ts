"use client";

import {
  DECISIONS_API_PATH,
  INFERENCE_API_PATH,
  MODELS_API_PATH,
} from "../packages/contracts/src/index.ts";
import type {
  DecisionExecutionRequest,
  DecisionStream,
  DecisionTransport,
  ModelDiscoveryRequest,
  ModelDiscoveryResponse,
  ProviderTurnRequest,
  ProviderTurnStream,
  ProviderTurnTransport,
} from "../packages/contracts/src/index.ts";
import type { DecisionTransportEvent } from "../packages/core/src/decision.ts";
import type {
  ProviderTransportEvent,
} from "../packages/core/src/run-kernel/index.ts";
import { InferenceTransportError } from "../packages/runner/src/inference-transport-error.ts";

export { InferenceTransportError } from "../packages/runner/src/inference-transport-error.ts";

async function responseError(response: Response): Promise<InferenceTransportError> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new InferenceTransportError(
    typeof body?.error === "string"
      ? body.error
      : `Request failed (${response.status}).`,
    response.status,
  );
}

/** Reads an NDJSON event stream that must end in a terminal event. */
async function* readTransportEvents<Event extends { type: string }>(
  response: Response,
  subject: string,
): AsyncGenerator<Event> {
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
      const event = JSON.parse(line) as Event;
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
      `The response stream ended before the ${subject} reached a terminal state.`,
    );
  }
}

export class HttpInferenceTransport implements ProviderTurnTransport, DecisionTransport {
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
    if (
      !Array.isArray(body.models) ||
      !body.models.every((model) => typeof model === "string") ||
      (body.unfiltered !== undefined && body.unfiltered !== true)
    ) {
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
      events: readTransportEvents<ProviderTransportEvent>(response, "provider turn"),
    };
  }

  async executeDecision(
    request: DecisionExecutionRequest,
    signal?: AbortSignal,
  ): Promise<DecisionStream> {
    const response = await fetch(DECISIONS_API_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await responseError(response);
    return {
      status: response.status,
      headers: response.headers,
      events: readTransportEvents<DecisionTransportEvent>(response, "decision exchange"),
    };
  }
}
