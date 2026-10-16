import { evaluateJsonSchema, type SchemaEvaluationLimits } from "../packages/core/src/json-schema/evaluator.ts";
import type { JsonValue } from "../packages/core/src/run-kernel/types.ts";
import { latencyWorkloads } from "./json-schema-latency-entry.ts";

/**
 * Charge calibration. Each workload stresses one charged operation, so the
 * nanoseconds-per-work-unit spread shows which charges are under- or
 * over-priced. Parsing is timed separately: it is bounded by the output limit,
 * not by the work meter. Timing never reaches an evaluator result.
 */
export interface CalibrationWorkload { name: string; schema: unknown; data: JsonValue }

const generous: SchemaEvaluationLimits = {
  schema: { workLimit: 50_000_000, storageLimit: 200_000_000, maxSchemaCodeUnits: 65_536, maxDepth: 65 },
  verdict: { workLimit: 50_000_000, storageLimit: 200_000_000 },
  diagnostics: { workLimit: 50_000_000, storageLimit: 200_000_000, maxIssues: 20 },
  maxDataDepth: 64,
};

export function calibrationWorkloads(): CalibrationWorkload[] {
  return latencyWorkloads();
}

export function calibrate({ samples = 9, warmups = 3 } = {}) {
  const results = [];
  for (const task of calibrationWorkloads()) {
    const schemaText = JSON.stringify(task.schema);
    const outputText = JSON.stringify(task.data);
    const parseTimes: number[] = [];
    const evalTimes: number[] = [];
    let expected: string | undefined;
    for (let i = 0; i < samples + warmups; i++) {
      let start = performance.now();
      const schema = JSON.parse(schemaText);
      const data = JSON.parse(outputText);
      const parsed = performance.now();
      const result = evaluateJsonSchema(schema, data, generous);
      const end = performance.now();
      const serialized = JSON.stringify(result);
      if (expected !== undefined && serialized !== expected) throw new Error(`Nondeterministic result: ${task.name}`);
      expected = serialized;
      if (i >= warmups) { parseTimes.push(parsed - start); evalTimes.push(end - parsed); }
      start = end;
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const result = JSON.parse(expected!);
    const work = result.stats.preflight.work + result.stats.verdict.work + result.stats.diagnostics.work;
    const evalMs = median(evalTimes);
    results.push({
      name: task.name, status: result.status, code: result.diagnostic?.code ?? null,
      outputUnits: outputText.length, schemaUnits: schemaText.length,
      work, preflightWork: result.stats.preflight.work, verdictWork: result.stats.verdict.work,
      diagnosticWork: result.stats.diagnostics.work, parseMs: median(parseTimes), evalMs,
      nsPerUnit: work > 0 ? (evalMs * 1e6) / work : null,
    });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = calibrate();
  for (const row of rows) {
    console.log(`${row.name.padEnd(48)} ${String(row.status).padEnd(13)} work ${String(row.work).padStart(10)}  eval ${row.evalMs.toFixed(2).padStart(8)} ms  ${row.nsPerUnit?.toFixed(1).padStart(7)} ns/unit  parse ${row.parseMs.toFixed(2)} ms`);
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows));
}
