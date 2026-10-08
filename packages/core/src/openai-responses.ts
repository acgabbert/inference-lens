import { createEntityId } from "./run-kernel/types.ts";
import type {
  ConversationMessage,
  EventSource,
  FinishReason,
  JsonObject,
  JsonValue,
  ProviderEvent,
  ProviderExecution,
  RunTokenUsage,
  ToolCallId,
} from "./run-kernel/types.ts";
import {
  ProviderProtocolError,
  ProviderReportedError,
  providerRequestUrl,
} from "./provider-protocols.ts";

/**
 * The OpenAI Responses API, used statelessly: every turn sends the whole
 * conversation as `input` items with `store: false`, and nothing refers to a
 * previous response by id. A turn's input therefore stays self-contained, so
 * retry, branching, and replay never depend on what a provider retained.
 */

type ResponsesItem = {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
  summary?: Array<{ type?: string; text?: string }>;
  encrypted_content?: string;
};

type ResponsesUsage = {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
};

type ResponsesObject = {
  status?: string;
  output?: ResponsesItem[];
  usage?: ResponsesUsage;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
};

type ResponsesStreamEvent = {
  type?: string;
  output_index?: number;
  item_id?: string;
  item?: ResponsesItem;
  delta?: string;
  response?: ResponsesObject;
  code?: string;
  message?: string;
};

function contentText(message: ConversationMessage): string {
  return message.content.map(({ text }) => text).join("");
}

function inputItems(messages: ConversationMessage[]): JsonObject[] {
  const providerCallIds = new Map<ToolCallId, string>();
  return messages.flatMap((message): JsonObject[] => {
    switch (message.role) {
      case "system":
      case "user":
        return [{ type: "message", role: message.role, content: contentText(message) }];
      case "assistant": {
        const text = contentText(message);
        // Reasoning items lead the turn they came from. Another protocol's
        // continuation means nothing here and is left out.
        const continuation =
          message.providerContinuation?.protocol === "openai-responses"
            ? (message.providerContinuation.items as JsonObject[])
            : [];
        return [
          ...continuation,
          ...(text ? [{ type: "message", role: "assistant", content: text }] : []),
          ...(message.toolCalls ?? []).map((call) => {
            const providerCallId = call.providerCallId ?? call.id;
            providerCallIds.set(call.id, providerCallId);
            return {
              type: "function_call",
              call_id: providerCallId,
              name: call.name,
              arguments: call.arguments.text,
            };
          }),
        ];
      }
      case "tool":
        return [{
          type: "function_call_output",
          call_id: providerCallIds.get(message.toolCallId) ?? message.toolCallId,
          output: contentText(message),
        }];
    }
  });
}

/**
 * Builds the `/responses` request URL and body for one provider turn. Pure and
 * secret-free: callers attach credentials themselves.
 */
export function buildResponsesRequest(
  execution: ProviderExecution,
): { url: string; body: JsonObject } {
  const { input } = execution;
  const { target, options } = input;
  if (!target.capabilities.responsesApi) {
    throw new Error("The Responses API is not supported by this profile.");
  }
  if (input.responseMode === "streaming" && !target.capabilities.streaming) {
    throw new Error("Streaming is not supported by this profile.");
  }
  if (input.tools.length > 0 && !target.capabilities.tools) {
    throw new Error("Tools are not supported by this profile.");
  }
  // Refused rather than dropped: a run whose evidence omits an option the
  // author set would misreport what was asked for.
  if (options.seed !== undefined) {
    throw new Error("The Responses API does not accept a seed.");
  }
  if (options.stop !== undefined) {
    throw new Error("The Responses API does not accept stop sequences.");
  }
  const providerOptions = { ...(options.providerOptions ?? {}) };
  delete providerOptions.stream;
  const body: JsonObject = {
    model: target.model,
    input: inputItems(input.messages),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: options.maxOutputTokens }),
    ...(input.tools.length === 0
      ? {}
      : {
          tools: input.tools.map((tool) => ({
            type: "function",
            // Responses defaults function tools to strict schemas, which most
            // authored schemas do not satisfy. Sent explicitly so the request
            // says what was asked, and a tool can still opt in.
            strict: false,
            ...(tool.providerOptions ?? {}),
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            parameters: tool.inputSchema,
          })),
        }),
    store: false,
    // Nothing is stored, so reasoning can only carry across tool turns as
    // encrypted content the next request sends back.
    include: ["reasoning.encrypted_content"],
    ...providerOptions,
    // Delivery mode is application-owned and cannot be contradicted by raw
    // provider options.
    stream: input.responseMode === "streaming",
  };
  return { url: providerRequestUrl(target.endpoint, "openai-responses"), body };
}

