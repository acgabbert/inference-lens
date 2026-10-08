import assert from "node:assert/strict";
import test from "node:test";
import {
  EnvironmentCredentialStore,
  executeProviderTurn,
  parseAllowedHosts,
  resolveModelDiscoveryRequest,
  resolveProviderTurnRequest,
  validateSameOrigin,
  validateWorkbenchRequest,
  WorkbenchRequestError,
} from "../services/api/src/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const environmentStore = new EnvironmentCredentialStore({
  INFERENCE_LENS_API_KEY: "environment-key",
  INFERENCE_LENS_API_ENDPOINT: "https://api.example.test/v1",
});

function execution(
  capabilities = OPENAI_COMPATIBLE_CAPABILITIES,
  responseMode: "streaming" | "buffered" = "streaming",
) {
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
      responseMode,
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

test("reports only whether a server-owned credential is configured", () => {
  assert.equal(environmentStore.isConfigured(), true);
  assert.equal(new EnvironmentCredentialStore({}).isConfigured(), false);
  assert.equal(
    new EnvironmentCredentialStore({
      INFERENCE_LENS_API_KEY: "environment-key",
    }).isConfigured(),
    false,
  );
});

test("exposes sanitized non-secret server connection metadata", () => {
  const store = new EnvironmentCredentialStore({
    INFERENCE_LENS_API_KEY: "environment-key",
    INFERENCE_LENS_API_ENDPOINT: "https://name:secret@example.test/v1?key=secret",
    INFERENCE_LENS_MODEL: "configured-model",
  });
  assert.deepEqual(store.connectionConfiguration(), {
    endpoint: "https://example.test/v1",
    model: "configured-model",
  });
});

test("does not expose or advertise an invalid server endpoint", () => {
  const malformed = new EnvironmentCredentialStore({
    INFERENCE_LENS_API_KEY: "environment-key",
    INFERENCE_LENS_API_ENDPOINT: "not a url?api_key=must-not-leak",
  });
  assert.equal(malformed.isConfigured(), false);
  assert.equal(malformed.connectionConfiguration(), undefined);

  const unsupported = new EnvironmentCredentialStore({
    INFERENCE_LENS_API_KEY: "environment-key",
    INFERENCE_LENS_API_ENDPOINT: "file:///tmp/provider?api_key=must-not-leak",
  });
  assert.equal(unsupported.isConfigured(), false);
  assert.equal(unsupported.connectionConfiguration(), undefined);
});

test("prefills a keyless local provider from its endpoint alone", () => {
  // A llama.cpp server needs no credential, so the endpoint is worth adopting
  // on its own; the missing key is reported separately rather than suppressing
  // the whole configuration.
  const store = new EnvironmentCredentialStore({
    INFERENCE_LENS_API_ENDPOINT: "http://host.docker.internal:8080/v1",
  });
  assert.equal(store.isConfigured(), false);
  assert.deepEqual(store.connectionConfiguration(), {
    endpoint: "http://host.docker.internal:8080/v1",
  });
});

test("reports no connection when the server declares no endpoint", () => {
  assert.equal(
    new EnvironmentCredentialStore({
      INFERENCE_LENS_API_KEY: "environment-key",
    }).connectionConfiguration(),
    undefined,
  );
  assert.equal(
    new EnvironmentCredentialStore({}).connectionConfiguration(),
    undefined,
  );
});

test("reads the model from the injected variable name", () => {
  const store = new EnvironmentCredentialStore(
    { API_ENDPOINT: "https://example.test/v1", MODEL: "renamed-model" },
    "API_KEY",
    "API_ENDPOINT",
    "MODEL",
  );
  assert.deepEqual(store.connectionConfiguration(), {
    endpoint: "https://example.test/v1",
    model: "renamed-model",
  });
});

test("refuses a cross-origin caller on a route with no request body", () => {
  const sameOrigin = new Request("http://localhost:3000/api/runtime-status", {
    headers: { origin: "http://localhost:3000" },
  });
  assert.doesNotThrow(() => validateSameOrigin(sameOrigin));

  // A direct navigation or curl sends no Origin at all and stays allowed.
  assert.doesNotThrow(() =>
    validateSameOrigin(new Request("http://localhost:3000/api/runtime-status")),
  );

  const crossOrigin = new Request("http://localhost:3000/api/runtime-status", {
    headers: { origin: "https://attacker.test" },
  });
  assert.throws(() => validateSameOrigin(crossOrigin), (error: unknown) => {
    assert.ok(error instanceof WorkbenchRequestError);
    assert.equal(error.status, 403);
    return true;
  });
});

test("refuses a Host a rebound DNS name could have produced", () => {
  // The whole point: under DNS rebinding the browser believes this request is
  // same-origin, so Origin agrees with the URL the server reconstructs from
  // this very header. Only the name itself gives the attack away.
  const rebound = new Request("http://evil.test:3000/api/inference", {
    headers: { host: "evil.test:3000", origin: "http://evil.test:3000" },
  });
  assert.throws(() => validateSameOrigin(rebound), (error: unknown) => {
    assert.ok(error instanceof WorkbenchRequestError);
    assert.equal(error.status, 403);
    assert.match(error.message, /INFERENCE_LENS_ALLOWED_HOSTS/);
    return true;
  });

  // An operator who put the service behind a name says so, and it is served.
  assert.doesNotThrow(() =>
    validateSameOrigin(rebound, { allowedHosts: ["evil.test"] }),
  );
});

test("serves every address literal a local workbench is opened on", () => {
  for (const host of [
    "localhost:3000",
    "127.0.0.1:3000",
    "0.0.0.0:3000",
    "[::1]:3000",
    "192.168.1.10:3000",
    "lens.localhost:3000",
  ]) {
    assert.doesNotThrow(
      () =>
        validateSameOrigin(
          new Request("http://placeholder.invalid/api/runtime-status", {
            headers: { host },
          }),
        ),
      host,
    );
  }
});

test("parses an operator's allowlist from either separator", () => {
  assert.deepEqual(
    parseAllowedHosts("lens.example.com, workbench.internal:8443\nother.test"),
    ["lens.example.com", "workbench.internal", "other.test"],
  );
  assert.deepEqual(parseAllowedHosts(undefined), []);
});

test("accepts a retry attempt at the stateless provider boundary", () => {
  const retry = {
    ...execution(),
    attempt: 2,
    exchangeId: "exchange_test-2" as const,
  };
  const request = resolveProviderTurnRequest(
    {
      execution: retry,
      credential: { kind: "environment-default" },
    },
    environmentStore,
  );

  assert.equal(request.execution.attempt, 2);
  assert.equal(request.execution.exchangeId, "exchange_test-2");
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
    /INFERENCE_LENS_API_KEY/,
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
          INFERENCE_LENS_API_KEY: "environment-key",
        }),
      ),
    /INFERENCE_LENS_API_ENDPOINT/,
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
      "frame",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("executes a buffered provider turn through the shared service boundary", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.stream, false);
    assert.equal("stream_options" in body, false);
    return Response.json({
      choices: [{
        message: { role: "assistant", content: "Buffered hello" },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 2,
        total_tokens: 4,
      },
    });
  };

  try {
    const buffered = execution(OPENAI_COMPATIBLE_CAPABILITIES, "buffered");
    const events = [];
    for await (const event of executeProviderTurn(buffered, "secret")) {
      events.push(event);
    }
    assert.deepEqual(events.map(({ type }) => type), [
      "request",
      "response_started",
      "frame",
      "text_delta",
      "usage",
      "completed",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("marks transient provider failures as retryable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Temporarily unavailable.", { status: 503 });

  try {
    const events = [];
    for await (const event of executeProviderTurn(execution(), "test-key")) {
      events.push(event);
    }
    const failure = events.at(-1);
    assert.equal(failure?.type, "failed");
    if (failure?.type === "failed") {
      assert.equal(failure.error.providerStatus, 503);
      assert.equal(failure.error.retryable, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps authentication failures non-retryable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Invalid API key.", { status: 401 });

  try {
    const events = [];
    for await (const event of executeProviderTurn(execution(), "test-key")) {
      events.push(event);
    }
    const failure = events.at(-1);
    assert.equal(failure?.type, "failed");
    if (failure?.type === "failed") {
      assert.equal(failure.error.providerStatus, 401);
      assert.equal(failure.error.retryable, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts every wire protocol at the provider-turn boundary and nothing else", () => {
  for (const protocol of [
    "openai-compatible-chat-completions",
    "openai-responses",
    "anthropic-messages",
  ] as const) {
    const base = execution();
    const request = resolveProviderTurnRequest(
      {
        execution: { ...base, input: { ...base.input, target: { ...base.input.target, protocol } } },
        credential: { kind: "provided", apiKey: "session-key" },
      },
      environmentStore,
    );
    assert.equal(request.execution.input.target.protocol, protocol);
  }
  for (const protocol of ["mock", "openai-assistants", undefined]) {
    const base = execution();
    assert.throws(
      () =>
        resolveProviderTurnRequest(
          {
            execution: { ...base, input: { ...base.input, target: { ...base.input.target, protocol } } },
            credential: { kind: "provided", apiKey: "session-key" },
          },
          environmentStore,
        ),
      /Protocol must be chat completions, Responses, or Anthropic Messages/,
    );
  }
});

test("model discovery carries the protocol that decides its credential header", () => {
  const request = resolveModelDiscoveryRequest(
    {
      endpoint: "https://api.example.test/v1",
      protocol: "anthropic-messages",
      credential: { kind: "provided", apiKey: "session-key" },
    },
    environmentStore,
  );
  assert.equal(request.protocol, "anthropic-messages");
  assert.throws(
    () =>
      resolveModelDiscoveryRequest(
        {
          endpoint: "https://api.example.test/v1",
          protocol: "mock",
          credential: { kind: "provided", apiKey: "session-key" },
        },
        environmentStore,
      ),
    /Protocol must be/,
  );
});

test("the server states which protocols its default connection speaks", () => {
  const store = new EnvironmentCredentialStore({
    INFERENCE_LENS_API_ENDPOINT: "https://api.anthropic.com/v1",
    INFERENCE_LENS_API_PROTOCOLS: " anthropic-messages , chat-completions,responses ",
  });
  assert.deepEqual(store.connectionConfiguration(), {
    endpoint: "https://api.anthropic.com/v1",
    protocols: [
      "openai-compatible-chat-completions",
      "openai-responses",
      "anthropic-messages",
    ],
  });
});

test("an unrecognized server protocol list is ignored rather than half-applied", () => {
  const store = new EnvironmentCredentialStore({
    INFERENCE_LENS_API_ENDPOINT: "https://api.example.test/v1",
    INFERENCE_LENS_API_PROTOCOLS: "responses,assistants",
  });
  assert.deepEqual(store.connectionConfiguration(), {
    endpoint: "https://api.example.test/v1",
  });
});

test("a Responses turn is sent to /responses and a reported failure is a provider error", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input, init) => {
    requested.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.ok(Array.isArray(body.input));
    assert.equal("messages" in body, false);
    return new Response(
      [
        "event: response.failed",
        `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "The model crashed." } } })}`,
        "",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const base = execution({ ...OPENAI_COMPATIBLE_CAPABILITIES, responsesApi: true });
    const events = [];
    for await (const event of executeProviderTurn(
      { ...base, input: { ...base.input, target: { ...base.input.target, protocol: "openai-responses" as const } } },
      "test-key",
    )) {
      events.push(event);
    }
    assert.deepEqual(requested, ["https://api.example.test/v1/responses"]);
    const failed = events.at(-1);
    assert.deepEqual(failed, {
      type: "failed",
      error: {
        code: "provider_error",
        message: "server_error: The model crashed.",
        retryable: false,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an Anthropic turn presents its key as x-api-key and records it masked", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.example.test/v1/messages");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "test-key");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.get("authorization"), null);
    return Response.json({
      type: "message",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  };
  try {
    const base = execution(
      { ...OPENAI_COMPATIBLE_CAPABILITIES, chatCompletions: false, anthropicMessages: true },
      "buffered",
    );
    const events = [];
    for await (const event of executeProviderTurn(
      { ...base, input: { ...base.input, target: { ...base.input.target, protocol: "anthropic-messages" as const } } },
      "test-key",
    )) {
      events.push(event);
    }
    const request = events.find((event) => event.type === "request");
    assert.deepEqual(request && "request" in request ? request.request.headers : undefined, {
      "x-api-key": "••••••••",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    });
    assert.equal(events.at(-1)?.type, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic model discovery sends its key as x-api-key and asks for the whole catalogue", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.example.test/v1/models?limit=1000");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "test-key");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    return Response.json({ data: [{ id: "claude-opus-5-5", type: "model" }], has_more: false });
  };
  try {
    const { discoverOpenAICompatibleModels } = await import("../packages/core/src/openai-compatible.ts");
    assert.deepEqual(
      await discoverOpenAICompatibleModels({
        endpoint: "https://api.example.test/v1",
        apiKey: "test-key",
        protocol: "anthropic-messages",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      }),
      ["claude-opus-5-5"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
