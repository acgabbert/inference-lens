import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  DecisionExecution,
  DecisionInput,
  DecisionTransportEvent,
} from "../packages/core/src/decision.ts";
import { createEntityId } from "../packages/core/src/run-kernel/index.ts";
import type { JsonObject } from "../packages/core/src/run-kernel/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import {
  EnvironmentCredentialStore,
  executeDecision,
  resolveDecisionRequest,
} from "../services/api/src/index.ts";

interface WireFixture {
  request?: JsonObject & DecisionInput & { model: string };
  response: { status: number; body: unknown };
}

function fixture(name: string): WireFixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/system-one/${name}.json`, import.meta.url), "utf8"),
  ) as WireFixture;
}

const allTypes = fixture("llamacpp-all-types");

function execution(request = allTypes.request!): DecisionExecution {
  const { model, state, questions } = request;
  return {
    runId: createEntityId("run", "decision"),
    attempt: 1,
    exchangeId: createEntityId("exchange", "decision"),
    input: {
      target: {
        profileId: createEntityId("profile", "llamacpp"),
        protocol: "systemone",
        endpoint: "https://llm.example.test/v1",
        model,
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      decision: { state, questions },
    },
  };
}

async function eventsFor(
  respond: (input: string, init?: RequestInit) => Promise<Response>,
  apiKey = "test-key",
  signal?: AbortSignal,
): Promise<DecisionTransportEvent[]> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => respond(String(input), init);
  try {
    const events: DecisionTransportEvent[] = [];
    for await (const event of executeDecision(execution(), apiKey, signal)) events.push(event);
    return events;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a decision exchange records the redacted request, the raw body, and the answers", async () => {
  const raw = JSON.stringify(allTypes.response.body);
  const events = await eventsFor(async (input, init) => {
    assert.equal(input, "https://llm.example.test/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    // Byte for byte what the adapter built from the authored request.
    assert.equal(init?.body, JSON.stringify(allTypes.request));
    return new Response(raw, {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "session=secret" },
    });
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ["request", "response_started", "frame", "completed"],
  );
  const [request, response, frame, completed] = events;
  assert.ok(request?.type === "request");
  assert.equal(request.request.headers.authorization, "Bearer ••••••••");
  assert.equal(request.request.body, JSON.stringify(allTypes.request));
  assert.ok(response?.type === "response_started");
  assert.equal(response.response.headers["set-cookie"], "••••••••");
  assert.deepEqual(frame, { type: "frame", frame: { index: 0, raw } });
  assert.ok(completed?.type === "completed");
  assert.deepEqual(
    Object.keys(completed.result.answers),
    Object.keys(allTypes.request!.questions),
  );
});

test("an error body is kept as evidence and its protocol message is the failure", async () => {
  const unauthorized = fixture("llamacpp-401");
  const raw = JSON.stringify(unauthorized.response.body);
  const events = await eventsFor(async () => new Response(raw, { status: 401 }));
  assert.deepEqual(
    events.map((event) => event.type),
    ["request", "response_started", "frame", "failed"],
  );
  assert.deepEqual(events[2], { type: "frame", frame: { index: 0, raw } });
  assert.deepEqual(events.at(-1), {
    type: "failed",
    error: {
      code: "provider_error",
      message: "Invalid API Key",
      providerStatus: 401,
      retryable: false,
    },
  });
});

test("a rate limit is retryable and an undocumented error body is its own message", async () => {
  const events = await eventsFor(
    async () =>
      new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
  );
  const response = events.find((event) => event.type === "response_started");
  // The Phase 3 workflow reads the wait from the recorded headers.
  assert.equal(
    response?.type === "response_started" ? response.response.headers["retry-after"] : undefined,
    "2",
  );
  assert.deepEqual(events.at(-1), {
    type: "failed",
    error: {
      code: "provider_error",
      message: "slow down",
      providerStatus: 429,
      retryable: true,
    },
  });
});

test("a success body that breaks the protocol is a protocol error, after its frame", async () => {
  const events = await eventsFor(async () => Response.json({ answers: {} }));
  assert.equal(events.at(-2)?.type, "frame");
  const failed = events.at(-1);
  assert.ok(failed?.type === "failed");
  assert.equal(failed.error.code, "protocol_error");
  assert.match(failed.error.message, /has no answer/);
});

test("a request nothing answered keeps its request evidence and is a transport error", async () => {
  const events = await eventsFor(async () => {
    throw new TypeError("fetch failed");
  }, "");
  assert.deepEqual(events.map((event) => event.type), ["request", "failed"]);
  const request = events[0];
  assert.equal(
    request?.type === "request" ? request.request.headers.authorization : undefined,
    "(not set)",
  );
  const failed = events[1];
  assert.ok(failed?.type === "failed");
  assert.equal(failed.error.code, "transport_error");
  assert.equal(failed.error.retryable, true);
});

test("an aborted exchange is cancelled, not failed", async () => {
  const controller = new AbortController();
  controller.abort();
  const events = await eventsFor(async () => {
    throw new DOMException("aborted", "AbortError");
  }, "test-key", controller.signal);
  assert.deepEqual(events.at(-1), { type: "cancelled", reason: "Request aborted." });
});

test("the decision route contract accepts a decision and refuses anything else", () => {
  const store = new EnvironmentCredentialStore({});
  const credential = { kind: "provided", apiKey: "session-key" };
  const accepted = resolveDecisionRequest({ execution: execution(), credential }, store);
  assert.equal(accepted.apiKey, "session-key");
  assert.equal(accepted.execution.input.target.protocol, "systemone");

  const base = execution();
  const refused = (input: unknown, message: RegExp) =>
    assert.throws(
      () => resolveDecisionRequest({ execution: { ...base, input }, credential }, store),
      message,
    );
  refused(
    {
      ...base.input,
      target: { ...base.input.target, protocol: "openai-compatible-chat-completions" },
    },
    /Protocol must be System One/,
  );
  refused({ ...base.input, decision: { state: "x", questions: {} } }, /at least one/);
  refused(
    { ...base.input, decision: { state: "x", questions: { q: { type: "box", instructions: "?" } } } },
    /at least one choice, score, or noul question/,
  );
  refused(
    {
      ...base.input,
      decision: { state: "x", questions: { q: { type: "score", instructions: "?", criteria: {} } } },
    },
    /at least one choice, score, or noul question/,
  );
  refused({ ...base.input, decision: { state: 3, questions: base.input.decision.questions } }, /needs a state/);
  assert.throws(
    () =>
      resolveDecisionRequest(
        { execution: { ...base, attempt: 0 }, credential },
        store,
      ),
    /identifiers are invalid/,
  );
});