/**
 * Only reasoning that carries `encrypted_content` can be replayed: with
 * `store: false` an item id alone refers to nothing the provider kept.
 */
function isReplayableReasoning(item: ResponsesItem | undefined): boolean {
  return item?.type === "reasoning" && typeof item.encrypted_content === "string";
}

function continuationEvent(items: ResponsesItem[], source: EventSource): ProviderEvent[] {
  return items.length === 0
    ? []
    : [{
        type: "continuation",
        continuation: { protocol: "openai-responses", items: items as JsonValue[] },
        source,
      }];
}

function normalizedUsage(usage: ResponsesUsage | undefined): RunTokenUsage | undefined {
  if (!usage) return undefined;
  const number = (value: unknown) => (typeof value === "number" ? value : undefined);
  const result: RunTokenUsage = {};
  const inputTokens = number(usage.input_tokens);
  const outputTokens = number(usage.output_tokens);
  const totalTokens = number(usage.total_tokens);
  const cachedInputTokens = number(usage.input_tokens_details?.cached_tokens);
  const reasoningTokens = number(usage.output_tokens_details?.reasoning_tokens);
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  if (cachedInputTokens !== undefined) result.cachedInputTokens = cachedInputTokens;
  if (reasoningTokens !== undefined) result.reasoningTokens = reasoningTokens;
  return Object.keys(result).length > 0 ? result : undefined;
}

function reportedFailure(error: { code?: string; message?: string } | null | undefined): ProviderReportedError {
  const message = error?.message || "The provider reported that the response failed.";
  return new ProviderReportedError(error?.code ? `${error.code}: ${message}` : message);
}

/**
 * How a finished response ended. A completed response that called a function
 * ended on tool calls; the Responses API reports both as `completed`.
 */
function finishReason(
  response: ResponsesObject,
  calledTools: boolean,
  refused: boolean,
): FinishReason {
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    switch (reason) {
      case "max_output_tokens":
        return { normalized: "length", raw: reason };
      case "content_filter":
        return { normalized: "content_filter", raw: reason };
      default:
        return { normalized: "other", raw: reason ?? "incomplete" };
    }
  }
  if (calledTools) return { normalized: "tool_calls", raw: response.status ?? "completed" };
  if (refused) return { normalized: "content_filter", raw: "refusal" };
  return { normalized: "stop", raw: response.status ?? "completed" };
}

/** Tracks function calls by output position so each gets a stable tool-call id. */
class FunctionCalls {
  private readonly calls = new Map<string, { toolCallId: ToolCallId; index: number; argumentsText: string }>();
  private readonly execution: ProviderExecution;

  constructor(execution: ProviderExecution) {
    this.execution = execution;
  }

  get size(): number {
    return this.calls.size;
  }

  key(event: { output_index?: number; item_id?: string; item?: ResponsesItem }): string {
    if (typeof event.output_index === "number") return `#${event.output_index}`;
    return event.item_id ?? event.item?.id ?? `#${this.calls.size}`;
  }

  get(key: string) {
    return this.calls.get(key);
  }

  open(key: string) {
    const existing = this.calls.get(key);
    if (existing) return { call: existing, created: false };
    const index = this.calls.size;
    const call = {
      toolCallId: createEntityId("tool-call", `${this.execution.exchangeId}-${index}`),
      index,
      argumentsText: "",
    };
    this.calls.set(key, call);
    return { call, created: true };
  }
}

/**
 * Consumes complete SSE lines from a Responses stream and yields normalized
 * provider events. Every `data:` line is a frame; the `event:` lines that name
 * each one repeat the `type` inside its data and are not recorded separately.
 * Throws ProviderProtocolError if the stream ends before a terminal event, and
 * ProviderReportedError if the provider reports a failure.
 */
