import assert from "node:assert/strict";
import test from "node:test";
import {
  EnvironmentCredentialStore,
  executeProviderTurn,
  resolveModelDiscoveryRequest,
  resolveProviderTurnRequest,
  validateWorkbenchRequest,
  WorkbenchRequestError,
} from "../services/api/src/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const environmentStore = new EnvironmentCredentialStore({
  TRACE_LENS_API_KEY: "environment-key",
  TRACE_LENS_API_ENDPOINT: "https://api.example.test/v1",
});

function execution(capabilities = OPENAI_COMPATIBLE_CAPABILITIES) {
  return {
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
        capabilities,
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
  };
}

test("resolves a server-owned credential for one provider turn", () => {
  const request = resolveProviderTurnRequest(
    {
      execution: execution(),
      credential: { kind: "environment-default" },
    },
    environmentStore,
  );

  assert.equal(request.apiKey, "environment-key");
  assert.equal(request.execution.input.target.model, "example-model");
});

test("allows a session-only caller-provided credential", () => {
  const request = resolveModelDiscoveryRequest(
    {
      endpoint: "https://api.example.test/v1",
      credential: { kind: "provided", apiKey: "session-key" },
    },
    environmentStore,
  );

  assert.deepEqual(request, {
    endpoint: "https://api.example.test/v1",
    apiKey: "session-key",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  });
});

test("allows an explicit no-credential selection", () => {
  const request = resolveProviderTurnRequest(
    {
      execution: execution(),
      credential: { kind: "none" },
    },
    environmentStore,
  );
  assert.equal(request.apiKey, "");
});

test("rejects incomplete capability snapshots at the API boundary", () => {
  assert.throws(
    () =>
      resolveProviderTurnRequest(
        {
          execution: execution({ streaming: true } as never),
          credential: { kind: "provided", apiKey: "session-key" },
        },
        environmentStore,
      ),
    /Capabilities must contain only known boolean values/,
  );
});

test("fails clearly when no environment credential is configured", () => {
  assert.throws(
    () =>
      resolveModelDiscoveryRequest(
        {
          endpoint: "https://api.example.test/v1",
          credential: { kind: "environment-default" },
        },
        new EnvironmentCredentialStore({}),
      ),
    /TRACE_LENS_API_KEY/,
  );
});

test("requires an endpoint binding for the environment credential", () => {
  assert.throws(
    () =>
      resolveModelDiscoveryRequest(
        {
          endpoint: "https://api.example.test/v1",
          credential: { kind: "environment-default" },
        },
        new EnvironmentCredentialStore({
          TRACE_LENS_API_KEY: "environment-key",
        }),
      ),
    /TRACE_LENS_API_ENDPOINT/,
  );
});

test("rejects redirecting the environment credential to another origin", () => {
  assert.throws(
    () =>
      resolveModelDiscoveryRequest(
        {
          endpoint: "https://attacker.example/v1",
          credential: { kind: "environment-default" },
        },
        environmentStore,
      ),
    /cannot be sent to https:\/\/attacker\.example/,
  );
});

test("accepts same-origin JSON API requests", () => {
  assert.doesNotThrow(() =>
    validateWorkbenchRequest(
      new Request("http://127.0.0.1:3000/api/models", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          origin: "http://127.0.0.1:3000",
        },
      }),
    ),
  );
});

test("rejects simple or cross-origin browser requests", () => {
  assert.throws(
    () =>
      validateWorkbenchRequest(
        new Request("http://127.0.0.1:3000/api/models", {
          method: "POST",
          headers: { "content-type": "text/plain" },
        }),
      ),
    (error) =>
      error instanceof WorkbenchRequestError && error.status === 415,
  );
  assert.throws(
    () =>
      validateWorkbenchRequest(
        new Request("http://127.0.0.1:3000/api/models", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://attacker.example",
          },
        }),
      ),
    (error) =>
      error instanceof WorkbenchRequestError && error.status === 403,
  );
});

test("executes one normalized provider turn outside an HTTP handler", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      [
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" } },
    );

  try {
    const eventTypes: string[] = [];
    for await (const event of executeProviderTurn(
      execution(),
      "test-key",
    )) {
      eventTypes.push(event.type);
    }
    assert.deepEqual(eventTypes, [
      "request",
      "response_started",
      "frame",
      "text_delta",
      "frame",
      "completed",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
