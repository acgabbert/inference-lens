import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveModelDiscoveryRequest,
  ServerConnectionStore,
} from "../services/api/src/index.ts";

/** A filesystem of exactly these files; anything else is unreadable. */
function files(contents: Record<string, string>) {
  return (path: string): string => {
    if (!Object.hasOwn(contents, path)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return contents[path];
  };
}

const twoGateways = JSON.stringify({
  schemaVersion: 1,
  connections: [
    {
      id: "chat",
      name: "Chat gateway",
      endpoint: "https://chat.example.test/v1",
      protocols: ["chat-completions", "responses"],
      apiKeyFile: "chat.key",
    },
    {
      id: "decide",
      name: "Decision models",
      endpoint: "https://decide.example.test/v1",
      model: "local-decision",
      protocols: ["systemone"],
      apiKeyFile: "/secrets/decide.key",
    },
  ],
});

function gatewayStore(environment: Record<string, string | undefined> = {}) {
  const contents: Record<string, string> = {
    "/config/connections.json": twoGateways,
    "/config/chat.key": "chat-key\n",
    "/secrets/decide.key": "  decide-key\n",
  };
  return {
    contents,
    store: new ServerConnectionStore(
      { INFERENCE_LENS_CONNECTIONS: "/config/connections.json", ...environment },
      { readFile: files(contents) },
    ),
  };
}

function discover(
  store: ServerConnectionStore,
  endpoint: string,
  credential: unknown,
): string {
  return resolveModelDiscoveryRequest(
    { endpoint, credential } as never,
    store,
  ).apiKey;
}

test("without a catalog the only connection is the legacy default, unchanged", () => {
  const store = new ServerConnectionStore(
    {
      INFERENCE_LENS_API_KEY: "environment-key",
      INFERENCE_LENS_API_ENDPOINT: "https://api.example.test/v1",
      INFERENCE_LENS_MODEL: "configured-model",
    },
    { readFile: files({}) },
  );

  assert.deepEqual(store.report(), {
    connections: [
      {
        id: "default",
        name: "Server default",
        endpoint: "https://api.example.test/v1",
        model: "configured-model",
        credentialConfigured: true,
      },
    ],
    diagnostics: [],
  });
  assert.equal(
    discover(store, "https://api.example.test/v1", { kind: "environment-default" }),
    "environment-key",
  );
  assert.equal(
    discover(store, "https://api.example.test/v1", {
      kind: "environment-default",
      connectionId: "default",
    }),
    "environment-key",
  );
});

test("nothing configured reports no connections", () => {
  assert.deepEqual(new ServerConnectionStore({}, { readFile: files({}) }).report(), {
    connections: [],
    diagnostics: [],
  });
});

test("catalog connections follow the legacy default, in catalog order", () => {
  const { store } = gatewayStore({
    INFERENCE_LENS_API_ENDPOINT: "http://host.docker.internal:8080/v1",
  });

  assert.deepEqual(store.report(), {
    connections: [
      {
        id: "default",
        name: "Server default",
        endpoint: "http://host.docker.internal:8080/v1",
        credentialConfigured: false,
      },
      {
        id: "chat",
        name: "Chat gateway",
        endpoint: "https://chat.example.test/v1",
        protocols: ["openai-compatible-chat-completions", "openai-responses"],
        systemOne: false,
        credentialConfigured: true,
      },
      {
        id: "decide",
        name: "Decision models",
        endpoint: "https://decide.example.test/v1",
        model: "local-decision",
        protocols: [],
        systemOne: true,
        credentialConfigured: true,
      },
    ],
    diagnostics: [],
  });
});

test("each connection's key, trimmed, goes only with its own selection", () => {
  const { store } = gatewayStore();

  // A relative key file resolves against the catalog's directory; an absolute
  // one is taken as written.
  assert.equal(
    discover(store, "https://chat.example.test/v1", {
      kind: "environment-default",
      connectionId: "chat",
    }),
    "chat-key",
  );
  assert.equal(
    discover(store, "https://decide.example.test/v1/models", {
      kind: "environment-default",
      connectionId: "decide",
    }),
    "decide-key",
  );
});

test("connections that share an origin keep their keys apart", () => {
  const store = new ServerConnectionStore(
    { INFERENCE_LENS_CONNECTIONS: "/c.json", FIRST: "first-key", SECOND: "second-key" },
    {
      readFile: files({
        "/c.json": JSON.stringify({
          schemaVersion: 1,
          connections: [
            { id: "first", endpoint: "https://gateway.test/a/v1", apiKeyEnv: "FIRST" },
            { id: "second", endpoint: "https://gateway.test/b/v1", apiKeyEnv: "SECOND" },
          ],
        }),
      }),
    },
  );

  for (const [connectionId, key] of [
    ["first", "first-key"],
    ["second", "second-key"],
  ]) {
    assert.equal(
      discover(store, "https://gateway.test/a/v1", { kind: "environment-default", connectionId }),
      key,
    );
  }
});

test("a key is never released to another origin", () => {
  const { store } = gatewayStore();
  assert.throws(
    () =>
      discover(store, "https://attacker.example/v1", {
        kind: "environment-default",
        connectionId: "decide",
      }),
    (error: Error) =>
      /server connection "decide" is bound to https:\/\/decide\.example\.test; it cannot be sent to https:\/\/attacker\.example/.test(
        error.message,
      ) && !error.message.includes("decide-key"),
  );
  // The chat key is not a fallback for the decision origin either.
  assert.throws(
    () =>
      discover(store, "https://decide.example.test/v1", {
        kind: "environment-default",
        connectionId: "chat",
      }),
    /cannot be sent to https:\/\/decide\.example\.test/,
  );
});

test("an unknown connection id is refused by name", () => {
  const { store } = gatewayStore();
  assert.throws(
    () =>
      discover(store, "https://chat.example.test/v1", {
        kind: "environment-default",
        connectionId: "gone",
      }),
    /The server has no connection "gone"/,
  );
});

test("a malformed connection id is an invalid selection", () => {
  const { store } = gatewayStore();
  for (const connectionId of ["../chat", "Chat", 7, ""]) {
    assert.throws(
      () =>
        discover(store, "https://chat.example.test/v1", {
          kind: "environment-default",
          connectionId,
        }),
      /Credential selection is invalid/,
      String(connectionId),
    );
  }
});

test("a keyless catalog connection cannot be selected for a server key", () => {
  const store = new ServerConnectionStore(
    { INFERENCE_LENS_CONNECTIONS: "/c.json" },
    {
      readFile: files({
        "/c.json": JSON.stringify({
          schemaVersion: 1,
          connections: [{ id: "local", endpoint: "http://llama:8080/v1" }],
        }),
      }),
    },
  );
  assert.equal(store.report().connections[0].credentialConfigured, false);
  assert.throws(
    () =>
      discover(store, "http://llama:8080/v1", {
        kind: "environment-default",
        connectionId: "local",
      }),
    /Server connection "local" holds no key/,
  );
});

test("an unreadable key file disables only its connection, and the browser never sees the path", () => {
  const { contents, store } = gatewayStore();
  delete contents["/secrets/decide.key"];

  const report = store.report();
  const decide = report.connections.find(({ id }) => id === "decide");
  assert.equal(decide?.credentialConfigured, false);
  assert.equal(decide?.problem, "Its key file could not be read.");
  assert.equal(report.connections.find(({ id }) => id === "chat")?.credentialConfigured, true);
  // The operator's log gets the detail.
  assert.equal(report.diagnostics.length, 1);
  assert.match(report.diagnostics[0], /"decide".*\/secrets\/decide\.key/);

  assert.throws(
    () =>
      discover(store, "https://decide.example.test/v1", {
        kind: "environment-default",
        connectionId: "decide",
      }),
    (error: Error) =>
      /Server connection "decide" holds no key: its key file could not be read/.test(error.message) &&
      !error.message.includes("/secrets"),
  );
});

test("an empty key file or a missing key variable is reported, not sent", () => {
  const empty = gatewayStore();
  empty.contents["/config/chat.key"] = " \n";
  assert.equal(
    empty.store.report().connections.find(({ id }) => id === "chat")?.problem,
    "Its key file is empty.",
  );

  const store = new ServerConnectionStore(
    { INFERENCE_LENS_CONNECTIONS: "/c.json" },
    {
      readFile: files({
        "/c.json": JSON.stringify({
          schemaVersion: 1,
          connections: [{ id: "env", endpoint: "https://a.test/v1", apiKeyEnv: "UNSET_KEY" }],
        }),
      }),
    },
  );
  const [connection] = store.report().connections;
  assert.equal(connection.credentialConfigured, false);
  assert.equal(connection.problem, "UNSET_KEY is not set.");
});

test("a structural catalog problem refuses the catalog and leaves the default alone", () => {
  for (const [catalogContents, pattern] of [
    [undefined, /could not be read/],
    ["{ not json", /is not valid JSON/],
    [JSON.stringify({ schemaVersion: 1, connections: [{ id: "default", endpoint: "https://a.test" }] }), /reserved/],
  ] as const) {
    const store = new ServerConnectionStore(
      {
        INFERENCE_LENS_CONNECTIONS: "/config/connections.json",
        INFERENCE_LENS_API_KEY: "environment-key",
        INFERENCE_LENS_API_ENDPOINT: "https://api.example.test/v1",
      },
      {
        readFile: files(
          catalogContents === undefined ? {} : { "/config/connections.json": catalogContents },
        ),
      },
    );
    const report = store.report();
    assert.deepEqual(report.connections.map(({ id }) => id), ["default"]);
    assert.match(report.catalogProblem ?? "", pattern);
    assert.doesNotMatch(report.catalogProblem ?? "", /\/config/);
    assert.match(report.diagnostics.join("\n"), /\/config\/connections\.json/);
    assert.equal(
      discover(store, "https://api.example.test/v1", { kind: "environment-default" }),
      "environment-key",
    );
  }
});

test("one connection's unrecognized protocol is its own to report", () => {
  const store = new ServerConnectionStore(
    { INFERENCE_LENS_CONNECTIONS: "/c.json" },
    {
      readFile: files({
        "/c.json": JSON.stringify({
          schemaVersion: 1,
          connections: [
            { id: "typo", endpoint: "https://a.test/v1", protocols: ["responses", "assistants"] },
            { id: "fine", endpoint: "https://b.test/v1", protocols: ["responses"] },
          ],
        }),
      }),
    },
  );
  const [typo, fine] = store.report().connections;
  assert.deepEqual(typo.unrecognizedProtocols, ["assistants"]);
  assert.equal(typo.protocols, undefined);
  assert.deepEqual(fine.protocols, ["openai-responses"]);
});

test("the catalog and its keys are read per request, so edits need no restart", () => {
  const { contents, store } = gatewayStore();
  const selection = { kind: "environment-default", connectionId: "chat" };
  assert.equal(discover(store, "https://chat.example.test/v1", selection), "chat-key");

  contents["/config/chat.key"] = "rotated-key";
  assert.equal(discover(store, "https://chat.example.test/v1", selection), "rotated-key");

  contents["/config/connections.json"] = JSON.stringify({ schemaVersion: 1, connections: [] });
  assert.deepEqual(store.report().connections, []);
  assert.throws(() => discover(store, "https://chat.example.test/v1", selection), /no connection "chat"/);
});
