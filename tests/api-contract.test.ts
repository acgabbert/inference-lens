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
