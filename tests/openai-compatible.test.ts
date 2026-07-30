import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatCompletionsRequest,
  normalizeOpenAICompatibleResponse,
  normalizeOpenAICompatibleStream,
  OpenAICompatibleStreamProtocolError,
  parseModelsResponse,
  redactedProviderHeaders,
  redactedProviderUrl,
  sameChatCompletionsTarget,
  sseLines,
} from "../packages/core/src/openai-compatible.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import { createEntityId } from "../packages/core/src/run-kernel/index.ts";
import type {
  ProviderExecution,
  ProviderTurnInput,
} from "../packages/core/src/run-kernel/index.ts";

const runId = createEntityId("run", "test");
const turnId = createEntityId("turn", "first");
const exchangeId = createEntityId("exchange", "first");
const profileId = createEntityId("profile", "openai");

const turnInput: ProviderTurnInput = {
  target: {
    profileId,
    protocol: "openai-compatible-chat-completions",
    endpoint: "https://api.example.com/v1",
    model: "example-model",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  messages: [
    {
      id: createEntityId("message", "user"),
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    },
  ],
  responseMode: "streaming",
  options: { temperature: 0.2 },
  tools: [],
};

const providerExecution: ProviderExecution = {
  runId,
  turnId,
  attempt: 1,
  exchangeId,
  input: turnInput,
};

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test("buildChatCompletionsRequest derives the URL and body without a network call", () => {
  const { url, body } = buildChatCompletionsRequest(providerExecution);
  assert.equal(url, "https://api.example.com/v1/chat/completions");
  assert.equal(body.model, "example-model");
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0.2);
});

test("buildChatCompletionsRequest owns buffered delivery fields", () => {
  const { body } = buildChatCompletionsRequest({
    ...providerExecution,
    input: {
      ...turnInput,
      responseMode: "buffered",
      options: {
        providerOptions: {
          stream: true,
          stream_options: { include_usage: true },
        },
      },
      target: {
        ...turnInput.target,
        capabilities: {
          ...OPENAI_COMPATIBLE_CAPABILITIES,
          streaming: false,
        },
      },
    },
  });
  assert.equal(body.stream, false);
  assert.equal("stream_options" in body, false);
});

test("buildChatCompletionsRequest rejects tools the profile does not support", () => {
  const execution = {
    ...providerExecution,
    input: {
      ...turnInput,
      tools: [
        {
          id: createEntityId("tool", "weather"),
          name: "get_weather",
          inputSchema: { type: "object" },
        },
      ],
    },
  };
  assert.throws(() => buildChatCompletionsRequest(execution), /Tools are not supported/);
});

test("sseLines splits a chunk boundary that falls mid-line", async () => {
  const encoder = new TextEncoder();
  const stream = streamFromChunks([
    encoder.encode("data: {\"choi"),
    encoder.encode("ces\":[]}\ndata: [DONE]\n"),
  ]);
  const lines = await collect(sseLines(stream));
  assert.deepEqual(lines, ['data: {"choices":[]}', "data: [DONE]", ""]);
});

test("sseLines reassembles a multi-byte character split across chunks", async () => {
  const encoded = new TextEncoder().encode("data: 🎉\n");
  const splitPoint = 7; // inside the 4-byte UTF-8 encoding of the emoji
  const stream = streamFromChunks([
    encoded.slice(0, splitPoint),
    encoded.slice(splitPoint),
  ]);
  const lines = await collect(sseLines(stream));
  assert.deepEqual(lines, ["data: 🎉", ""]);
});

test("sseLines handles CRLF line endings", async () => {
  const encoder = new TextEncoder();
  const stream = streamFromChunks([
    encoder.encode("data: one\r\ndata: two\r\n"),
  ]);
  const lines = await collect(sseLines(stream));
  assert.deepEqual(lines, ["data: one", "data: two", ""]);
});

test("sseLines flushes a final line without a trailing newline", async () => {
  const encoder = new TextEncoder();
  const stream = streamFromChunks([encoder.encode("data: [DONE]")]);
  const lines = await collect(sseLines(stream));
  assert.deepEqual(lines, ["data: [DONE]"]);
});

test("normalizeOpenAICompatibleStream drives the happy path from plain lines", async () => {
  async function* lines() {
    yield 'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}';
    yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}';
    yield "data: [DONE]";
    yield "";
  }
  const events = await collect(
    normalizeOpenAICompatibleStream(providerExecution, lines()),
  );
  assert.deepEqual(
    events.map(({ type }) => type),
    ["frame", "text_delta", "frame", "usage", "completed", "frame"],
  );
});

