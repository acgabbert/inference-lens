import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialHeaders,
  effectiveProtocol,
  protocolHeaders,
  providerBaseEndpoint,
  providerModelsUrl,
  providerRequestUrl,
  redactedCredentialHeaders,
  sameProviderTarget,
  supportedProtocols,
} from "../packages/core/src/provider-protocols.ts";
import { chatCompletionsUrl } from "../packages/core/src/openai-compatible.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

test("every protocol path is appended to the same base, whatever was pasted", () => {
  for (const endpoint of [
    "https://api.example.com/v1",
    "https://api.example.com/v1/",
    "https://API.example.com/v1/chat/completions",
    "https://api.example.com/v1/responses",
    "https://api.example.com/v1/messages/",
  ]) {
    assert.equal(providerBaseEndpoint(endpoint), "https://api.example.com/v1");
    assert.equal(
      providerRequestUrl(endpoint, "openai-compatible-chat-completions"),
      "https://api.example.com/v1/chat/completions",
    );
    assert.equal(
      providerRequestUrl(endpoint, "openai-responses"),
      "https://api.example.com/v1/responses",
    );
    assert.equal(
      providerRequestUrl(endpoint, "anthropic-messages"),
      "https://api.example.com/v1/messages",
    );
    assert.equal(providerModelsUrl(endpoint), "https://api.example.com/v1/models");
  }
  assert.equal(
    providerRequestUrl("http://localhost:8080", "openai-responses"),
    "http://localhost:8080/responses",
  );
});

test("a gateway's query survives on model calls but not on the listing", () => {
  const endpoint = "https://gateway.example.com/openai?api-version=2025-01-01";
  assert.equal(
    chatCompletionsUrl(endpoint),
    "https://gateway.example.com/openai/chat/completions?api-version=2025-01-01",
  );
  assert.equal(
    providerRequestUrl(endpoint, "openai-responses"),
    "https://gateway.example.com/openai/responses?api-version=2025-01-01",
  );
  assert.equal(providerModelsUrl(endpoint), "https://gateway.example.com/openai/models");
});

test("one connection is the same target whichever protocol path it was entered with", () => {
  assert.equal(
    sameProviderTarget("https://api.example.com/v1/messages", "https://api.example.com/v1/"),
    true,
  );
  assert.equal(
    sameProviderTarget("https://api.example.com/v1", "https://api.example.com/v2"),
    false,
  );
});

test("the credential header follows the protocol and is masked in evidence", () => {
  assert.deepEqual(credentialHeaders("anthropic-messages", "key"), { "x-api-key": "key" });
  assert.deepEqual(credentialHeaders("openai-responses", "key"), {
    authorization: "Bearer key",
  });
  assert.deepEqual(credentialHeaders("anthropic-messages", ""), {});
  assert.deepEqual(protocolHeaders("anthropic-messages"), {
    "anthropic-version": "2023-06-01",
  });
  assert.deepEqual(protocolHeaders("openai-compatible-chat-completions"), {});
  assert.deepEqual(redactedCredentialHeaders("anthropic-messages", true), {
    "x-api-key": "••••••••",
  });
  assert.deepEqual(redactedCredentialHeaders("openai-responses", false), {
    authorization: "(not set)",
  });
});

test("a run's protocol is the preference when supported, else the first supported", () => {
  const both = { ...OPENAI_COMPATIBLE_CAPABILITIES, responsesApi: true };
  assert.deepEqual(supportedProtocols(both), [
    "openai-compatible-chat-completions",
    "openai-responses",
  ]);
  assert.equal(effectiveProtocol(both, "openai-responses"), "openai-responses");
  assert.equal(
    effectiveProtocol(both, "anthropic-messages"),
    "openai-compatible-chat-completions",
  );
  // A snapshot recorded before Anthropic existed lacks the key entirely.
  const legacy = { ...OPENAI_COMPATIBLE_CAPABILITIES } as Record<string, boolean>;
  delete legacy.anthropicMessages;
  assert.deepEqual(supportedProtocols(legacy as never), [
    "openai-compatible-chat-completions",
  ]);
  const none = { ...OPENAI_COMPATIBLE_CAPABILITIES, chatCompletions: false };
  assert.equal(effectiveProtocol(none), "openai-compatible-chat-completions");
});
