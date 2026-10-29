import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  discoverDecisionModels,
  discoverDecisionModelsOverHttp,
  modelListingUrl,
} from "../packages/core/src/decision-discovery.ts";
import type { ModelListing } from "../packages/core/src/decision-discovery.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

function listing(name: string): unknown {
  const fixture = JSON.parse(
    readFileSync(new URL(`./fixtures/system-one/${name}.json`, import.meta.url), "utf8"),
  ) as { response: { body: unknown } };
  return fixture.response.body;
}

/** A fetcher that answers each listing from `bodies` and records what was asked. */
function fetcher(bodies: Partial<Record<ModelListing, unknown | Error>>) {
  const asked: ModelListing[] = [];
  return {
    asked,
    async fetchListing(which: ModelListing) {
      asked.push(which);
      const body = bodies[which];
      if (body instanceof Error) throw body;
      if (body === undefined) throw Object.assign(new Error("Not found"), { status: 404 });
      return body;
    },
  };
}

const chatOnlyListing = {
  object: "list",
  data: [{ id: "qwen3:8b" }, { id: "tev1:0.8b" }, { id: "llama3.1:8b" }],
};

test("decision listing URLs: the filtered listing, then Ollama's tags at the server root", () => {
  assert.equal(
    modelListingUrl("https://openrouter.ai/api/v1", "systemone", "decisions"),
    "https://openrouter.ai/api/v1/models?output_modalities=decisions",
  );
  // A pasted protocol path and a gateway query reduce like every listing.
  assert.equal(
    modelListingUrl("http://localhost:11434/v1/systemone?x=1", "systemone", "decisions"),
    "http://localhost:11434/v1/models?output_modalities=decisions",
  );
  assert.equal(
    modelListingUrl("http://localhost:11434/v1/", "systemone", "ollama-tags"),
    "http://localhost:11434/api/tags",
  );
  assert.equal(
    modelListingUrl("https://proxy.example/ollama/v1", "systemone", "ollama-tags"),
    "https://proxy.example/ollama/api/tags",
  );
  // Without `/v1` there is no layout to guess from.
  assert.equal(modelListingUrl("http://localhost:8080", "systemone", "ollama-tags"), undefined);
  assert.equal(
    modelListingUrl("https://api.anthropic.com/v1", "anthropic-messages", "chat"),
    "https://api.anthropic.com/v1/models?limit=1000",
  );
});

test("OpenRouter's filtered listing is used as marked, without asking for tags", async () => {
  const host = fetcher({ decisions: listing("openrouter-models") });
  const result = await discoverDecisionModels("https://openrouter.ai/api/v1", host.fetchListing);
  assert.deepEqual(result, {
    models: ["~typesafe/jev-latest", "inception/mercury-decide:free"].sort((a, b) =>
      a.localeCompare(b),
    ),
  });
  assert.deepEqual(host.asked, ["decisions"]);
});

test("llama.cpp's data[] marker wins over its mislabelled models[] capabilities", async () => {
  const host = fetcher({ decisions: listing("llamacpp-models") });
  const result = await discoverDecisionModels("https://llm.example/v1", host.fetchListing);
  assert.deepEqual(result, { models: ["local-decision"] });
  assert.deepEqual(host.asked, ["decisions"]);
});

test("an unmarked Ollama listing falls back to /api/tags and keeps decision models", async () => {
  const host = fetcher({ decisions: chatOnlyListing, "ollama-tags": listing("ollama-models") });
  const result = await discoverDecisionModels("http://localhost:11434/v1", host.fetchListing);
  assert.deepEqual(result, { models: ["tev1:0.8b"] });
  assert.deepEqual(host.asked, ["decisions", "ollama-tags"]);
});

test("models[].capabilities counts only in a tags body, never in the first listing", async () => {
  // A first listing with only an Ollama-style models[] marking "decision" is
  // still unmarked; the step 2 request decides.
  const host = fetcher({
    decisions: {
      data: [{ id: "a" }],
      models: [{ name: "a", capabilities: ["decision"] }],
    },
  });
  const result = await discoverDecisionModels("http://localhost:11434/v1", host.fetchListing);
  assert.deepEqual(result, { models: ["a"], unfiltered: true });
});

test("with no marker anywhere, the plain listing comes back flagged unfiltered", async () => {
  const tagsMissing = fetcher({ decisions: chatOnlyListing });
  assert.deepEqual(
    await discoverDecisionModels("https://proxy.example/v1", tagsMissing.fetchListing),
    { models: ["llama3.1:8b", "qwen3:8b", "tev1:0.8b"], unfiltered: true },
  );
  assert.deepEqual(tagsMissing.asked, ["decisions", "ollama-tags"]);

  // A tags body that marks nothing as a decision model is no evidence either.
  const tagsUnmarked = fetcher({
    decisions: chatOnlyListing,
    "ollama-tags": { models: [{ name: "llama3.1:8b", capabilities: ["completion"] }] },
  });
  assert.equal(
    (await discoverDecisionModels("http://localhost:11434/v1", tagsUnmarked.fetchListing))
      .unfiltered,
    true,
  );

  // No `/v1`, so step 2 is never sent.
  const noV1 = fetcher({ decisions: chatOnlyListing });
  await discoverDecisionModels("http://localhost:8080", noV1.fetchListing);
  assert.deepEqual(noV1.asked, ["decisions"]);
});

test("a failed first listing is the discovery error; a failed tags request is not", async () => {
  const unauthorized = Object.assign(new Error("Invalid API key"), { status: 401 });
  await assert.rejects(
    discoverDecisionModels("https://llm.example/v1", fetcher({ decisions: unauthorized }).fetchListing),
    (error: unknown) => error === unauthorized,
  );

  const tagsFailed = fetcher({
    decisions: chatOnlyListing,
    "ollama-tags": new Error("socket hang up"),
  });
  assert.equal(
    (await discoverDecisionModels("http://localhost:11434/v1", tagsFailed.fetchListing)).unfiltered,
    true,
  );
});

test("over HTTP, each step is a Bearer GET to the URL the listing names", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input, init) => {
    requested.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer local-key");
    return String(input).endsWith("/api/tags")
      ? Response.json(listing("ollama-models"))
      : Response.json(chatOnlyListing);
  };
  try {
    assert.deepEqual(
      await discoverDecisionModelsOverHttp({
        endpoint: "http://localhost:11434/v1",
        apiKey: "local-key",
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      }),
      { models: ["tev1:0.8b"] },
    );
    assert.deepEqual(requested, [
      "http://localhost:11434/v1/models?output_modalities=decisions",
      "http://localhost:11434/api/tags",
    ]);
    await assert.rejects(
      discoverDecisionModelsOverHttp({
        endpoint: "http://localhost:11434/v1",
        apiKey: "",
        capabilities: { ...OPENAI_COMPATIBLE_CAPABILITIES, modelDiscovery: false },
      }),
      /not supported by this profile/,
    );
    assert.equal(requested.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
