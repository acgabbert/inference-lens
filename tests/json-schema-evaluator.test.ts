import assert from "node:assert/strict";
import test from "node:test";

import { evaluateJsonSchema, type SchemaEvaluationLimits } from "../packages/core/src/json-schema/evaluator.ts";
import type { JsonValue } from "../packages/core/src/run-kernel/types.ts";

const limits: SchemaEvaluationLimits = {
  schema: { workLimit: 4_000_000, storageLimit: 4_000_000, maxSchemaCodeUnits: 65_536, maxDepth: 64 },
  verdict: { workLimit: 4_000_000, storageLimit: 4_000_000 },
  diagnostics: { workLimit: 4_000_000, storageLimit: 4_000_000, maxIssues: 20 },
  maxDataDepth: 64,
};
const evaluate = (schema: unknown, data: JsonValue, options = limits) => evaluateJsonSchema(schema, data, options);

test("diagnostic work cannot turn a decided mismatch into not-evaluated", () => {
  const result = evaluate({ items: { type: "number" } }, Array(200).fill("x"), {
    ...limits, diagnostics: { ...limits.diagnostics, workLimit: 0 },
  });
  assert.equal(result.status, "invalid");
  assert.equal(result.truncated, true);
});

test("allOf-wrapped consuming recursion reaches the supported data depth", () => {
  let data: JsonValue = null;
  for (let i = 1; i < 64; i++) data = { next: data };
  const result = evaluate({ properties: { next: { allOf: [{ $ref: "#" }] } } }, data);
  assert.equal(result.status, "valid");
});

test("diagnostic count, work and storage cannot affect verdict accounting", () => {
  const schema = { items: { type: "number" } };
  const data = Array(200).fill("private-answer");
  const complete = evaluate(schema, data, { ...limits, diagnostics: { ...limits.diagnostics, maxIssues: 300 } });
  assert.equal(complete.status, "invalid");
  assert.equal(complete.issues.length, 200);
  assert.equal(complete.truncated, false);
  for (const diagnosticLimits of [
    { workLimit: 0 }, { storageLimit: 0 }, { maxIssues: 0 }, { maxIssues: 1 }, { maxIssues: 20 },
  ]) {
    const result = evaluate(schema, data, {
      ...limits, verdict: { workLimit: complete.stats.verdict.work, storageLimit: complete.stats.verdict.storage },
      diagnostics: { ...limits.diagnostics, ...diagnosticLimits },
    });
    assert.equal(result.status, "invalid");
    assert.deepEqual(result.stats.verdict, complete.stats.verdict);
    assert.equal(result.truncated, true);
  }
});

