import { evaluateJsonSchema } from "../packages/core/src/json-schema/evaluator.ts";
import { SCHEMA_CHECK_LIMITS } from "../packages/core/src/json-schema/limits.ts";
import type { JsonValue } from "../packages/core/src/run-kernel/types.ts";
import { latencyWorkloads as sharedWorkloads } from "./spikes/metered-json-schema/latency-entry.mjs";

/** Candidate verdict budgets around the calibrated 750k. Schema and diagnostic limits are the calibrated ones. */
export const budgets = [250_000, 500_000, 750_000, 1_000_000, 2_000_000];

export function latencyWorkloads(): { name: string; schema: unknown; data: JsonValue }[] {
  const workloads = sharedWorkloads();
  const realistic = workloads.filter((task) => task.name.startsWith("realistic"));
  for (const task of realistic) {
    if (!Array.isArray(task.data)) throw new Error("Expected record fixtures");
    task.data = task.data.map(() => ({ answer: "A useful answer for the user.", score: 0.75 }));
  }
  let data: JsonValue = "x".repeat(10_000);
  for (let i = 1; i < 64; i++) data = { next: data };
  const branches = Array.from({ length: 64 }, (_, i) => ({ const: i }));
  const deep = (depth: number, leaf: JsonValue): JsonValue => {
    let value = leaf;
    for (let i = 1; i < depth; i++) value = [value];
    return value;
  };
  return [...workloads, { name: "large payload at depth 64", schema: true, data },
    { name: "lazy equality at depth 64", schema: { const: data }, data },
    // Calibration workloads: each stresses one charged operation.
    { name: "index only: 200k small integers", schema: true, data: Array.from({ length: 200_000 }, (_, i) => i % 10) },
    { name: "index only: 50k empty objects", schema: true, data: Array.from({ length: 50_000 }, () => ({})) },
    { name: "node visits: 100k items, type only", schema: { items: { type: "number" } }, data: Array(100_000).fill(1) },
    { name: "memo hits: anyOf of 64 refs to one definition", schema: { definitions: { n: { type: "number" } }, items: { anyOf: Array.from({ length: 64 }, () => ({ $ref: "#/definitions/n" })) } }, data: Array(5_000).fill(1) },
    { name: "branches: anyOf of 64 distinct consts", schema: { items: { anyOf: branches } }, data: Array(5_000).fill(63) },
    { name: "enum: 2k candidates", schema: { items: { enum: Array.from({ length: 2_000 }, (_, i) => `value-${i}`) } }, data: Array(200).fill("value-1999") },
    { name: "multipleOf: large decimal shift", schema: { items: { multipleOf: 1e-300 } }, data: Array(5_000).fill(1e300) },
    { name: "required: 2k keys", schema: { required: Array.from({ length: 2_000 }, (_, i) => `k${i}`) }, data: Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`k${i}`, i])) },
    { name: "propertyNames: 30k keys", schema: { propertyNames: { maxLength: 20 } }, data: Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`key-${i}`, i])) },
    { name: "uniqueItems: 100k small integers", schema: { uniqueItems: true }, data: Array.from({ length: 100_000 }, (_, i) => i) },
    { name: "uniqueItems: nested arrays at depth 16", schema: { uniqueItems: true }, data: Array.from({ length: 4_000 }, (_, i) => deep(16, i)) },
    { name: "ascii string length 1m", schema: { type: "string", maxLength: 2_000_000 }, data: "a".repeat(1_000_000) },
    { name: "plain string, no length keyword", schema: { type: "string" }, data: "a".repeat(1_000_000) },
    { name: "sorting: 900 keys, 1k-char shared prefix", schema: true, data: Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`${"p".repeat(1_000)}${899 - i}`, 0])) },
    { name: "enum: 50 candidates, 1k-char shared prefix", schema: { items: { enum: Array.from({ length: 50 }, (_, i) => `${"x".repeat(1_000)}${i}`) } }, data: Array(500).fill(`${"x".repeat(1_000)}49`) },
    { name: "uniqueItems: 900 strings, 1k-char shared prefix", schema: { uniqueItems: true }, data: Array.from({ length: 900 }, (_, i) => `${"u".repeat(1_000)}${i}`) },
    { name: "diagnostics: 100k failing nested items", schema: { items: { properties: { a: { type: "string" } } } }, data: Array.from({ length: 100_000 }, () => ({ a: 1 })) },
  ];
}

export function measure({ samples = 15, warmups = 3 } = {}) {
  if (!Number.isSafeInteger(samples) || samples < 1 || !Number.isSafeInteger(warmups) || warmups < 0) {
    throw new Error("Invalid sample counts");
  }
  const results = [];
  for (const task of latencyWorkloads()) {
    const schemaText = JSON.stringify(task.schema);
    const outputText = JSON.stringify(task.data);
    for (const workLimit of budgets) {
      const times: number[] = [];
      let expected: string | undefined;
      let firstMs = 0;
      for (let i = 0; i < samples + warmups; i++) {
        const start = performance.now();
        const result = evaluateJsonSchema(JSON.parse(schemaText), JSON.parse(outputText), {
          // Depth 65 admits the `const` wrapper around the depth-64 equality fixture.
          schema: { ...SCHEMA_CHECK_LIMITS.schema, maxDepth: 65 },
          verdict: { ...SCHEMA_CHECK_LIMITS.verdict, workLimit },
          diagnostics: SCHEMA_CHECK_LIMITS.diagnostics,
          maxDataDepth: SCHEMA_CHECK_LIMITS.maxDataDepth,
        });
        const elapsed = performance.now() - start;
        const serialized = JSON.stringify(result);
        if (expected !== undefined && serialized !== expected) throw new Error(`Nondeterministic result: ${task.name}`);
        expected = serialized;
        if (i === 0) firstMs = elapsed;
        if (i >= warmups) times.push(elapsed);
      }
      times.sort((a, b) => a - b);
      const result = JSON.parse(expected!);
      const stats = result.stats;
      results.push({ name: task.name, workLimit, schemaUnits: schemaText.length, outputUnits: outputText.length,
        status: result.status, code: result.diagnostic?.code ?? null, stats,
        firstMs, medianMs: times[Math.floor(times.length / 2)],
        p95Ms: times[Math.ceil(times.length * 0.95) - 1], maxMs: times[times.length - 1],
      });
    }
  }
  return { samples, warmups, results };
}
