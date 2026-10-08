import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResponsesRequest,
  normalizeResponsesResponse,
  normalizeResponsesStream,
} from "../packages/core/src/openai-responses.ts";
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
const callId = createEntityId("tool-call", "weather");

const capabilities = { ...OPENAI_COMPATIBLE_CAPABILITIES, responsesApi: true, tools: true };

const turnInput: ProviderTurnInput = {
  target: {
    profileId: createEntityId("profile", "openai"),
    protocol: "openai-responses",
    endpoint: "https://api.example.com/v1",
    model: "example-model",
    capabilities,
  },
  messages: [
    { id: createEntityId("message", "system"), role: "system", content: [{ type: "text", text: "Be brief." }] },
    { id: createEntityId("message", "user"), role: "user", content: [{ type: "text", text: "Weather?" }] },
    {
      id: createEntityId("message", "assistant"),
      role: "assistant",
      content: [{ type: "text", text: "Checking." }],
      toolCalls: [{
        id: callId,
        providerCallId: "call_abc",
        name: "get_weather",
        arguments: { text: '{"city":"Chicago"}' },
      }],
    },
    {
      id: createEntityId("message", "tool"),
      role: "tool",
      toolCallId: callId,
      name: "get_weather",
      content: [{ type: "text", text: "Sunny" }],
    },
  ],
  responseMode: "streaming",
  options: { temperature: 0.2, maxOutputTokens: 300, providerOptions: { reasoning: { effort: "low" } } },
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

/** Drops each event's `source`, which only repeats the frame it came from. */
function withoutSource(event: ProviderEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([key]) => key !== "source"));
}

async function* lines(values: string[]): AsyncGenerator<string> {
  yield* values;
}

/** Writes each event the way the Responses API does: an event line, then data. */
function sse(...events: object[]): string[] {
  return events.flatMap((event) => [
    `event: ${(event as { type: string }).type}`,
    `data: ${JSON.stringify(event)}`,
    "",
  ]);
}

test("a Responses request carries the conversation as stateless input items", () => {
  const { url, body } = buildResponsesRequest(execution());
  assert.equal(url, "https://api.example.com/v1/responses");
  assert.deepEqual(body, {
    model: "example-model",
    input: [
      { type: "message", role: "system", content: "Be brief." },
      { type: "message", role: "user", content: "Weather?" },
      { type: "message", role: "assistant", content: "Checking." },
      { type: "function_call", call_id: "call_abc", name: "get_weather", arguments: '{"city":"Chicago"}' },
      { type: "function_call_output", call_id: "call_abc", output: "Sunny" },
    ],
    temperature: 0.2,
    max_output_tokens: 300,
    tools: [{
      type: "function",
      strict: false,
      name: "get_weather",
      description: "Look up weather.",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    }],
    store: false,
    reasoning: { effort: "low" },
    stream: true,
  });
});

test("a tool's own provider options can opt into strict schemas", () => {
  const [tool] = turnInput.tools;
  const { body } = buildResponsesRequest(execution({
    tools: [{ ...tool!, providerOptions: { strict: true } }],
  }));
  assert.equal((body.tools as Array<{ strict: boolean }>)[0]!.strict, true);
});

test("delivery mode cannot be contradicted by provider options", () => {
  const { body } = buildResponsesRequest(execution({
    responseMode: "buffered",
    options: { providerOptions: { stream: true, store: true } },
  }));
  assert.equal(body.stream, false);
  // Retention is the author's to choose; the default is to keep nothing.
  assert.equal(body.store, true);
});

test("options the Responses API cannot express are refused rather than dropped", () => {
  assert.throws(
    () => buildResponsesRequest(execution({ options: { seed: 7 } })),
    /Responses API does not accept a seed/,
  );
  assert.throws(
    () => buildResponsesRequest(execution({ options: { stop: ["END"] } })),
    /Responses API does not accept stop sequences/,
  );
  assert.throws(
    () => buildResponsesRequest(execution({
      target: { ...turnInput.target, capabilities: OPENAI_COMPATIBLE_CAPABILITIES },
    })),
    /Responses API is not supported by this profile/,
  );
});

test("a streamed response normalizes text, reasoning, a tool call, and usage", async () => {
  const events = await collect(normalizeResponsesStream(execution(), lines(sse(
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Need the " },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "forecast." },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "Let me " },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "check." },
    { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_xyz", name: "get_weather", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: '{"city":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: '"Paris"}' },
    { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_xyz", name: "get_weather", arguments: '{"city":"Paris"}' } },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [{ type: "function_call", id: "fc_1", call_id: "call_xyz", name: "get_weather", arguments: '{"city":"Paris"}' }],
        usage: {
          input_tokens: 40,
          input_tokens_details: { cached_tokens: 8 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 60,
        },
      },
    },
  ))));

  // Every data line is a frame; event lines and blank separators are not.
  const frames = events.filter((event) => event.type === "frame");
  assert.equal(frames.length, 12);
  assert.ok(frames.every((event) => event.type === "frame" && event.frame.raw.startsWith("data: ")));

  const semantic = events.filter((event) => event.type !== "frame").map(withoutSource);
  const toolCallId = createEntityId("tool-call", `${exchangeId}-0`);
  assert.deepEqual(semantic, [
    { type: "reasoning_delta", reasoning: "Need the " },
    { type: "reasoning_delta", reasoning: "forecast." },
    { type: "text_delta", text: "Let me " },
    { type: "text_delta", text: "check." },
    { type: "tool_call_delta", toolCallId, index: 0, providerCallId: "call_xyz", nameDelta: "get_weather", argumentsDelta: "" },
    { type: "tool_call_delta", toolCallId, index: 0, argumentsDelta: '{"city":' },
    { type: "tool_call_delta", toolCallId, index: 0, argumentsDelta: '"Paris"}' },
    {
      type: "usage",
      usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, cachedInputTokens: 8, reasoningTokens: 12 },
    },
    { type: "completed", finishReason: { normalized: "tool_calls", raw: "completed" } },
  ]);
});

