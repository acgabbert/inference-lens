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
 * The native Anthropic Messages API. The credential header and API version
 * belong to `provider-protocols.ts`; this module owns only the body and the
 * normalization of what comes back.
 */

/**
 * Sent as `max_tokens` when the run sets no output limit, because the API
 * requires one. It appears in the request evidence like any other field.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type AnthropicMessage = {
  type?: string;
  content?: ContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
};

type StreamEvent = {
  type?: string;
  index?: number;
  message?: AnthropicMessage;
  content_block?: ContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
};

function contentText(message: ConversationMessage): string {
  return message.content.map(({ text }) => text).join("");
}

function toolInput(text: string, parsed: JsonObject | undefined, name: string): JsonObject {
  if (parsed) return parsed;
  // A call with no arguments is an empty object; anything else that is not
  // an object cannot be expressed as `tool_use.input` without inventing it.
  if (!text.trim()) return {};
  throw new Error(
    `The arguments of tool call ${name} must be a JSON object to be sent to Anthropic Messages.`,
  );
}

function anthropicMessages(
  messages: ConversationMessage[],
): { system?: string; messages: JsonObject[] } {
  let index = 0;
  const leadingSystem: string[] = [];
  while (messages[index]?.role === "system") {
    leadingSystem.push(contentText(messages[index]!));
    index += 1;
  }
  const providerCallIds = new Map<ToolCallId, string>();
  const result: JsonObject[] = [];
  for (const message of messages.slice(index)) {
    switch (message.role) {
      // A later system message is sent where it was written. Models that
      // accept mid-conversation system messages honor it; others answer with
      // their own error rather than this adapter moving or dropping it.
      case "system":
      case "user":
        result.push({ role: message.role, content: contentText(message) });
        break;
      case "assistant": {
        const text = contentText(message);
        const calls = message.toolCalls ?? [];
        // Thinking blocks lead the turn they came from. Another protocol's
        // continuation means nothing here and is left out.
        const continuation =
          message.providerContinuation?.protocol === "anthropic-messages"
            ? message.providerContinuation.items
            : [];
        if (calls.length === 0 && continuation.length === 0) {
          result.push({ role: "assistant", content: text });
          break;
        }
        result.push({
          role: "assistant",
          content: [
            ...continuation,
            ...(text ? [{ type: "text", text }] : []),
            ...calls.map((call) => {
              const id = call.providerCallId ?? call.id;
              providerCallIds.set(call.id, id);
              return {
                type: "tool_use",
                id,
                name: call.name,
                input: toolInput(call.arguments.text, call.arguments.parsed, call.name),
              };
            }),
          ],
        });
        break;
      }
      case "tool": {
        const block = {
          type: "tool_result",
          tool_use_id: providerCallIds.get(message.toolCallId) ?? message.toolCallId,
          content: contentText(message),
        };
        // Results of one turn's calls travel together in a single user turn.
        const previous = result.at(-1);
        const previousContent = previous?.content;
        if (
          previous?.role === "user" &&
          Array.isArray(previousContent) &&
          previousContent.every((part) =>
            (part as { type?: string }).type === "tool_result")
        ) {
          previousContent.push(block);
        } else {
          result.push({ role: "user", content: [block] });
        }
        break;
      }
    }
  }
  return {
    ...(leadingSystem.length > 0 ? { system: leadingSystem.join("\n\n") } : {}),
    messages: result,
  };
}

/**
 * Builds the `/messages` request URL and body for one provider turn. Pure and
 * secret-free: callers attach credentials and the version header themselves.
 */
