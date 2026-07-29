import type { ResolvedInferenceRequest } from "./types.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type {
  ConversationMessage,
  FinishReason,
  JsonObject,
  ProviderExecution,
  ProviderEvent,
  RunTokenUsage,
  ToolCallId,
} from "./run-kernel/types.ts";

type OpenAIChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      reasoning_details?: Array<{
        type?: string;
        text?: string | null;
      }>;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      reasoning_details?: Array<{
        type?: string;
        text?: string | null;
      }>;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIChunk["usage"];
};

type OpenAIModelsResponse = {
  data?: Array<{ id?: unknown }>;
};

/**
 * The provider closed an SSE response without the terminal signal required by
 * the OpenAI-compatible chat-completions protocol.
 */
export class OpenAICompatibleProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICompatibleProtocolError";
  }
}

export class OpenAICompatibleStreamProtocolError extends OpenAICompatibleProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICompatibleStreamProtocolError";
  }
}

export function chatCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Endpoint must use HTTP or HTTPS.");
  }
  if (parsed.pathname.endsWith("/chat/completions")) return parsed.toString();
  return `${trimmed}/chat/completions`;
}

export function modelsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Endpoint must use HTTP or HTTPS.");
  }
  if (parsed.pathname.endsWith("/chat/completions")) {
    parsed.pathname = parsed.pathname.slice(0, -"/chat/completions".length);
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/models`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * Parses and normalizes a `/models` response body. Dedupes and sorts with
 * `localeCompare` so discovery output is stable across providers.
 */
export function parseModelsResponse(body: unknown): string[] {
  const parsed = body as OpenAIModelsResponse;
  if (!parsed || !Array.isArray(parsed.data)) {
    throw new Error("Provider returned an invalid /models response.");
  }
  return [
    ...new Set(
      parsed.data.flatMap(({ id }) => (typeof id === "string" ? [id] : [])),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

/**
 * Lists the model identifiers an OpenAI-compatible endpoint exposes. Model
 * discovery is optional: callers can still accept a manually supplied ID.
 */
export async function discoverOpenAICompatibleModels(
  request: Pick<ResolvedInferenceRequest, "endpoint" | "apiKey" | "capabilities">,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!request.capabilities.modelDiscovery) {
    throw new Error("Model discovery is not supported by this profile.");
  }
  const response = await fetch(modelsUrl(request.endpoint), {
    method: "GET",
    headers: request.apiKey
      ? { authorization: `Bearer ${request.apiKey}` }
      : undefined,
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 4_000);
    throw Object.assign(
      new Error(detail || `Provider returned HTTP ${response.status}.`),
      { status: response.status },
    );
  }

  return parseModelsResponse(await response.json());
}

const sensitiveHeaderNames = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "access-token",
  "refresh-token",
  "password",
  "secret",
]);

function sensitiveName(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return (
    normalized.includes("apikey") ||
    [...sensitiveHeaderNames].some(
      (name) => normalized === name.replaceAll(/[^a-z0-9]/g, ""),
    )
  );
}

export function redactedProviderUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const name of [...url.searchParams.keys()]) {
      if (sensitiveName(name)) url.searchParams.set(name, "••••••••");
    }
    if (url.username) url.username = "••••••••";
    if (url.password) url.password = "••••••••";
    return url.toString();
  } catch {
    return value;
  }
}

/** Captures every runtime-visible header while removing credential material. */
export function redactedProviderHeaders(
  headers: Iterable<[string, string]>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    result[name] = sensitiveName(name) ? "••••••••" : value;
  }
  return result;
}

function normalizedUsage(
  chunk: Pick<OpenAIChunk, "usage">,
): RunTokenUsage | undefined {
  if (!chunk.usage) return undefined;
  return {
    inputTokens: chunk.usage.prompt_tokens,
    outputTokens: chunk.usage.completion_tokens,
    totalTokens: chunk.usage.total_tokens,
  };
}

function normalizedFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return { normalized: reason, raw: reason };
    default:
      return { normalized: "other", raw: reason };
  }
}

/**
 * OpenAI-compatible providers use several names for streamed reasoning.
 * Prefer the top-level delta to avoid emitting duplicate text when a provider
 * also includes the same text in `reasoning_details`.
 */
function reasoningDelta(chunk: OpenAIChunk): string | undefined {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return undefined;
  if (delta.reasoning) return delta.reasoning;
  if (delta.reasoning_content) return delta.reasoning_content;
  const detailText = delta.reasoning_details
    ?.filter((detail) => detail.type === "reasoning.text")
    .map((detail) => detail.text ?? "")
    .join("");
  return detailText || undefined;
}

/**
 * Builds the chat-completions request URL and body for one provider turn.
 * Pure and secret-free: callers attach credentials themselves.
 */
export function buildChatCompletionsRequest(
  execution: ProviderExecution,
): { url: string; body: JsonObject } {
  const { input } = execution;
  const { target } = input;
  if (!target.capabilities.chatCompletions) {
    throw new Error("Chat completions are not supported by this profile.");
  }
  if (
    input.responseMode === "streaming" &&
    !target.capabilities.streaming
  ) {
    throw new Error("Streaming is not supported by this profile.");
  }
  if (input.tools.length > 0 && !target.capabilities.tools) {
    throw new Error("Tools are not supported by this profile.");
  }
  const url = chatCompletionsUrl(target.endpoint);
  const providerCallIds = new Map<ToolCallId, string>();
  const messages = input.messages.map((message) =>
    openAIMessage(message, providerCallIds),
  );
  const providerOptions = { ...(input.options.providerOptions ?? {}) };
  delete providerOptions.stream;
  delete providerOptions.stream_options;
  const body: JsonObject = {
    model: target.model,
    messages,
    ...(input.options.temperature === undefined
      ? {}
      : { temperature: input.options.temperature }),
    ...(input.options.maxOutputTokens === undefined
      ? {}
      : { max_tokens: input.options.maxOutputTokens }),
    ...(input.options.seed === undefined ? {} : { seed: input.options.seed }),
    ...(input.options.stop === undefined ? {} : { stop: input.options.stop }),
    ...(input.tools.length === 0
      ? {}
      : {
          tools: input.tools.map((tool) => ({
            type: "function",
            function: {
              ...(tool.providerOptions ?? {}),
              name: tool.name,
              ...(tool.description === undefined
                ? {}
                : { description: tool.description }),
              parameters: tool.inputSchema,
            },
          })),
        }),
    ...providerOptions,
    // Delivery mode is application-owned and cannot be contradicted by raw
    // provider options.
    stream: input.responseMode === "streaming",
    ...(input.responseMode === "streaming"
      ? { stream_options: { include_usage: true } }
      : {}),
  };
  return { url, body };
}

function completeReasoning(response: OpenAIResponse): string | undefined {
  const message = response.choices?.[0]?.message;
  if (!message) return undefined;
  if (message.reasoning) return message.reasoning;
  if (message.reasoning_content) return message.reasoning_content;
  const detailText = message.reasoning_details
    ?.filter((detail) => detail.type === "reasoning.text")
    .map((detail) => detail.text ?? "")
    .join("");
  return detailText || undefined;
}

/**
 * Normalizes a completed chat-completions JSON response into the event
 * vocabulary used by streaming responses. Complete values become one delta
 * apiece, so reducers and projections stay independent of delivery mode.
 */
export async function* normalizeOpenAICompatibleResponse(
  execution: ProviderExecution,
  raw: string,
): AsyncGenerator<ProviderEvent> {
  const source = { exchangeId: execution.exchangeId, frameIndex: 0 };
  yield { type: "frame", frame: { index: 0, raw } };

  let response: OpenAIResponse;
  try {
    response = JSON.parse(raw) as OpenAIResponse;
  } catch {
    throw new OpenAICompatibleProtocolError(
      "Provider returned invalid JSON for a buffered response.",
    );
  }
  const choice = response.choices?.[0];
  if (!choice?.message || typeof choice.message !== "object") {
    throw new OpenAICompatibleProtocolError(
      "Provider buffered response did not include choices[0].message.",
    );
  }

  const reasoning = completeReasoning(response);
  if (reasoning) yield { type: "reasoning_delta", reasoning, source };
  if (choice.message.content) {
    yield { type: "text_delta", text: choice.message.content, source };
  }
  for (const [index, toolCall] of (choice.message.tool_calls ?? []).entries()) {
    yield {
      type: "tool_call_delta",
      toolCallId: createEntityId(
        "tool-call",
        `${execution.exchangeId}-${index}`,
      ),
      index,
      providerCallId: toolCall.id,
      nameDelta: toolCall.function?.name,
      argumentsDelta: toolCall.function?.arguments,
      source,
    };
  }
  const usage = normalizedUsage(response);
  if (usage) yield { type: "usage", usage, source };
  yield {
    type: "completed",
    finishReason:
      typeof choice.finish_reason === "string"
        ? normalizedFinishReason(choice.finish_reason)
        : { normalized: "other" },
    source,
  };
}

/**
 * Turns a raw byte stream into complete lines, splitting on `\r\n` or `\n`.
 * The final chunk's tail (which has no trailing newline) is flushed as its
 * own line once the stream ends.
 */
export async function* sseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) yield line;
    if (done) break;
  }
}

/**
 * Consumes complete SSE lines from an OpenAI-compatible chat-completions
 * stream and yields normalized provider events. Throws
 * OpenAICompatibleStreamProtocolError if the lines end without a
 * `finish_reason` or `[DONE]`. Does not emit `request` or `response_started`
 * — those belong to whichever host made the request.
 */
export async function* normalizeOpenAICompatibleStream(
  execution: ProviderExecution,
  lines: AsyncIterable<string>,
): AsyncGenerator<ProviderEvent> {
  let frameIndex = 0;
  const toolCallIds = new Map<number, ToolCallId>();
  let sawTerminalSignal = false;
  let emittedCompletion = false;

  for await (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    const currentFrameIndex = frameIndex++;
    yield {
      type: "frame",
      frame: {
        index: currentFrameIndex,
        raw: line,
      },
    };
    const source = {
      exchangeId: execution.exchangeId,
      frameIndex: currentFrameIndex,
    };
    if (data === "[DONE]") {
      sawTerminalSignal = true;
      if (!emittedCompletion) {
        emittedCompletion = true;
        yield {
          type: "completed",
          finishReason: { normalized: "other" },
          source,
        };
      }
      continue;
    }

    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(data) as OpenAIChunk;
    } catch {
      continue;
    }
    const choice = chunk.choices?.[0];
    const text = choice?.delta?.content;
    if (text) yield { type: "text_delta", text, source };
    const reasoning = reasoningDelta(chunk);
    if (reasoning) yield { type: "reasoning_delta", reasoning, source };

    for (const toolCall of choice?.delta?.tool_calls ?? []) {
      const index = toolCall.index ?? 0;
      let toolCallId = toolCallIds.get(index);
      if (!toolCallId) {
        toolCallId = createEntityId(
          "tool-call",
          `${execution.exchangeId}-${index}`,
        );
        toolCallIds.set(index, toolCallId);
      }
      yield {
        type: "tool_call_delta",
        toolCallId,
        index,
        providerCallId: toolCall.id,
        nameDelta: toolCall.function?.name,
        argumentsDelta: toolCall.function?.arguments,
        source,
      };
    }

    const usage = normalizedUsage(chunk);
    if (usage) yield { type: "usage", usage, source };

    if (choice?.finish_reason) {
      sawTerminalSignal = true;
      if (!emittedCompletion) {
        emittedCompletion = true;
        yield {
          type: "completed",
          finishReason: normalizedFinishReason(choice.finish_reason),
          source,
        };
      }
    }
  }

  if (!sawTerminalSignal) {
    throw new OpenAICompatibleStreamProtocolError(
      "Provider stream ended before sending finish_reason or [DONE].",
    );
  }
}

export async function* streamOpenAICompatibleProvider(
  execution: ProviderExecution,
  apiKey: string,
  signal?: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const { url, body } = buildChatCompletionsRequest(execution);
  const bodyText = JSON.stringify(body);

  yield {
    type: "request",
    request: {
      url: redactedProviderUrl(url),
      method: "POST",
      headers: {
        authorization: apiKey ? "Bearer ••••••••" : "(not set)",
        "content-type": "application/json",
      },
      body: bodyText,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey
        ? { authorization: `Bearer ${apiKey}` }
        : {}),
    },
    body: bodyText,
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
    yield* normalizeOpenAICompatibleResponse(execution, await response.text());
    return;
  }
  if (!response.body) throw new Error("Provider returned an empty response.");
  yield* normalizeOpenAICompatibleStream(execution, sseLines(response.body));
}

function contentText(message: ConversationMessage): string {
  return message.content.map(({ text }) => text).join("");
}

function openAIMessage(
  message: ConversationMessage,
  providerCallIds: Map<ToolCallId, string>,
): JsonObject {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: contentText(message) };
    case "assistant": {
      const toolCalls = message.toolCalls?.map((call) => {
        const providerCallId = call.providerCallId ?? call.id;
        providerCallIds.set(call.id, providerCallId);
        return {
          id: providerCallId,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments.text,
          },
        };
      });
      return {
        role: "assistant",
        content: contentText(message) || null,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      };
    }
    case "tool":
      return {
        role: "tool",
        content: contentText(message),
        tool_call_id:
          providerCallIds.get(message.toolCallId) ?? message.toolCallId,
        ...(message.name ? { name: message.name } : {}),
      };
  }
}
