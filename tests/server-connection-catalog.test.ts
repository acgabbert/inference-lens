import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SERVER_CONNECTION_ID,
  isServerConnectionId,
  parseServerConnectionCatalog,
  ServerConnectionCatalogError,
} from "../packages/core/src/server-connection-catalog.ts";

function catalog(connections: unknown[]): unknown {
  return { schemaVersion: 1, connections };
}

test("a minimal connection needs no key and is named after its id", () => {
  const parsed = parseServerConnectionCatalog(
    catalog([{ id: "local", endpoint: "http://host.docker.internal:8080/v1" }]),
  );

  assert.deepEqual(parsed.connections, [
    {
      id: "local",
      name: "local",
      endpoint: "http://host.docker.internal:8080/v1",
      key: { kind: "none" },
    },
  ]);
});

test("declared values survive parsing, in catalog order", () => {
  const parsed = parseServerConnectionCatalog(
    catalog([
      {
        id: "chat",
        name: "Chat gateway",
        endpoint: "https://openrouter.ai/api/v1/",
        model: "google/gemma-4",
        protocols: ["chat-completions", "responses"],
        apiKeyFile: "openrouter.key",
      },
      {
        id: "decide",
        endpoint: "https://decide.example.test/v1",
        protocols: ["systemone"],
        apiKeyEnv: "DECIDE_KEY",
      },
    ]),
  );

  assert.deepEqual(parsed.connections, [
    {
      id: "chat",
      name: "Chat gateway",
      // A trailing slash is the same base URL; keeping it would double the
      // separator when a path is appended.
      endpoint: "https://openrouter.ai/api/v1",
      model: "google/gemma-4",
      protocols: ["chat-completions", "responses"],
      key: { kind: "file", path: "openrouter.key" },
    },
    {
      id: "decide",
      name: "decide",
      endpoint: "https://decide.example.test/v1",
      protocols: ["systemone"],
      key: { kind: "environment", variable: "DECIDE_KEY" },
    },
  ]);
});

test("protocol names are kept as written, so one connection's typo is its own", () => {
  // Decision 3: an unrecognized name is a per-connection problem reported by
  // the store, not a structural one that refuses every connection.
  const parsed = parseServerConnectionCatalog(
    catalog([{ id: "a", endpoint: "https://a.test/v1", protocols: ["assistants"] }]),
  );
  assert.deepEqual(parsed.connections[0].protocols, ["assistants"]);
});

function refusal(value: unknown): string {
  try {
    parseServerConnectionCatalog(value);
  } catch (error) {
    assert.ok(error instanceof ServerConnectionCatalogError);
    return error.message;
  }
  assert.fail("The catalog was accepted.");
}

test("structural problems refuse the whole catalog", () => {
  assert.match(refusal({ schemaVersion: 2, connections: [] }), /schemaVersion/);
  assert.match(refusal({ connections: [] }), /schemaVersion/);
  assert.match(refusal(catalog([{ id: "Chat", endpoint: "https://a.test" }])), /connections\.0\.id/);
  assert.match(refusal(catalog([{ id: "-chat", endpoint: "https://a.test" }])), /connections\.0\.id/);
  assert.match(
    refusal(
      catalog([
        { id: "chat", endpoint: "https://a.test" },
        { id: "chat", endpoint: "https://b.test" },
      ]),
    ),
    /Duplicate connection id "chat"/,
  );
  assert.match(refusal(catalog([{ id: "x", endpoint: "https://a.test", apiKey: "sk-1" }])), /apiKey/);
  assert.match(
    refusal(catalog([{ id: "x", endpoint: "https://a.test", apiKeyFile: "k", apiKeyEnv: "K" }])),
    /apiKeyFile or apiKeyEnv, not both/,
  );
  assert.match(refusal(catalog([{ id: "x" }])), /endpoint/);
});

test("the legacy variables own the default id", () => {
  assert.equal(DEFAULT_SERVER_CONNECTION_ID, "default");
  assert.match(
    refusal(catalog([{ id: "default", endpoint: "https://a.test" }])),
    /"default" is reserved for INFERENCE_LENS_API_ENDPOINT/,
  );
});

test("an endpoint must be a plain HTTP or HTTPS base URL", () => {
  for (const endpoint of [
    "not a url",
    "file:///tmp/provider",
    "https://name:secret@a.test/v1",
    "https://a.test/v1?key=secret",
    "https://a.test/v1#fragment",
  ]) {
    const message = refusal(catalog([{ id: "x", endpoint }]));
    assert.match(message, /connections\.0\.endpoint/, endpoint);
    // The refusal names the rule, never the value, which may hold a secret.
    assert.doesNotMatch(message, /secret/, endpoint);
  }
});

test("connection ids are recognized for the request contract", () => {
  assert.equal(isServerConnectionId("decide"), true);
  assert.equal(isServerConnectionId("default"), true);
  assert.equal(isServerConnectionId("a-2"), true);
  assert.equal(isServerConnectionId("Decide"), false);
  assert.equal(isServerConnectionId("../x"), false);
  assert.equal(isServerConnectionId("a".repeat(64)), false);
  assert.equal(isServerConnectionId(3), false);
});
