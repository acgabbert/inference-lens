import assert from "node:assert/strict";
import test from "node:test";

import {
  filterModels,
  modelProfileKey,
} from "../app/use-model-discovery.client.ts";

test("scopes the cache key to both profile and endpoint", () => {
  assert.notEqual(
    modelProfileKey("openai-compatible", "https://a.example.test/v1"),
    modelProfileKey("openai-compatible", "https://b.example.test/v1"),
  );
  assert.notEqual(
    modelProfileKey("profile-a", "https://a.example.test/v1"),
    modelProfileKey("profile-b", "https://a.example.test/v1"),
  );
  assert.equal(
    modelProfileKey("profile-a", "https://a.example.test/v1"),
    modelProfileKey("profile-a", "https://a.example.test/v1"),
  );
});

test("keeps components unambiguous when they contain spaces", () => {
  assert.notEqual(
    modelProfileKey("a", "b c"),
    modelProfileKey("a b", "c"),
  );
});

test("matches models case-insensitively on substrings", () => {
  const models = ["GPT-4o", "gpt-4o-mini", "claude-opus-5", "llama-3.1-70b"];

  assert.deepEqual(filterModels(models, "gpt"), ["GPT-4o", "gpt-4o-mini"]);
  assert.deepEqual(filterModels(models, "GPT-4O"), ["GPT-4o", "gpt-4o-mini"]);
  assert.deepEqual(filterModels(models, "opus"), ["claude-opus-5"]);
  assert.deepEqual(filterModels(models, "70b"), ["llama-3.1-70b"]);
});

test("treats an empty filter as no filter", () => {
  const models = ["a", "b"];

  assert.deepEqual(filterModels(models, ""), models);
  assert.deepEqual(filterModels([], ""), []);
});

test("returns nothing when no model matches", () => {
  assert.deepEqual(filterModels(["gpt-4o"], "gemini"), []);
});