export async function* normalizeResponsesStream(
  execution: ProviderExecution,
  lines: AsyncIterable<string>,
): AsyncGenerator<ProviderEvent> {
  let frameIndex = 0;
  const calls = new FunctionCalls(execution);
  let refused = false;
  let finished = false;
  const reasoningItems: ResponsesItem[] = [];

  for await (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    const currentFrameIndex = frameIndex++;
    yield { type: "frame", frame: { index: currentFrameIndex, raw: line } };
    if (finished || data === "[DONE]") continue;
    const source: EventSource = { exchangeId: execution.exchangeId, frameIndex: currentFrameIndex };

    let event: ResponsesStreamEvent;
    try {
      event = JSON.parse(data) as ResponsesStreamEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) yield { type: "text_delta", text: event.delta, source };
        break;
      case "response.refusal.delta":
        if (event.delta) {
          refused = true;
          yield { type: "text_delta", text: event.delta, source };
        }
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (event.delta) yield { type: "reasoning_delta", reasoning: event.delta, source };
        break;
      case "response.output_item.added": {
        if (event.item?.type !== "function_call") break;
        const { call } = calls.open(calls.key(event));
        call.argumentsText += event.item.arguments ?? "";
        yield {
          type: "tool_call_delta",
          toolCallId: call.toolCallId,
          index: call.index,
          providerCallId: event.item.call_id,
          nameDelta: event.item.name,
          argumentsDelta: event.item.arguments ?? "",
          source,
        };
        break;
      }
      case "response.function_call_arguments.delta": {
        if (!event.delta) break;
        const { call } = calls.open(calls.key(event));
        call.argumentsText += event.delta;
        yield {
          type: "tool_call_delta",
          toolCallId: call.toolCallId,
          index: call.index,
          argumentsDelta: event.delta,
          source,
        };
        break;
      }
      case "response.output_item.done": {
        if (isReplayableReasoning(event.item)) reasoningItems.push(event.item!);
        if (event.item?.type !== "function_call") break;
        // A server may report a call only once it is complete. Whatever the
        // stream has not already carried is sent now, so the run sees the
        // same call either way.
        const { call, created } = calls.open(calls.key(event));
        const complete = event.item.arguments ?? "";
        const missing = call.argumentsText === "" ? complete : "";
        if (!created && !missing) break;
        call.argumentsText += missing;
        yield {
          type: "tool_call_delta",
          toolCallId: call.toolCallId,
          index: call.index,
          ...(created
            ? { providerCallId: event.item.call_id, nameDelta: event.item.name }
            : {}),
          argumentsDelta: missing,
          source,
        };
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = event.response ?? {};
        yield* continuationEvent(reasoningItems, source);
        const usage = normalizedUsage(response.usage);
        if (usage) yield { type: "usage", usage, source };
        const calledTools = calls.size > 0 ||
          (response.output ?? []).some((item) => item.type === "function_call");
        finished = true;
        yield { type: "completed", finishReason: finishReason(response, calledTools, refused), source };
        break;
      }
      case "response.failed":
        throw reportedFailure(event.response?.error);
      case "error":
        throw reportedFailure(event);
    }
  }

  if (!finished) {
    throw new ProviderProtocolError(
      "Provider stream ended before response.completed, response.incomplete, or response.failed.",
    );
  }
}

/**
 * Normalizes a buffered Responses JSON body into the event vocabulary used by
 * streaming, one delta per kind, so reducers stay independent of delivery.
 */
export async function* normalizeResponsesResponse(
  execution: ProviderExecution,
  raw: string,
): AsyncGenerator<ProviderEvent> {
  const source: EventSource = { exchangeId: execution.exchangeId, frameIndex: 0 };
  yield { type: "frame", frame: { index: 0, raw } };

  let response: ResponsesObject;
  try {
    response = JSON.parse(raw) as ResponsesObject;
  } catch {
    throw new ProviderProtocolError("Provider returned invalid JSON for a buffered response.");
  }
  if (response.status === "failed") throw reportedFailure(response.error);
  if (!Array.isArray(response.output)) {
    throw new ProviderProtocolError("Provider buffered response did not include output.");
  }

  const reasoning = response.output
    .filter((item) => item.type === "reasoning")
    .map((item) => {
      const content = (item.content ?? [])
        .filter((part) => part.type === "reasoning_text")
        .map((part) => part.text ?? "")
        .join("");
      return content || (item.summary ?? []).map((part) => part.text ?? "").join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
  if (reasoning) yield { type: "reasoning_delta", reasoning, source };

  let refused = false;
  const text = response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .map((part) => {
      if (part.type === "refusal") {
        refused = true;
        return part.refusal ?? "";
      }
      return part.type === "output_text" ? part.text ?? "" : "";
    })
    .join("");
  if (text) yield { type: "text_delta", text, source };

  const calls = response.output.filter((item) => item.type === "function_call");
  for (const [index, call] of calls.entries()) {
    yield {
      type: "tool_call_delta",
      toolCallId: createEntityId("tool-call", `${execution.exchangeId}-${index}`),
      index,
      providerCallId: call.call_id,
      nameDelta: call.name,
      argumentsDelta: call.arguments,
      source,
    };
  }

  yield* continuationEvent(response.output.filter(isReplayableReasoning), source);
  const usage = normalizedUsage(response.usage);
  if (usage) yield { type: "usage", usage, source };
  yield {
    type: "completed",
    finishReason: finishReason(response, calls.length > 0, refused),
    source,
  };
}