test("normalizeOpenAICompatibleResponse emits one raw frame and shared normalized events", async () => {
  const raw = JSON.stringify({
    choices: [{
      message: {
        content: "Hello",
        reasoning_content: "Brief thought",
        tool_calls: [{
          id: "call_weather",
          function: { name: "weather", arguments: '{"city":"Austin"}' },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: {
      prompt_tokens: 2,
      completion_tokens: 4,
      total_tokens: 6,
    },
  });
  const events = await collect(
    normalizeOpenAICompatibleResponse(
      { ...providerExecution, input: { ...turnInput, responseMode: "buffered" } },
      raw,
    ),
  );
  assert.deepEqual(events.map(({ type }) => type), [
    "frame",
    "reasoning_delta",
    "text_delta",
    "tool_call_delta",
    "usage",
    "completed",
  ]);
  assert.deepEqual(events[0], { type: "frame", frame: { index: 0, raw } });
  assert.deepEqual(events.at(-1), {
    type: "completed",
    finishReason: { normalized: "tool_calls", raw: "tool_calls" },
    source: { exchangeId, frameIndex: 0 },
  });
});

test("normalizeOpenAICompatibleStream treats [DONE] as completion when no finish_reason arrives", async () => {
  async function* lines() {
    yield 'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}';
    yield "data: [DONE]";
  }
  const events = await collect(
    normalizeOpenAICompatibleStream(providerExecution, lines()),
  );
  const completion = events.at(-1);
  assert.deepEqual(completion, {
    type: "completed",
    finishReason: { normalized: "other" },
    source: {
      exchangeId: providerExecution.exchangeId,
      frameIndex: 1,
    },
  });
});

test("normalizeOpenAICompatibleStream preserves malformed and terminal frames verbatim", async () => {
  async function* lines() {
    yield "data: {not-json}";
    yield "data: [DONE]";
  }
  const events = await collect(
    normalizeOpenAICompatibleStream(providerExecution, lines()),
  );
  assert.deepEqual(
    events.filter((event) => event.type === "frame").map((event) => event.frame),
    [
      { index: 0, raw: "data: {not-json}" },
      { index: 1, raw: "data: [DONE]" },
    ],
  );
});

test("normalizeOpenAICompatibleStream throws when the lines end without a terminal signal", async () => {
  async function* lines() {
    yield 'data: {"choices":[{"delta":{"content":"Incomplete"},"finish_reason":null}]}';
  }
  await assert.rejects(
    collect(normalizeOpenAICompatibleStream(providerExecution, lines())),
    OpenAICompatibleStreamProtocolError,
  );
});

test("normalizeOpenAICompatibleStream synthesizes stable tool-call IDs per delta index", async () => {
  async function* lines() {
    yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}';
    yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Chicago\\"}"}}]},"finish_reason":"tool_calls"}]}';
    yield "data: [DONE]";
  }
  const events = await collect(
    normalizeOpenAICompatibleStream(providerExecution, lines()),
  );
  const toolCallDeltas = events.filter(
    (event) => event.type === "tool_call_delta",
  );
  assert.equal(toolCallDeltas.length, 2);
  assert.equal(toolCallDeltas[0]?.toolCallId, toolCallDeltas[1]?.toolCallId);
});

test("parseModelsResponse dedupes and sorts model IDs with localeCompare", () => {
  const models = parseModelsResponse({
    data: [{ id: "gpt-4o" }, { id: "gpt-3.5" }, { id: "gpt-4o" }],
  });
  assert.deepEqual(models, ["gpt-3.5", "gpt-4o"]);
});

test("parseModelsResponse throws on an invalid shape", () => {
  assert.throws(() => parseModelsResponse({}), /invalid \/models response/);
  assert.throws(() => parseModelsResponse(null), /invalid \/models response/);
});

test("endpoints that dial the same URL are the same target", () => {
  // A base URL and the request URL the transport would build from it. Reported
  // as a mismatch by a string compare, with nothing the user could fix.
  assert.equal(
    sameChatCompletionsTarget(
      "https://openrouter.ai/api/v1",
      "https://openrouter.ai/api/v1/chat/completions",
    ),
    true,
  );
  assert.equal(
    sameChatCompletionsTarget(
      "http://127.0.0.1:8080/v1/",
      "http://127.0.0.1:8080/v1",
    ),
    true,
  );
  assert.equal(
    sameChatCompletionsTarget(
      "https://API.OpenAI.com/v1",
      "https://api.openai.com/v1",
    ),
    true,
  );
});

test("endpoints that dial elsewhere are not the same target", () => {
  assert.equal(
    sameChatCompletionsTarget(
      "http://127.0.0.1:8080/v1",
      "https://openrouter.ai/api/v1",
    ),
    false,
  );
  // Same host, different port: the local-fixture case that must stay visible.
  assert.equal(
    sameChatCompletionsTarget(
      "http://127.0.0.1:8080/v1",
      "http://127.0.0.1:44014/v1",
    ),
    false,
  );
  assert.equal(
    sameChatCompletionsTarget(
      "http://127.0.0.1:8080/v1",
      "https://127.0.0.1:8080/v1",
    ),
    false,
  );
});

test("an unparseable endpoint falls back to comparing the text", () => {
  assert.equal(sameChatCompletionsTarget("not a url", " not a url "), true);
  assert.equal(sameChatCompletionsTarget("not a url", "also not a url"), false);
  assert.equal(
    sameChatCompletionsTarget("", "https://openrouter.ai/api/v1"),
    false,
  );
});

test("captures all visible provider headers while redacting sensitive values", () => {
  assert.deepEqual(
    redactedProviderHeaders(
      new Headers({
        "x-request-id": "request-1",
        "set-cookie": "session=secret",
        "x-api-key": "secret",
        "x-vendor-api-key": "also-secret",
      }),
    ),
    {
      "set-cookie": "••••••••",
      "x-api-key": "••••••••",
      "x-vendor-api-key": "••••••••",
      "x-request-id": "request-1",
    },
  );
});

test("redacts credentials embedded in provider URLs", () => {
  assert.equal(
    redactedProviderUrl(
      "https://user:password@example.com/v1/chat/completions?api_key=secret&region=us",
    ),
    "https://%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2:%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2@example.com/v1/chat/completions?api_key=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2&region=us",
  );
});
