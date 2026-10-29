import assert from "node:assert/strict";
import test from "node:test";

import { evaluateJsonSchema } from "../packages/core/src/json-schema/evaluator.ts";
import { MAX_SCHEMA_OUTPUT_CODE_UNITS, SCHEMA_CHECK_LIMITS } from "../packages/core/src/json-schema/limits.ts";
import { preflightJsonSchema } from "../packages/core/src/json-schema/preflight.ts";
import type { JsonValue } from "../packages/core/src/run-kernel/types.ts";

/** Fill an array with copies of `unit` until its compact JSON reaches `units` code units. */
function dense(unit: JsonValue, units: number): JsonValue[] {
  const width = JSON.stringify(unit).length + 1;
  return Array(Math.floor((units - 2) / width) + 1).fill(unit);
}

// The densest answers per code unit found during calibration: one JSON value
// per two code units, or one empty container per three.
const densest: [string, JsonValue][] = [
  ["single-digit integers", dense(0, MAX_SCHEMA_OUTPUT_CODE_UNITS)],
  ["empty arrays", dense([], MAX_SCHEMA_OUTPUT_CODE_UNITS)],
  ["empty objects", dense({}, MAX_SCHEMA_OUTPUT_CODE_UNITS)],
  ["one-character keys", Object.fromEntries(Array.from({ length: Math.floor(MAX_SCHEMA_OUTPUT_CODE_UNITS / 9) }, (_, i) => [i.toString(36), 0]))],
];

// Indexing cost follows value count, not characters, so the densest answers
// leave the least headroom. Their validation can still exhaust the budget under
// a per-item schema; realistic answers keep at least half (next test).
test("every answer within the output limit indexes with a quarter of the verdict budget to spare", () => {
  for (const [name, data] of densest) {
    assert.ok(JSON.stringify(data).length <= MAX_SCHEMA_OUTPUT_CODE_UNITS + 2, name);
    const result = evaluateJsonSchema(true, data, SCHEMA_CHECK_LIMITS);
    assert.equal(result.status, "valid", `${name}: ${JSON.stringify(result)}`);
    assert.ok(
      result.stats.verdict.work <= SCHEMA_CHECK_LIMITS.verdict.workLimit * 0.75,
      `${name}: indexing used ${result.stats.verdict.work} of ${SCHEMA_CHECK_LIMITS.verdict.workLimit} work units`,
    );
  }
});

test("realistic structured answers at the output limit validate within budget", () => {
  const row = { answer: "A useful answer for the user.", score: 0.75 };
  const data = dense(row, MAX_SCHEMA_OUTPUT_CODE_UNITS);
  const schema = {
    type: "array",
    items: {
      type: "object", required: ["answer", "score"], additionalProperties: false,
      properties: { answer: { type: "string" }, score: { type: "number", minimum: 0, maximum: 1 } },
    },
  };
  const result = evaluateJsonSchema(schema, data, SCHEMA_CHECK_LIMITS);
  assert.equal(result.status, "valid", JSON.stringify(result.stats));
  assert.ok(result.stats.verdict.work <= SCHEMA_CHECK_LIMITS.verdict.workLimit / 2, `used ${result.stats.verdict.work}`);
});

/** Four-character keys keep every entry the same width, so the schema size is exact. */
function definitions(body: unknown, units: number): unknown {
  const width = `"0000":${JSON.stringify(body)},`.length;
  const count = Math.floor((units - 20) / width);
  return { definitions: Object.fromEntries(Array.from({ length: count }, (_, i) => [i.toString(36).padStart(4, "0"), body])) };
}

test("every schema within the size limit preflights within the schema budget", () => {
  const units = SCHEMA_CHECK_LIMITS.schema.maxSchemaCodeUnits - 16;
  const schemas: [string, unknown][] = [
    ["allOf of empty schemas", { allOf: dense({}, units - 12) }],
    ["allOf of boolean schemas", { allOf: dense(true, units - 12) }],
    ["definitions of empty schemas", definitions({}, units)],
    ["definitions of negations", definitions({ not: {} }, units)],
    ["enum of integers", { enum: Array.from({ length: Math.floor(units / 6) }, (_, i) => i) }],
  ];
  for (const [name, schema] of schemas) {
    assert.ok(JSON.stringify(schema).length <= SCHEMA_CHECK_LIMITS.schema.maxSchemaCodeUnits, name);
    const result = preflightJsonSchema(schema, SCHEMA_CHECK_LIMITS.schema);
    assert.equal(result.status, "ready", `${name}: ${JSON.stringify(result.status === "ready" ? result.stats : result.diagnostic)} ${JSON.stringify(result.stats)}`);
  }
});
