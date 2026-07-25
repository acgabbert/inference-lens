import assert from "node:assert/strict";
import test from "node:test";

import {
  recordDiagnostic,
  redactDiagnosticUrl,
  redactDiagnosticValue,
  startDiagnosticCapture,
} from "../app/diagnostics.client.ts";
import type { InferenceRequest } from "../packages/core/src/types.ts";

const request: InferenceRequest = {
  provider: "openai-compatible",
  endpoint: "https://api.example.test/v1",
  model: "example-model",
  messages: [{ role: "user", content: "Hello" }],
  temperature: 0.7,
};

test("redacts credential-bearing keys regardless of casing", () => {
  const redactedValue = redactDiagnosticValue({
    apiKey: "sk-live-1",
    API_KEY: "sk-live-2",
    Authorization: "Bearer sk-live-3",
    Cookie: "session=abc",
    "set-cookie": "session=def",
    token: "sk-live-4",
    access_token: "sk-live-5",
    model: "example-model",
  });

  assert.deepEqual(redactedValue, {
    apiKey: "••••",
    API_KEY: "••••",
    Authorization: "••••",
    Cookie: "••••",
    "set-cookie": "••••",
    token: "••••",
    access_token: "••••",
    model: "example-model",
  });
});

test("redacts vendor-prefixed api key headers without enumerating them", () => {
  const redactedValue = redactDiagnosticValue({
    "x-api-key": "sk-ant-1",
    "anthropic-api-key": "sk-ant-2",
    "x-goog-api-key": "goog-1",
    "api-key": "azure-1",
    "X-API-Key": "sk-ant-3",
    "openrouter-apikey": "or-1",
    "content-type": "application/json",
  });

  assert.deepEqual(redactedValue, {
    "x-api-key": "••••",
    "anthropic-api-key": "••••",
    "x-goog-api-key": "••••",
    "api-key": "••••",
    "X-API-Key": "••••",
    "openrouter-apikey": "••••",
    "content-type": "application/json",
  });
});

test("keeps token accounting readable while still redacting bare token keys", () => {
  const redactedValue = redactDiagnosticValue({
    token: "sk-live-1",
    access_token: "sk-live-2",
    totalTokens: 1024,
    total_tokens: 1024,
    tokenCount: 512,
    inputTokens: 256,
    outputTokens: 768,
  });

  assert.deepEqual(redactedValue, {
    token: "••••",
    access_token: "••••",
    totalTokens: 1024,
    total_tokens: 1024,
    tokenCount: 512,
    inputTokens: 256,
    outputTokens: 768,
  });
});

test("redacts credentials nested in objects and arrays", () => {
  const redactedValue = redactDiagnosticValue({
    attempts: [
      { authorization: "Bearer sk-live-1", status: 401 },
      { headers: { apiKey: "sk-live-2" }, status: 200 },
    ],
  });

  assert.deepEqual(redactedValue, {
    attempts: [
      { authorization: "••••", status: 401 },
      { headers: { apiKey: "••••" }, status: 200 },
    ],
  });
});

test("collapses a credential to a placeholder even when it holds a structure", () => {
  assert.equal(
    redactDiagnosticValue({ items: ["a", "b"] }, "authorization"),
    "••••",
  );
});

test("preserves message bodies so reports stay useful", () => {
  const redactedValue = redactDiagnosticValue({
    messages: [{ role: "user", content: "Summarize this contract." }],
  }) as { messages: { role: string; content: string }[] };

  assert.equal(redactedValue.messages[0]?.content, "Summarize this contract.");
});

test("strips credentials from endpoint and url query parameters", () => {
  assert.equal(
    redactDiagnosticValue(
      "https://api.example.test/v1?api_key=sk-live-1&model=example-model",
      "endpoint",
    ),
    "https://api.example.test/v1?api_key=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2&model=example-model",
  );
  assert.equal(
    redactDiagnosticValue("https://api.example.test/v1?TOKEN=sk-live-2", "url"),
    "https://api.example.test/v1?TOKEN=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2",
  );
  assert.equal(
    redactDiagnosticValue("https://api.example.test/v1?secret=sk-live-3", "url"),
    "https://api.example.test/v1?secret=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2",
  );
  assert.equal(
    redactDiagnosticValue(
      "https://api.example.test/v1?access_token=sk-live-4",
      "url",
    ),
    "https://api.example.test/v1?access_token=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2",
  );
});

test("applies the api key patterns to query parameters too", () => {
  assert.equal(
    redactDiagnosticUrl("https://api.example.test/v1?api-key=azure-1"),
    "https://api.example.test/v1?api-key=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2",
  );
  assert.equal(
    redactDiagnosticUrl("https://api.example.test/v1?x-api-key=sk-ant-1"),
    "https://api.example.test/v1?x-api-key=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2",
  );
});

test("redacts a vendor-prefixed key nested in captured response headers", () => {
  const capture = startDiagnosticCapture(request);

  recordDiagnostic(capture, "client.response_received", {
    status: 200,
    headers: { "x-api-key": "sk-ant-1", "x-request-id": "req-42" },
  });

  assert.deepEqual(capture.records[0]?.detail, {
    status: 200,
    headers: { "x-api-key": "••••", "x-request-id": "req-42" },
  });
});

test("leaves an unparseable endpoint untouched rather than dropping it", () => {
  assert.equal(redactDiagnosticUrl("not-a-url"), "not-a-url");
  assert.equal(redactDiagnosticUrl(undefined), undefined);
  assert.equal(redactDiagnosticUrl(42), 42);
});

test("passes through primitives and null", () => {
  assert.equal(redactDiagnosticValue(null), null);
  assert.equal(redactDiagnosticValue(undefined), undefined);
  assert.equal(redactDiagnosticValue("plain"), "plain");
  assert.equal(redactDiagnosticValue(7), 7);
  assert.equal(redactDiagnosticValue(false), false);
});

test("captures a redacted request snapshot at start", () => {
  const capture = startDiagnosticCapture({
    ...request,
    endpoint: "https://api.example.test/v1?api_key=sk-live-1",
  });

  assert.equal(capture.schemaVersion, 1);
  assert.deepEqual(capture.records, []);
  assert.equal(
    capture.request.endpoint,
    "https://api.example.test/v1?api_key=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2",
  );
  assert.equal(capture.request.model, "example-model");
  assert.ok(Number.isFinite(Date.parse(capture.startedAt)));
});

test("records boundaries in order with redacted details", () => {
  const capture = startDiagnosticCapture(request);

  recordDiagnostic(capture, "client.request_started", { request });
  recordDiagnostic(capture, "client.response_received", {
    status: 200,
    headers: { authorization: "Bearer sk-live-1", "content-type": "application/x-ndjson" },
  });
  recordDiagnostic(capture, "client.stream_finished");

  assert.deepEqual(
    capture.records.map(({ index, boundary }) => ({ index, boundary })),
    [
      { index: 0, boundary: "client.request_started" },
      { index: 1, boundary: "client.response_received" },
      { index: 2, boundary: "client.stream_finished" },
    ],
  );
  assert.deepEqual(capture.records[1]?.detail, {
    status: 200,
    headers: {
      authorization: "••••",
      "content-type": "application/x-ndjson",
    },
  });
  assert.ok(Number.isFinite(Date.parse(capture.records[0]!.recordedAt)));
});

test("omits detail entirely when a boundary carries none", () => {
  const capture = startDiagnosticCapture(request);

  recordDiagnostic(capture, "client.stop_requested");

  assert.equal(capture.records[0]?.detail, undefined);
  assert.ok(!("detail" in capture.records[0]!) || capture.records[0].detail === undefined);
});
