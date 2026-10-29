import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "../packages/core/src/run-kernel/types.ts";
import * as authoring from "../packages/core/src/evaluation-suite-authoring.ts";
import { preflightJsonSchema } from "../packages/core/src/json-schema/preflight.ts";
import { evaluateJsonSchema } from "../packages/core/src/json-schema/evaluator.ts";
import { SCHEMA_CHECK_LIMITS } from "../packages/core/src/json-schema/limits.ts";

// Use the authoring API: generation is an author action, never a scoring mode.
test("authoring exposes deterministic schema generation", () => {
  assert.equal(typeof authoring.generateJsonSchema, "function");
});

const generate = (text: string, disallowExtraProperties = false) => authoring.generateJsonSchema(text, { disallowExtraProperties });
test("all JSON roots infer types without constraining literal values", () => {
  for (const [text, type] of [["null", "null"], ["true", "boolean"], ['"2026-10-16"', "string"], ["2", "integer"], ["2.5", "number"]]) {
    assert.deepEqual(generate(text), { status: "ready", schema: { type }, warnings: [] });
  }
});
test("nested observed fields are required and extras are an explicit recursive choice", () => {
  const result = generate('{"z":{"name":"A"},"rows":[{"n":2}]}', true);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual(result.schema, { type: "object", properties: {
    rows: { type: "array", items: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } },
    z: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  }, required: ["rows", "z"], additionalProperties: false });
  assert.equal(preflightJsonSchema(result.schema, SCHEMA_CHECK_LIMITS.schema).status, "ready");
  assert.deepEqual(generate('{"x":1}'), { status: "ready", schema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"] }, warnings: [] });
});
test("arrays inspect all items and deduplicate structurally equal branches", () => {
  const result = generate('[{"b":2,"a":"x"},{"a":"y","b":3},null,2,3]');
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual(result.schema, { type: "array", items: { anyOf: [
    { type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a", "b"] },
    { type: "null" }, { type: "integer" },
  ] } });
  assert.deepEqual(generate("[1,2]"), { status: "ready", schema: { type: "array", items: { type: "integer" } }, warnings: [] });
});
test("empty arrays infer unconstrained items and bounded warnings", () => {
  assert.deepEqual(generate("[]"), { status: "ready", schema: { type: "array", items: true }, warnings: ["empty-array"] });
  const result = generate("[[],[]]");
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.deepEqual(result.warnings, ["empty-array"]);
});
test("invalid examples and budgets return owned diagnostics without native errors or text", () => {
  for (const text of ['{"secret":', '```json\n{}\n```', "1e999"]) {
    assert.equal(generate(text).status, "invalid");
  }
  const tooLarge = generate('"' + "x".repeat(65_536) + '"');
  assert.equal(tooLarge.status, "invalid");
  if (tooLarge.status === "invalid") assert.equal(tooLarge.code, "example-too-large");
  const deep = generate("[".repeat(65) + "0" + "]".repeat(65));
  assert.equal(deep.status, "invalid");
  if (deep.status === "invalid") assert.equal(deep.code, "example-depth-limit");
  // A small example can expand beyond the schema budget: fail rather than truncate.
  const expanding = generate(JSON.stringify(Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`field${i}`, 1]))));
  assert.equal(expanding.status, "invalid");
});
test("prototype-shaped keys remain ordinary required properties", () => {
  const result = generate('{"__proto__":{"constructor":1},"toString":true}', true);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(Object.hasOwn(result.schema.properties as object, "__proto__"), true);
  assert.equal(preflightJsonSchema(result.schema, SCHEMA_CHECK_LIMITS.schema).status, "ready");
});

test("generated and equivalent hand-authored schemas use the same evaluator without mutation", () => {
  const result = generate('{"answer":2}', true);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const manual = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };
  const answers: JsonValue[] = [{ answer: 3 }, { answer: "3" }, { answer: 3, extra: true }, {}];
  for (const value of answers) {
    const before = JSON.stringify(value);
    assert.deepEqual(evaluateJsonSchema(result.schema, value, SCHEMA_CHECK_LIMITS), evaluateJsonSchema(manual, value, SCHEMA_CHECK_LIMITS));
    assert.equal(JSON.stringify(value), before);
  }
});
