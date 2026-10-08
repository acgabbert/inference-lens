import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  buildAnthropicMessagesRequest,
  normalizeAnthropicMessagesResponse,
  normalizeAnthropicMessagesStream,
} from "../packages/core/src/anthropic-messages.ts";
import {
  ProviderProtocolError,
  ProviderReportedError,
} from "../packages/core/src/provider-protocols.ts";
import { providerProtocolAdapter } from "../packages/core/src/provider-adapters.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import { createEntityId } from "../packages/core/src/run-kernel/index.ts";
import type {
  ProviderEvent,
  ProviderExecution,
  ProviderTurnInput,
} from "../packages/core/src/run-kernel/index.ts";

const exchangeId = createEntityId("exchange", "first");
const firstCall = createEntityId("tool-call", "weather");
const secondCall = createEntityId("tool-call", "time");
const capabilities = { ...OPENAI_COMPATIBLE_CAPABILITIES, chatCompletions: false, anthropicMessages: true, tools: true };

const turnInput: ProviderTurnInput = {
  target: {
    profileId: createEntityId("profile", "anthropic"),
    protocol: "anthropic-messages",
    endpoint: "https://api.anthropic.com/v1",
    model: "claude-opus-5-5",
    capabilities,
  },
  messages: [
    { id: createEntityId("message", "s1"), role: "system", content: [{ type: "text", text: "Be brief." }] },
    { id: createEntityId("message", "s2"), role: "system", content: [{ type: "text", text: "Use metric." }] },
    { id: createEntityId("message", "u"), role: "user", content: [{ type: "text", text: "Weather and time?" }] },
    {
      id: createEntityId("message", "a"),
      role: "assistant",
      content: [{ type: "text", text: "Checking." }],
      toolCalls: [
        { id: firstCall, providerCallId: "toolu_1", name: "get_weather", arguments: { text: '{"city":"Paris"}', parsed: { city: "Paris" } } },
        { id: secondCall, providerCallId: "toolu_2", name: "get_time", arguments: { text: "" } },
      ],
    },
    { id: createEntityId("message", "t1"), role: "tool", toolCallId: firstCall, content: [{ type: "text", text: "Sunny" }] },
    { id: createEntityId("message", "t2"), role: "tool", toolCallId: secondCall, content: [{ type: "text", text: "Noon" }] },
    { id: createEntityId("message", "s3"), role: "system", content: [{ type: "text", text: "Answer now." }] },
  ],
  responseMode: "streaming",
  options: { temperature: 0.5, stop: ["END"] },
  tools: [{
    id: createEntityId("tool", "weather"),
    name: "get_weather",
    description: "Look up weather.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  }],
};

function execution(input: Partial<ProviderTurnInput> = {}): ProviderExecution {
  return {
    runId: createEntityId("run", "test"),
    turnId: createEntityId("turn", "first"),
    attempt: 1,
    exchangeId,
    input: { ...turnInput, ...input },
  };
}

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const values: ProviderEvent[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function withoutSource(event: ProviderEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([key]) => key !== "source"));
}

async function* lines(values: string[]): AsyncGenerator<string> {
  yield* values;
}

function sse(...events: object[]): string[] {
  return events.flatMap((event) => [
    `event: ${(event as { type: string }).type}`,
    `data: ${JSON.stringify(event)}`,
    "",
  ]);
}

test("an Anthropic request hoists leading system text and groups tool results", () => {
  const { url, body } = buildAnthropicMessagesRequest(execution());
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(body, {
    model: "claude-opus-5-5",
    system: "Be brief.\n\nUse metric.",
    messages: [
      { role: "user", content: "Weather and time?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
          { type: "tool_use", id: "toolu_2", name: "get_time", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "Sunny" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "Noon" },
        ],
      },
      { role: "system", content: "Answer now." },
    ],
    max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
    temperature: 0.5,
    stop_sequences: ["END"],
    tools: [{
      name: "get_weather",
      description: "Look up weather.",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    }],
    stream: true,
  });
  assert.equal(ANTHROPIC_DEFAULT_MAX_TOKENS, 4096);
});

