import assert from "node:assert/strict";
import test from "node:test";
import { HttpInferenceTransport } from "../app/http-inference-transport.client.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const request = {
  execution: {
    runId: "run_test" as const,
    turnId: "turn_test" as const,
    attempt: 1 as const,
    exchangeId: "exchange_test" as const,
    input: {
      target: {
        profileId: "profile_test" as const,
        protocol: "openai-compatible-chat-completions" as const,
        endpoint: "https://api.example.test/v1",
        model: "example-model",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      messages: [
        {
          id: "message_test" as const,
          role: "user" as const,
          content: [{ type: "text" as const, text: "Hello" }],
        },
      ],
      options: {},
      tools: [],
    },
  },
  credential: { kind: "environment-default" as const },
};

test("fails an incomplete provider stream instead of treating EOF as success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(`${JSON.stringify({ type: "request", request: {} })}\n`, {
      headers: { "content-type": "application/x-ndjson" },
    });

  try {
    const stream = await new HttpInferenceTransport().executeTurn(request);
    const receivedEventTypes: string[] = [];
    await assert.rejects(
      async () => {
        for await (const event of stream.events) {
          receivedEventTypes.push(event.type);
        }
      },
      /provider turn reached a terminal state/,
    );
    assert.deepEqual(receivedEventTypes, ["request"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts assistant completion as the provider-turn terminal event", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      [
        JSON.stringify({
          type: "completed",
          finishReason: { normalized: "stop" },
        }),
        "",
      ].join("\n"),
      { headers: { "content-type": "application/x-ndjson" } },
    );

  try {
    const stream = await new HttpInferenceTransport().executeTurn(request);
    const receivedEventTypes: string[] = [];
    for await (const event of stream.events) receivedEventTypes.push(event.type);
    assert.deepEqual(receivedEventTypes, ["completed"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts a normalized host failure as terminal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      `${JSON.stringify({
        type: "failed",
        error: { code: "transport_error", message: "offline" },
      })}\n`,
      { headers: { "content-type": "application/x-ndjson" } },
    );

  try {
    const stream = await new HttpInferenceTransport().executeTurn(request);
    const received = [];
    for await (const event of stream.events) received.push(event);
    assert.equal(received[0]?.type, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
