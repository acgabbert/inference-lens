import { evaluateJsonSchema } from "../packages/core/src/json-schema/evaluator.ts";
import type { JsonValue } from "../packages/core/src/run-kernel/types.ts";
import { latencyWorkloads as sharedWorkloads } from "./spikes/metered-json-schema/latency-entry.mjs";

/** Measurement candidates only; these do not select portable check limits. */
export const budgets = [100_000, 250_000, 500_000, 1_000_000, 2_000_000, 4_000_000];

export function latencyWorkloads(): { name: string; schema: unknown; data: JsonValue }[] {
  const workloads = sharedWorkloads();
  const realistic = workloads.filter((task) => task.name.startsWith("realistic"));
  for (const task of realistic) {
    if (!Array.isArray(task.data)) throw new Error("Expected record fixtures");
    task.data = task.data.map(() => ({ answer: "A useful answer for the user.", score: 0.75 }));
  }
  let data: JsonValue = "x".repeat(10_000);
  for (let i = 1; i < 64; i++) data = { next: data };
  return [...workloads, { name: "large payload at depth 64", schema: true, data },
    { name: "lazy equality at depth 64", schema: { const: data }, data }];
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
          schema: { workLimit, storageLimit: 20_000_000, maxSchemaCodeUnits: 65_536, maxDepth: 65 },
          verdict: { workLimit, storageLimit: 20_000_000 },
          diagnostics: { workLimit: 100_000, storageLimit: 1_000_000, maxIssues: 20 },
          maxDataDepth: 64,
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
