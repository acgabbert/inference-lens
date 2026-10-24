import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  DecisionInput,
  DecisionProviderInput,
} from "../packages/core/src/decision.ts";
import { ProviderProtocolError } from "../packages/core/src/provider-protocols.ts";
import { systemOneAdapter } from "../packages/core/src/system-one.ts";
import { createEntityId } from "../packages/core/src/run-kernel/index.ts";
import type { JsonObject } from "../packages/core/src/run-kernel/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

interface WireFixture {
  provenance: { kind: "doc-derived" | "captured" };
  request?: JsonObject & DecisionInput & { model: string };
  response: { status: number; body: JsonObject };
}

function fixture(name: string): WireFixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/system-one/${name}.json`, import.meta.url), "utf8"),
  ) as WireFixture;
}

function providerInput(
  request: DecisionInput & { model: string },
  endpoint = "https://api.typesafe.ai/v1",
): DecisionProviderInput {
  const { model, state, questions } = request;
  return {
    target: {
      profileId: createEntityId("profile", "typesafe"),
      protocol: "systemone",
      endpoint,
      model,
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
    decision: { state, questions },
  };
}

const allTypes = fixture("typesafe-all-types");
const allTypesInput = providerInput(allTypes.request!);

function withAnswers(answers: JsonObject): string {
  return JSON.stringify({ ...allTypes.response.body, answers });
}

const goodAnswers = allTypes.response.body.answers as JsonObject;

test("the request body is the authored state and questions, byte for byte", () => {
  const { url, body } = systemOneAdapter.buildRequest(allTypesInput);
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  // Question keys are caller-chosen and order is meaningful to a reader, so
  // the body keeps authored order rather than any canonical one.
  assert.equal(JSON.stringify(body), JSON.stringify(allTypes.request));
});

test("a pasted full System One URL still reduces to its base", () => {
  const { url } = systemOneAdapter.buildRequest(
    providerInput(allTypes.request!, "http://localhost:11434/v1/systemone/"),
  );
  assert.equal(url, "http://localhost:11434/v1/systemone");
});

test("every question type normalizes with the wire's own field names", () => {
  const result = systemOneAdapter.normalizeResponse(
    allTypesInput,
    JSON.stringify(allTypes.response.body),
  );
  assert.deepEqual(result, {
    model: "jev-1.14.0",
    answers: {
      intent: {
        type: "choice",
        choice: "billing",
        confidence: 0.91,
        probabilities: { billing: 0.95, bug: 0.04, other: 0.01 },
      },
      severity: {
        type: "score",
        score: 1.3,
        confidence: 0.62,
        legend: {
          0: "minor",
          1: "major",
          2: { label: "critical", note: "data loss or money lost" },
        },
        probabilities: { 0: 0.1, 1: 0.5, 2: 0.4 },
      },
      is_spam: { type: "noul", noul: 0.03 },
    },
    usage: { inputTokens: 841, outputTokens: 0, totalTokens: 841 },
  });
  // Noul carries no confidence on the wire; normalization must not invent one.
  assert.equal("confidence" in result.answers.is_spam!, false);
});

test("vendor extras stay in the raw body and a missing confidence stays missing", () => {
  const extras = fixture("openrouter-extras");
  const result = systemOneAdapter.normalizeResponse(
    providerInput(extras.request!, "https://openrouter.ai/api/v1"),
    JSON.stringify(extras.response.body),
  );
  assert.deepEqual(result, {
    model: "typesafe/jev-1.14",
    answers: {
      intent: {
        type: "choice",
        choice: "refund",
        probabilities: { refund: 0.88, status: 0.12 },
      },
    },
    usage: { inputTokens: 52, outputTokens: 0, totalTokens: 52 },
  });
});

for (const [name, answers, pattern] of [
  [
    "a missing answer",
    { intent: goodAnswers.intent, severity: goodAnswers.severity },
    /is_spam.*no answer/,
  ],
  [
    "an answer for a question that was not asked",
    { ...goodAnswers, tone: { type: "noul", noul: 0.5 } },
    /tone.*not asked/,
  ],
  [
    "an answer of a different type than its question",
    { ...goodAnswers, is_spam: { type: "choice", choice: "true", probabilities: { true: 1 } } },
    /is_spam.*choice.*noul/,
  ],
  [
    "a box answer, which no supported question can produce",
    { ...goodAnswers, is_spam: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 } } },
    /is_spam.*box.*noul/,
  ],
  [
    "a choice that is not one of the options",
    { ...goodAnswers, intent: { ...(goodAnswers.intent as JsonObject), choice: "shipping" } },
    /intent.*shipping/,
  ],
  [
    "a choice probability for an unknown option",
    {
      ...goodAnswers,
      intent: { ...(goodAnswers.intent as JsonObject), probabilities: { billing: 0.9, refund: 0.1 } },
    },
    /intent.*refund/,
  ],
  [
    "a probability outside [0, 1]",
    {
      ...goodAnswers,
      intent: { ...(goodAnswers.intent as JsonObject), probabilities: { billing: 1.2 } },
    },
    /intent.*probabilit/,
  ],
  [
    "a score probability keyed by something other than a level number",
    {
      ...goodAnswers,
      severity: { ...(goodAnswers.severity as JsonObject), probabilities: { minor: 1 } },
    },
    /severity.*minor/,
  ],
  [
    "a score outside the level scale",
    { ...goodAnswers, severity: { ...(goodAnswers.severity as JsonObject), score: 2.5 } },
    /severity.*score/,
  ],
  [
    "a noul that is not a probability",
    { ...goodAnswers, is_spam: { type: "noul", noul: "no" } },
    /is_spam.*noul/,
  ],
  [
    "a confidence that is not a probability",
    { ...goodAnswers, intent: { ...(goodAnswers.intent as JsonObject), confidence: -0.1 } },
    /intent.*confidence/,
  ],
] as const) {
  test(`${name} is a protocol error that names the question`, () => {
    assert.throws(
      () => systemOneAdapter.normalizeResponse(allTypesInput, withAnswers(answers as JsonObject)),
      (error: unknown) =>
        error instanceof ProviderProtocolError && pattern.test(error.message),
    );
  });
}

test("a body that is not a decision response is a protocol error", () => {
  for (const raw of ["not json", "[]", JSON.stringify({ model: "jev" })]) {
    assert.throws(
      () => systemOneAdapter.normalizeResponse(allTypesInput, raw),
      ProviderProtocolError,
    );
  }
});

test("a validation error lists each failing field by its location", () => {
  const body = JSON.stringify(fixture("typesafe-422").response.body);
  assert.equal(
    systemOneAdapter.errorMessage(body),
    "body.questions.severity.criteria: List should have at most 10 items after validation, not 12\n" +
      "body.model: Field required",
  );
  assert.equal(
    systemOneAdapter.errorMessage(JSON.stringify({ detail: "Model not found" })),
    "Model not found",
  );
});

test("an OpenRouter error envelope reads as its message", () => {
  const body = JSON.stringify(fixture("openrouter-error").response.body);
  assert.equal(
    systemOneAdapter.errorMessage(body),
    "Insufficient credits to run this request.",
  );
});

test("an error body in no documented shape has no message of its own", () => {
  for (const raw of ["upstream timed out", "{}", JSON.stringify({ detail: [{}] })]) {
    assert.equal(systemOneAdapter.errorMessage(raw), undefined);
  }
});

const llamaEndpoint = "https://decide.example.test/v1";

test("a captured llama.cpp answer to every question type normalizes", () => {
  const captured = fixture("llamacpp-all-types");
  const input = providerInput(captured.request!, llamaEndpoint);
  assert.equal(JSON.stringify(systemOneAdapter.buildRequest(input).body), JSON.stringify(captured.request));
  const result = systemOneAdapter.normalizeResponse(input, JSON.stringify(captured.response.body));
  assert.equal(result.model, "local-decision");
  assert.deepEqual(Object.keys(result.answers), ["intent", "severity", "is_spam"]);
  assert.equal(result.answers.intent!.type === "choice" && result.answers.intent!.choice, "billing");
  const severity = result.answers.severity!;
  assert.equal(severity.type, "score");
  // A fractional score between levels, as the docs describe.
  assert.ok(severity.type === "score" && severity.score > 1 && severity.score < 2);
  assert.equal("confidence" in result.answers.is_spam!, false);
  assert.deepEqual(result.usage, { inputTokens: 203, outputTokens: 0, totalTokens: 203 });
});

test("non-ASCII option labels round-trip through a captured llama.cpp answer", () => {
  const captured = fixture("llamacpp-non-ascii");
  const result = systemOneAdapter.normalizeResponse(
    providerInput(captured.request!, llamaEndpoint),
    JSON.stringify(captured.response.body),
  );
  const sentiment = result.answers.sentiment!;
  assert.equal(sentiment.type === "choice" && sentiment.choice, "positiv 😀");
  assert.deepEqual(Object.keys(sentiment.type === "choice" ? sentiment.probabilities : {}), [
    "positiv 😀",
    "négatif",
    "中性",
  ]);
});

test("a chat-message state is sent as authored and its captured answer normalizes", () => {
  const captured = fixture("llamacpp-message-state");
  const input = providerInput(captured.request!, llamaEndpoint);
  assert.equal(JSON.stringify(systemOneAdapter.buildRequest(input).body), JSON.stringify(captured.request));
  const result = systemOneAdapter.normalizeResponse(input, JSON.stringify(captured.response.body));
  assert.equal(result.answers.resolved!.type, "noul");
});

test("captured llama.cpp error envelopes read as their message", () => {
  for (const [name, message] of [
    ["llamacpp-400-invalid", 'questions.q: "type" must be one of: choice, score, noul'],
    ["llamacpp-401", "Invalid API Key"],
    [
      "llamacpp-500-oversized",
      "input (629 tokens) is too large to process. increase the physical batch size (current batch size: 512)",
    ],
  ] as const) {
    const captured = fixture(name);
    assert.equal(systemOneAdapter.errorMessage(JSON.stringify(captured.response.body)), message, name);
  }
});

const openRouterEndpoint = "https://openrouter.ai/api/v1";

for (const name of ["openrouter-all-types", "openrouter-alpha-all-types"]) {
  test(`a captured OpenRouter answer to every question type normalizes (${name})`, () => {
    const captured = fixture(name);
    const input = providerInput(captured.request!, openRouterEndpoint);
    assert.equal(JSON.stringify(systemOneAdapter.buildRequest(input).body), JSON.stringify(captured.request));
    const result = systemOneAdapter.normalizeResponse(input, JSON.stringify(captured.response.body));
    // The response names the dated snapshot the router alias resolved to.
    assert.equal(result.model, "typesafe/jev-1.14-20261014");
    assert.deepEqual(Object.keys(result.answers), ["intent", "severity", "is_spam"]);
    assert.equal(result.answers.intent!.type === "choice" && result.answers.intent!.choice, "billing");
    assert.equal("confidence" in result.answers.is_spam!, false);
    // Unlike llama.cpp, TypeSafe through OpenRouter reports output tokens.
    assert.deepEqual(result.usage, { inputTokens: 466, outputTokens: 70, totalTokens: 536 });
  });
}

test("captured OpenRouter answers for other states, labels, and providers normalize", () => {
  for (const name of [
    "openrouter-non-ascii",
    "openrouter-message-state",
    "openrouter-other-provider",
  ]) {
    const captured = fixture(name);
    const result = systemOneAdapter.normalizeResponse(
      providerInput(captured.request!, openRouterEndpoint),
      JSON.stringify(captured.response.body),
    );
    assert.deepEqual(Object.keys(result.answers), Object.keys(captured.request!.questions), name);
  }
});

test("a box answer OpenRouter really returns is a protocol error, not a missing answer", () => {
  const captured = fixture("openrouter-box");
  assert.equal(captured.response.status, 200);
  assert.throws(
    () =>
      systemOneAdapter.normalizeResponse(
        providerInput(captured.request!, openRouterEndpoint),
        JSON.stringify(captured.response.body),
      ),
    (error: unknown) => error instanceof ProviderProtocolError && /q.*box/.test(error.message),
  );
});

test("captured OpenRouter error envelopes read as their message", () => {
  for (const [name, message] of [
    ["openrouter-401", "User not found."],
    ["openrouter-400-unknown-model", "Model typesafe/no-such-model does not exist"],
    // OpenRouter's own validation: a JSON-encoded zod issue list.
    [
      "openrouter-400-unknown-type",
      "questions.q.type: Invalid discriminator value. Expected 'noul' | 'choice' | 'score' | 'box'",
    ],
    // TypeSafe's FastAPI 422, relayed as a string after "HTTP 422: ".
    [
      "openrouter-422-too-many-options",
      "body.questions.q.choice.criteria: Dictionary should have at most 255 items after validation, not 256",
    ],
  ] as const) {
    const captured = fixture(name);
    assert.equal(systemOneAdapter.errorMessage(JSON.stringify(captured.response.body)), message, name);
  }
});

test("every fixture here is labelled with where it came from", () => {
  for (const name of [
    "typesafe-all-types",
    "openrouter-extras",
    "typesafe-422",
    "openrouter-error",
    "llamacpp-all-types",
    "llamacpp-non-ascii",
    "llamacpp-message-state",
    "llamacpp-400-invalid",
    "llamacpp-401",
    "llamacpp-500-oversized",
    "openrouter-all-types",
    "openrouter-alpha-all-types",
    "openrouter-non-ascii",
    "openrouter-message-state",
    "openrouter-box",
    "openrouter-other-provider",
    "openrouter-oversized",
    "openrouter-models",
    "openrouter-400-unknown-type",
    "openrouter-400-unknown-model",
    "openrouter-401",
    "openrouter-422-too-many-options",
  ]) {
    assert.match(fixture(name).provenance.kind, /^(doc-derived|captured)$/);
  }
});
