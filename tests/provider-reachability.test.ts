import assert from "node:assert/strict";
import test from "node:test";

import { explainProviderTransportError } from "../services/api/src/provider-reachability.ts";

const FETCH_FAILED = "fetch failed";

test("explains a loopback provider address that a container cannot reach", () => {
  const explained = explainProviderTransportError(
    FETCH_FAILED,
    "http://127.0.0.1:8080/v1",
    true,
  );
  assert.match(explained, /points at the Inference Lens container itself/);
  assert.match(explained, /http:\/\/host\.docker\.internal:8080\/v1/);
  // The original message is preserved so nothing is lost for debugging.
  assert.match(explained, /fetch failed/);
});

test("covers every loopback spelling a provider README might use", () => {
  for (const endpoint of [
    "http://localhost:8080/v1",
    "http://127.0.0.1:8080/v1",
    "http://127.5.0.1:8080/v1",
    "http://0.0.0.0:8080/v1",
    "http://[::1]:8080/v1",
  ]) {
    assert.match(
      explainProviderTransportError(FETCH_FAILED, endpoint, true),
      /host\.docker\.internal/,
      endpoint,
    );
  }
});

test("leaves a reachable remote provider's failure untouched", () => {
  assert.equal(
    explainProviderTransportError(
      FETCH_FAILED,
      "https://api.openai.com/v1",
      true,
    ),
    FETCH_FAILED,
  );
});

test("says nothing about containers when not running in one", () => {
  // Off a container, 127.0.0.1 is a perfectly ordinary local provider address.
  assert.equal(
    explainProviderTransportError(FETCH_FAILED, "http://127.0.0.1:8080/v1", false),
    FETCH_FAILED,
  );
});

test("passes through a message it cannot attribute to an endpoint", () => {
  assert.equal(
    explainProviderTransportError(FETCH_FAILED, "not a url", true),
    FETCH_FAILED,
  );
});
