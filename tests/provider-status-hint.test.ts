import assert from "node:assert/strict";
import test from "node:test";

import { explainProviderStatusError } from "../packages/core/src/provider-protocols.ts";

const NOT_FOUND = "404 page not found";

test("suggests a version segment when a base URL without one returns 404", () => {
  const explained = explainProviderStatusError(NOT_FOUND, 404, "http://10.0.0.5:8000");
  assert.match(explained, /http:\/\/10\.0\.0\.5:8000 has no version segment/);
  assert.match(explained, /http:\/\/10\.0\.0\.5:8000\/v1\b/);
  // The provider's own message is preserved so nothing is lost for debugging.
  assert.match(explained, /404 page not found/);
});

test("judges the base URL, not a pasted full request URL", () => {
  const explained = explainProviderStatusError(
    NOT_FOUND,
    404,
    "https://gateway.example.test/llm/chat/completions",
  );
  assert.match(explained, /https:\/\/gateway\.example\.test\/llm\/v1\b/);
});

test("treats a 405 from the wrong route the same way", () => {
  assert.match(
    explainProviderStatusError("Method Not Allowed", 405, "http://localhost:1234"),
    /http:\/\/localhost:1234\/v1\b/,
  );
});

test("leaves a base URL that already names a version untouched", () => {
  for (const endpoint of [
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "http://localhost:8080/v2/",
    "https://api.example.test/v1/chat/completions",
  ]) {
    assert.equal(explainProviderStatusError(NOT_FOUND, 404, endpoint), NOT_FOUND, endpoint);
  }
});

test("says nothing about the path for statuses a path cannot cause", () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    assert.equal(
      explainProviderStatusError("Nope.", status, "http://10.0.0.5:8000"),
      "Nope.",
      String(status),
    );
  }
});

test("passes through a message it cannot attribute to an endpoint", () => {
  assert.equal(explainProviderStatusError(NOT_FOUND, 404, "not a url"), NOT_FOUND);
});