export function buildAnthropicMessagesRequest(
  execution: ProviderExecution,
): { url: string; body: JsonObject } {
  const { input } = execution;
  const { target, options } = input;
  if (!target.capabilities.anthropicMessages) {
    throw new Error("Anthropic Messages is not supported by this profile.");
  }
  if (input.responseMode === "streaming" && !target.capabilities.streaming) {
    throw new Error("Streaming is not supported by this profile.");
  }
  if (input.tools.length > 0 && !target.capabilities.tools) {
    throw new Error("Tools are not supported by this profile.");
  }
  if (options.seed !== undefined) {
    throw new Error("Anthropic Messages does not accept a seed.");
  }
  const { system, messages } = anthropicMessages(input.messages);
  const providerOptions = { ...(options.providerOptions ?? {}) };
  delete providerOptions.stream;
  const body: JsonObject = {
    model: target.model,
    ...(system === undefined ? {} : { system }),
    messages,
    max_tokens: options.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop === undefined ? {} : { stop_sequences: options.stop }),
    ...(input.tools.length === 0
      ? {}
      : {
          tools: input.tools.map((tool) => ({
            ...(tool.providerOptions ?? {}),
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            input_schema: tool.inputSchema,
          })),
        }),
    ...providerOptions,
    stream: input.responseMode === "streaming",
  };
  return { url: providerRequestUrl(target.endpoint, "anthropic-messages"), body };
}

/**
 * `input_tokens` excludes cache reads and writes; the run's input count
 * includes them, so it compares with providers that report a single prompt
 * total. Cache reads are also reported on their own.
 */
function normalizedUsage(usage: AnthropicUsage): RunTokenUsage | undefined {
  const number = (value: unknown) => (typeof value === "number" ? value : undefined);
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
    .map(number);
  const result: RunTokenUsage = {};
  if (parts.some((part) => part !== undefined)) {
    result.inputTokens = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
  }
  const cached = number(usage.cache_read_input_tokens);
  if (cached !== undefined) result.cachedInputTokens = cached;
  const output = number(usage.output_tokens);
  if (output !== undefined) result.outputTokens = output;
  if (result.inputTokens !== undefined && output !== undefined) {
    result.totalTokens = result.inputTokens + output;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isThinkingBlock(block: ContentBlock): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

function continuationEvent(
  items: JsonValue[],
  source: EventSource,
): ProviderEvent[] {
  return items.length === 0
    ? []
    : [{ type: "continuation", continuation: { protocol: "anthropic-messages", items }, source }];
}

function finishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return { normalized: "stop", raw };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { normalized: "length", raw };
    case "tool_use":
      return { normalized: "tool_calls", raw };
    case "refusal":
      return { normalized: "content_filter", raw };
    case null:
    case undefined:
      return { normalized: "other" };
    default:
      return { normalized: "other", raw };
  }
}

function reportedFailure(error: { type?: string; message?: string } | undefined): ProviderReportedError {
  const message = error?.message || "The provider reported an error.";
  return new ProviderReportedError(error?.type ? `${error.type}: ${message}` : message);
}

/**
 * Consumes complete SSE lines from a Messages stream and yields normalized
 * provider events. Every `data:` line is a frame. Throws ProviderProtocolError
 * if the stream ends before `message_stop`, and ProviderReportedError for an
 * in-stream `error` event.
 */