test("an authored output limit replaces the default, and a seed is refused", () => {
  const { body } = buildAnthropicMessagesRequest(execution({ options: { maxOutputTokens: 900, providerOptions: { stream: true, thinking: { type: "adaptive" } } }, responseMode: "buffered" }));
  assert.equal(body.max_tokens, 900);
  assert.equal(body.stream, false);
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.throws(() => buildAnthropicMessagesRequest(execution({ options: { seed: 1 } })), /does not accept a seed/);
  assert.throws(
    () => buildAnthropicMessagesRequest(execution({ target: { ...turnInput.target, capabilities: OPENAI_COMPATIBLE_CAPABILITIES } })),
    /Anthropic Messages is not supported by this profile/,
  );
  assert.throws(
    () => buildAnthropicMessagesRequest(execution({
      messages: [{
        id: createEntityId("message", "bad"),
        role: "assistant",
        content: [],
        toolCalls: [{ id: firstCall, name: "get_weather", arguments: { text: "[1]" } }],
      }],
    })),
    /must be a JSON object/,
  );
});

test("a streamed message normalizes thinking, text, a tool call, and usage", async () => {
  const events = await collect(normalizeAnthropicMessagesStream(execution(), lines(sse(
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Need weather." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "ping" },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking." } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "get_weather", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"Oslo"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 22 } },
    { type: "message_stop" },
  ))));
  assert.equal(events.filter((event) => event.type === "frame").length, 15);
  const toolCallId = createEntityId("tool-call", `${exchangeId}-0`);
  assert.deepEqual(events.filter((event) => event.type !== "frame").map(withoutSource), [
    { type: "reasoning_delta", reasoning: "Need weather." },
    { type: "text_delta", text: "Checking." },
    { type: "tool_call_delta", toolCallId, index: 0, providerCallId: "toolu_9", nameDelta: "get_weather", argumentsDelta: "" },
    { type: "tool_call_delta", toolCallId, index: 0, argumentsDelta: '{"city":' },
    { type: "tool_call_delta", toolCallId, index: 0, argumentsDelta: '"Oslo"}' },
    { type: "usage", usage: { inputTokens: 45, cachedInputTokens: 30, outputTokens: 22, totalTokens: 67 } },
    { type: "completed", finishReason: { normalized: "tool_calls", raw: "tool_use" } },
  ]);
});

test("stop reasons map onto the run's vocabulary", async () => {
  for (const [raw, normalized] of [
    ["end_turn", "stop"], ["stop_sequence", "stop"], ["max_tokens", "length"],
    ["refusal", "content_filter"], ["pause_turn", "other"],
  ] as const) {
    const events = await collect(normalizeAnthropicMessagesStream(execution(), lines(sse(
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "message_delta", delta: { stop_reason: raw }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ))));
    const completed = events.find((event) => event.type === "completed");
    assert.deepEqual(completed && "finishReason" in completed ? completed.finishReason : undefined, { normalized, raw });
  }
});

test("an in-stream error is the provider's, and a truncated stream is a protocol error", async () => {
  await assert.rejects(
    collect(normalizeAnthropicMessagesStream(execution(), lines(sse(
      { type: "message_start", message: {} },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    )))),
    (error: unknown) => error instanceof ProviderReportedError && /overloaded_error: Overloaded/.test(error.message),
  );
  await assert.rejects(
    collect(normalizeAnthropicMessagesStream(execution(), lines(sse(
      { type: "message_start", message: {} },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Cut" } },
    )))),
    (error: unknown) => error instanceof ProviderProtocolError && /ended before message_stop/.test(error.message),
  );
});

test("a buffered message yields the same events from its content blocks", async () => {
  const raw = JSON.stringify({
    id: "msg_2",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Short.", signature: "sig" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Hello " },
      { type: "text", text: "there." },
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Rome" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 5, output_tokens: 7 },
  });
  const events = await collect(normalizeAnthropicMessagesResponse(execution({ responseMode: "buffered" }), raw));
  assert.deepEqual(events[0], { type: "frame", frame: { index: 0, raw } });
  assert.deepEqual(events.slice(1).map(withoutSource), [
    { type: "reasoning_delta", reasoning: "Short." },
    { type: "text_delta", text: "Hello there." },
    {
      type: "tool_call_delta",
      toolCallId: createEntityId("tool-call", `${exchangeId}-0`),
      index: 0,
      providerCallId: "toolu_1",
      nameDelta: "get_weather",
      argumentsDelta: '{"city":"Rome"}',
    },
    { type: "usage", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } },
    { type: "completed", finishReason: { normalized: "tool_calls", raw: "tool_use" } },
  ]);
  await assert.rejects(collect(normalizeAnthropicMessagesResponse(execution(), "nope")), ProviderProtocolError);
  await assert.rejects(
    collect(normalizeAnthropicMessagesResponse(execution(), JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Bad." } }))),
    (error: unknown) => error instanceof ProviderReportedError && /Bad\./.test(error.message),
  );
});

test("the adapter registry serves Anthropic Messages", () => {
  assert.equal(providerProtocolAdapter("anthropic-messages").protocol, "anthropic-messages");
});