test("nested diagnostics carry authored expectations without dynamic keys or values", () => {
  const result = evaluate({
    type: "object", required: ["missing"],
    properties: { answer: { type: "number" }, rows: { items: { required: ["id"] } } },
    additionalProperties: { type: "boolean" },
  }, { answer: "secret-value", rows: [{}], "secret-key": "secret-other" });
  assert.equal(result.status, "invalid");
  assert.ok(result.issues.some((i) => i.keyword === "required" && i.missingProperty === "missing"));
  assert.ok(result.issues.some((i) => i.expectedType === "number" && JSON.stringify(i.location) === '[{"property":"answer"}]'));
  assert.ok(result.issues.some((i) => i.expectedType === "boolean" && JSON.stringify(i.location) === '[{"redacted":true}]'));
  assert.ok(result.issues.some((i) => i.missingProperty === "id" && JSON.stringify(i.location) === '[{"property":"rows"},{"index":0}]'));
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("extra-property and property-name violations never expose unexpected names", () => {
  for (const schema of [{ additionalProperties: false }, { propertyNames: { maxLength: 2 } }]) {
    const result = evaluate(schema, { "private-unexpected": "private-value" });
    assert.equal(result.status, "invalid");
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.equal(result.issues[0].keyword, "additionalProperties" in schema ? "additionalProperties" : "propertyNames");
  }
});

test("schema behavior is strict and never transforms frozen inputs", () => {
  const data = Object.freeze({ answer: "3", extra: true });
  const schema = Object.freeze({
    required: Object.freeze(["absent"]),
    properties: Object.freeze({ answer: Object.freeze({ type: "number", default: 3 }) }),
    additionalProperties: false,
  });
  const before = JSON.stringify({ schema, data });
  const result = evaluate(schema, data);
  assert.equal(result.status, "invalid");
  assert.equal(JSON.stringify({ schema, data }), before);
  assert.deepEqual(evaluate(schema, data), result);
  assert.equal(evaluate({}, {}).status, "valid");
  assert.equal(evaluate({ properties: { answer: { type: "number" } } }, { output: { answer: 3 } }).status, "valid");
  assert.equal(evaluate({ required: ["answer"] }, { output: { answer: 3 } }).status, "invalid");
  assert.equal(evaluate({ type: "object" }, null).status, "invalid");
  assert.equal(evaluate(true, null).status, "valid");
  assert.equal(evaluate(false, 0).status, "invalid");
});

test("equality uses JSON values, Unicode length uses code points, and decimals are exact", () => {
  for (const [schema, data, status] of [
    [{ const: { a: 1, b: [2] } }, { b: [2], a: 1 }, "valid"],
    [{ enum: [null, { a: 1 }] }, null, "valid"],
    [{ uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }], "invalid"],
    [{ minLength: 1, maxLength: 1 }, "😀", "valid"],
    [{ multipleOf: 0.1 }, 0.3, "valid"],
    [{ multipleOf: 0.1 }, 0.30000000000000004, "invalid"],
    [{ multipleOf: 1e-300 }, 1e300, "valid"],
  ] as const) assert.equal(evaluate(schema, data as JsonValue).status, status);
});

test("long same-instance chains and repeated composition use bounded memoization", () => {
  const definitions: Record<string, unknown> = { end: { type: "number" } };
  for (let i = 0; i < 300; i++) definitions[`n${i}`] = { $ref: i === 299 ? "#/definitions/end" : `#/definitions/n${i + 1}` };
  assert.equal(evaluate({ definitions, $ref: "#/definitions/n0" }, 1).status, "valid");
  assert.equal(evaluate({ definitions, $ref: "#/definitions/n0" }, "no").status, "invalid");
  const branches: Record<string, unknown> = { end: true };
  for (let i = 30; i >= 0; i--) {
    const $ref = i === 30 ? "#/definitions/end" : `#/definitions/n${i + 1}`;
    branches[`n${i}`] = { allOf: [{ $ref }, { $ref }] };
  }
  assert.equal(evaluate({ definitions: branches, $ref: "#/definitions/n0" }, 1).status, "valid");
});

test("resource boundaries distinguish schema, verdict, and diagnostic work", () => {
  const schema = { properties: { answer: { type: "number" } } };
  const data = { answer: 1 };
  const result = evaluate(schema, data);
  assert.equal(result.status, "valid");
  const exact = { ...limits, verdict: { workLimit: result.stats.verdict.work, storageLimit: result.stats.verdict.storage } };
  assert.deepEqual(evaluate(schema, data, exact), result);
  for (const [key, code] of [["workLimit", "work-limit"], ["storageLimit", "storage-limit"]] as const) {
    const stopped = evaluate(schema, data, { ...exact, verdict: { ...exact.verdict, [key]: exact.verdict[key] - 1 } });
    assert.equal(stopped.status, "not-evaluated");
    if (stopped.status === "not-evaluated") assert.equal(stopped.diagnostic.code, code);
  }
  const deep = evaluate(true, { a: { b: 1 } }, { ...limits, maxDataDepth: 2 });
  assert.equal(deep.status, "not-evaluated");
  if (deep.status === "not-evaluated") assert.equal(deep.diagnostic.code, "data-depth-limit");
  const unsupported = evaluate({ pattern: "private" }, "private");
  assert.equal(unsupported.status, "not-evaluated");
  if (unsupported.status === "not-evaluated") assert.equal(unsupported.diagnostic.code, "unsupported-pattern");
  assert.doesNotMatch(JSON.stringify(unsupported), /private/);
});

test("formats remain visible annotations and ignored branches do not emit false issues", () => {
  const result = evaluate({ format: "email", anyOf: [false, true], if: false, then: false, else: true }, "anything");
  assert.equal(result.status, "valid");
  assert.deepEqual(result.uncheckedFormats, [{ format: "email", schemaPath: ["format"] }]);
  assert.deepEqual(result.issues, []);
  const invalid = evaluate({ anyOf: [false, false], not: true, contains: { type: "number" } }, ["x"]);
  assert.equal(invalid.status, "invalid");
  assert.deepEqual(invalid.issues.map((i) => i.keyword), ["contains", "anyOf", "not"]);
});

test("a shared schema reports each safe path and retains issues before truncation", () => {
  const schema = {
    definitions: { value: { type: "number" } },
    properties: { a: { $ref: "#/definitions/value" }, b: { $ref: "#/definitions/value" } },
  };
  const result = evaluate(schema, { a: "x", b: "x" });
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.issues.map((issue) => issue.location), [[{ property: "b" }], [{ property: "a" }]]);
  const truncated = evaluate(schema, { a: "x", b: "x" }, {
    ...limits, diagnostics: { ...limits.diagnostics, maxIssues: 1 },
  });
  assert.equal(truncated.status, "invalid");
  assert.equal(truncated.issues.length, 1);
  assert.equal(truncated.truncated, true);
  assert.deepEqual(truncated.issues, result.issues.slice(0, 1));
});

test("JSON parser number representation is used and non-finite values are rejected safely", () => {
  assert.equal(evaluate({ const: 9007199254740992 }, JSON.parse("9007199254740993")).status, "valid");
  const result = evaluate({ type: "number" }, JSON.parse("1e999"));
  assert.equal(result.status, "not-evaluated");
  if (result.status === "not-evaluated") assert.equal(result.diagnostic.code, "non-json-data");
});
