import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDistinctConnectionVariables,
  connectionVariableNames,
  CredentialResolutionError,
  resolveConnection,
} from "../packages/cli/src/credentials.ts";

const requirement = {
  id: "connection_evals-default",
  name: "Default connection",
  endpoint: "https://provider.example.test/v1",
};

test("connection variables drop the entity prefix and fold to a shell name", () => {
  assert.deepEqual(connectionVariableNames("connection_evals-default"), {
    apiKey: "INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_API_KEY",
    endpoint: "INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_ENDPOINT",
  });
});

test("a per-connection key serves its connection at the project's endpoint", () => {
  const resolved = resolveConnection(requirement, {
    INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_API_KEY: "sk-own",
    INFERENCE_LENS_API_KEY: "sk-default",
    INFERENCE_LENS_API_ENDPOINT: "https://provider.example.test",
  }, new Set());
  assert.deepEqual(resolved.credential, { kind: "provided", apiKey: "sk-own" });
  assert.equal(resolved.endpoint, requirement.endpoint);
  assert.equal(resolved.source, "INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_API_KEY");
});

test("an endpoint override re-points the connection and its key travels with it", () => {
  const resolved = resolveConnection(requirement, {
    INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_API_KEY: "sk-own",
    INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_ENDPOINT: "http://127.0.0.1:9000/v1",
  }, new Set());
  assert.equal(resolved.endpoint, "http://127.0.0.1:9000/v1");
  assert.deepEqual(resolved.credential, { kind: "provided", apiKey: "sk-own" });
});

test("the server default key is released only to its own origin", () => {
  const served = resolveConnection(requirement, {
    INFERENCE_LENS_API_KEY: "sk-default",
    INFERENCE_LENS_API_ENDPOINT: "https://provider.example.test/other/path",
  }, new Set());
  assert.deepEqual(served.credential, { kind: "provided", apiKey: "sk-default" });
  assert.equal(served.source, "INFERENCE_LENS_API_KEY");

  assert.throws(
    () => resolveConnection(requirement, {
      INFERENCE_LENS_API_KEY: "sk-default",
      INFERENCE_LENS_API_ENDPOINT: "https://elsewhere.example.test",
    }, new Set()),
    (error: unknown) => error instanceof CredentialResolutionError &&
      error.message.includes("connection_evals-default") &&
      error.message.includes("INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_API_KEY") &&
      !error.message.includes("sk-default"),
  );
});

test("a missing credential is an error, never an unauthenticated call", () => {
  assert.throws(
    () => resolveConnection(requirement, {}, new Set()),
    /No credential for connection "Default connection" \(connection_evals-default\) at https:\/\/provider\.example\.test.*--no-auth connection_evals-default/,
  );
  // An endpoint variable with no key is a server-style "local provider" setup;
  // headless, that still has to be said out loud.
  assert.throws(
    () => resolveConnection(requirement, { INFERENCE_LENS_API_ENDPOINT: "https://provider.example.test" }, new Set()),
    CredentialResolutionError,
  );
});

test("--no-auth sends no key, and refuses to coexist with a configured one", () => {
  const resolved = resolveConnection(requirement, {}, new Set([requirement.id]));
  assert.deepEqual(resolved.credential, { kind: "none" });
  assert.throws(
    () => resolveConnection(requirement, {
      INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_API_KEY: "sk-own",
    }, new Set([requirement.id])),
    /declared --no-auth, but INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_API_KEY is also set/,
  );
});

test("an endpoint override that is not HTTP is named as the problem", () => {
  assert.throws(
    () => resolveConnection(requirement, {
      INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_ENDPOINT: "ftp://provider.example.test",
      INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_API_KEY: "sk-own",
    }, new Set()),
    /INFERENCE_LENS_CONNECTION_EVALS_DEFAULT_ENDPOINT must use HTTP or HTTPS/,
  );
});

test("two connections that fold to one variable name are refused", () => {
  assert.throws(
    () => assertDistinctConnectionVariables([{ id: "connection_a-b" }, { id: "connection_a.b" }]),
    /connection_a-b and connection_a\.b both map to INFERENCE_LENS_CONNECTION_A_B_\*/,
  );
  assert.doesNotThrow(() => assertDistinctConnectionVariables([{ id: "connection_a" }, { id: "connection_b" }]));
});