test("a function call reported only when done still reaches the run", async () => {
  const events = await collect(normalizeResponsesStream(execution(), lines(sse(
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_9", call_id: "call_9", name: "get_weather", arguments: "{}" } },
    { type: "response.completed", response: { status: "completed", output: [] } },
  ))));
  const calls = events.filter((event) => event.type === "tool_call_delta");
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { ...calls[0], source: undefined },
    {
      type: "tool_call_delta",
      toolCallId: createEntityId("tool-call", `${exchangeId}-0`),
      index: 0,
      providerCallId: "call_9",
      nameDelta: "get_weather",
      argumentsDelta: "{}",
      source: undefined,
    },
  );
});

test("an incomplete response ends the turn with the reason it stopped", async () => {
  const events = await collect(normalizeResponsesStream(execution(), lines(sse(
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Partial" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ))));
  const completed = events.find((event) => event.type === "completed");
  assert.deepEqual(completed && "finishReason" in completed ? completed.finishReason : undefined, {
    normalized: "length",
    raw: "max_output_tokens",
  });
});

test("a refusal is shown as the answer and ends as filtered content", async () => {
  const events = await collect(normalizeResponsesStream(execution(), lines(sse(
    { type: "response.refusal.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "I can't help with that." },
    { type: "response.completed", response: { status: "completed", output: [] } },
  ))));
  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" && event.text),
    ["I can't help with that."],
  );
  const completed = events.find((event) => event.type === "completed");
  assert.deepEqual(completed && "finishReason" in completed ? completed.finishReason : undefined, {
    normalized: "content_filter",
    raw: "refusal",
  });
});

test("a failure the provider reports mid-stream is a provider error, not a protocol one", async () => {
  await assert.rejects(
    collect(normalizeResponsesStream(execution(), lines(sse(
      { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "The model crashed." } } },
    )))),
    (error: unknown) =>
      error instanceof ProviderReportedError &&
      !(error instanceof ProviderProtocolError) &&
      /server_error: The model crashed\./.test(error.message),
  );
  await assert.rejects(
    collect(normalizeResponsesStream(execution(), lines(sse(
      { type: "error", code: "rate_limit_exceeded", message: "Slow down." },
    )))),
    (error: unknown) => error instanceof ProviderReportedError && /Slow down/.test(error.message),
  );
});

test("a stream that ends without a terminal event is a protocol error", async () => {
  await assert.rejects(
    collect(normalizeResponsesStream(execution(), lines(sse(
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Cut" },
    )))),
    (error: unknown) =>
      error instanceof ProviderProtocolError &&
      /ended before response\.completed/.test(error.message),
  );
});

test("a buffered response yields the same events from its output items", async () => {
  const raw = JSON.stringify({
    id: "resp_2",
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Short thought." }] },
      { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello " }, { type: "output_text", text: "there." }] },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{}" },
    ],
    usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
  });
  const events = await collect(normalizeResponsesResponse(execution({ responseMode: "buffered" }), raw));
  assert.deepEqual(events[0], { type: "frame", frame: { index: 0, raw } });
  const semantic = events.slice(1).map(withoutSource);
  assert.deepEqual(semantic, [
    { type: "reasoning_delta", reasoning: "Short thought." },
    { type: "text_delta", text: "Hello there." },
    {
      type: "tool_call_delta",
      toolCallId: createEntityId("tool-call", `${exchangeId}-0`),
      index: 0,
      providerCallId: "call_1",
      nameDelta: "get_weather",
      argumentsDelta: "{}",
    },
    { type: "usage", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } },
    { type: "completed", finishReason: { normalized: "tool_calls", raw: "completed" } },
  ]);
  await assert.rejects(
    collect(normalizeResponsesResponse(execution(), "{not json")),
    ProviderProtocolError,
  );
  await assert.rejects(
    collect(normalizeResponsesResponse(execution(), JSON.stringify({ status: "failed", error: { message: "Nope." } }))),
    (error: unknown) => error instanceof ProviderReportedError && /Nope\./.test(error.message),
  );
});

test("the adapter registry serves Responses", () => {
  assert.equal(providerProtocolAdapter("openai-responses").protocol, "openai-responses");
});