export async function* normalizeAnthropicMessagesStream(
  execution: ProviderExecution,
  lines: AsyncIterable<string>,
): AsyncGenerator<ProviderEvent> {
  let frameIndex = 0;
  const usage: AnthropicUsage = {};
  let stopReason: string | null | undefined;
  const toolCalls = new Map<number, { toolCallId: ToolCallId; index: number }>();
  // Thinking blocks by content index, rebuilt exactly as the provider sent
  // them, so the next turn can return them unchanged.
  const thinkingBlocks = new Map<number, Record<string, string>>();
  let stopped = false;

  for await (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    const currentFrameIndex = frameIndex++;
    yield { type: "frame", frame: { index: currentFrameIndex, raw: line } };
    if (stopped) continue;
    const source: EventSource = { exchangeId: execution.exchangeId, frameIndex: currentFrameIndex };

    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case "message_start":
        Object.assign(usage, event.message?.usage ?? {});
        break;
      case "content_block_start": {
        const block = event.content_block;
        if (block && isThinkingBlock(block)) {
          thinkingBlocks.set(
            event.index ?? thinkingBlocks.size,
            block.type === "thinking"
              ? { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" }
              : { type: "redacted_thinking", data: block.data ?? "" },
          );
        }
        if (block?.type === "text" && block.text) {
          yield { type: "text_delta", text: block.text, source };
        } else if (block?.type === "thinking" && block.thinking) {
          yield { type: "reasoning_delta", reasoning: block.thinking, source };
        } else if (block?.type === "tool_use") {
          const call = {
            toolCallId: createEntityId("tool-call", `${execution.exchangeId}-${toolCalls.size}`),
            index: toolCalls.size,
          };
          toolCalls.set(event.index ?? toolCalls.size, call);
          yield {
            type: "tool_call_delta",
            toolCallId: call.toolCallId,
            index: call.index,
            providerCallId: block.id,
            nameDelta: block.name,
            argumentsDelta: "",
            source,
          };
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta?.type === "text_delta" && delta.text) {
          yield { type: "text_delta", text: delta.text, source };
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          const block = thinkingBlocks.get(event.index ?? -1);
          if (block) block.thinking += delta.thinking;
          yield { type: "reasoning_delta", reasoning: delta.thinking, source };
        } else if (delta?.type === "signature_delta" && delta.signature) {
          const block = thinkingBlocks.get(event.index ?? -1);
          if (block) block.signature += delta.signature;
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          const call = toolCalls.get(event.index ?? -1);
          if (call) {
            yield {
              type: "tool_call_delta",
              toolCallId: call.toolCallId,
              index: call.index,
              argumentsDelta: delta.partial_json,
              source,
            };
          }
        }
        break;
      }
      case "message_delta":
        if (event.delta?.stop_reason !== undefined) stopReason = event.delta.stop_reason;
        Object.assign(usage, event.usage ?? {});
        break;
      case "message_stop": {
        stopped = true;
        yield* continuationEvent(
          [...thinkingBlocks.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, block]) => block),
          source,
        );
        const normalized = normalizedUsage(usage);
        if (normalized) yield { type: "usage", usage: normalized, source };
        yield { type: "completed", finishReason: finishReason(stopReason), source };
        break;
      }
      case "error":
        throw reportedFailure(event.error);
    }
  }

  if (!stopped) {
    throw new ProviderProtocolError("Provider stream ended before message_stop.");
  }
}

/**
 * Normalizes a buffered Messages JSON body into the event vocabulary used by
 * streaming, one delta per kind, so reducers stay independent of delivery.
 */
export async function* normalizeAnthropicMessagesResponse(
  execution: ProviderExecution,
  raw: string,
): AsyncGenerator<ProviderEvent> {
  const source: EventSource = { exchangeId: execution.exchangeId, frameIndex: 0 };
  yield { type: "frame", frame: { index: 0, raw } };

  let message: AnthropicMessage;
  try {
    message = JSON.parse(raw) as AnthropicMessage;
  } catch {
    throw new ProviderProtocolError("Provider returned invalid JSON for a buffered response.");
  }
  if (message.type === "error") throw reportedFailure(message.error);
  if (!Array.isArray(message.content)) {
    throw new ProviderProtocolError("Provider buffered response did not include content.");
  }

  const reasoning = message.content
    .filter((block) => block.type === "thinking" && block.thinking)
    .map((block) => block.thinking)
    .join("\n\n");
  if (reasoning) yield { type: "reasoning_delta", reasoning, source };

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  if (text) yield { type: "text_delta", text, source };

  const calls = message.content.filter((block) => block.type === "tool_use");
  for (const [index, call] of calls.entries()) {
    yield {
      type: "tool_call_delta",
      toolCallId: createEntityId("tool-call", `${execution.exchangeId}-${index}`),
      index,
      providerCallId: call.id,
      nameDelta: call.name,
      argumentsDelta: JSON.stringify(call.input ?? {}),
      source,
    };
  }

  yield* continuationEvent(
    message.content.filter(isThinkingBlock) as JsonValue[],
    source,
  );
  const usage = message.usage ? normalizedUsage(message.usage) : undefined;
  if (usage) yield { type: "usage", usage, source };
  yield { type: "completed", finishReason: finishReason(message.stop_reason), source };
}
