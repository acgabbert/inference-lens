import { evaluate } from './evaluator.mjs';

// Benchmark-only candidates; these do not select product limits.
export const budgets = [100_000, 250_000, 500_000, 1_000_000, 2_000_000, 4_000_000];

export function latencyWorkloads() {
  const row = { type: 'object', required: ['answer', 'score'], properties: {
    answer: { type: 'string' }, score: { type: 'number', minimum: 0, maximum: 1 },
  }, additionalProperties: false };
  return [
    { name: 'realistic 100 records', schema: { items: row }, data: Array.from({ length: 100 }, () => ({ answer: 'A useful answer', score: 0.75 })) },
    { name: 'realistic 1000 records', schema: { items: row }, data: Array.from({ length: 1000 }, () => ({ answer: 'A useful answer', score: 0.75 })) },
    { name: 'number traversal', schema: { items: { allOf: [{ type: 'number' }, { minimum: 0 }, { maximum: 10 }] } }, data: Array(100_000).fill(1) },
    { name: 'invalid item diagnostics', schema: { items: { type: 'number' } }, data: Array(100_000).fill('x') },
    { name: 'unique objects', schema: { uniqueItems: true }, data: Array.from({ length: 45_000 }, (_, i) => ({ i })) },
    { name: 'long unicode string', schema: { type: 'string', minLength: 1 }, data: '😀'.repeat(240_000) },
    { name: 'wide object sorting', schema: true, data: Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`key-${30_000 - i}`, i])) },
    { name: 'schema preflight', schema: { definitions: Object.fromEntries(Array.from({ length: 1700 }, (_, i) => [`d${i}`, { type: 'number' }])) }, data: null },
  ];
}

export function measure({ samples = 15, warmups = 3 } = {}) {
  if (!Number.isSafeInteger(samples) || samples < 1 || !Number.isSafeInteger(warmups) || warmups < 0) throw new Error('Invalid sample counts');
  const results = [];
  // Build and serialize fixtures outside the timed region. Each timed call
  // includes original-text parsing and all evaluator indexing/preflight work.
  for (const task of latencyWorkloads()) {
    const schemaText = JSON.stringify(task.schema);
    const outputText = JSON.stringify(task.data);
    for (const workLimit of budgets) {
      const times = [];
      let expected;
      let firstMs;
      for (let i = 0; i < samples + warmups; i++) {
        const start = performance.now();
        const result = evaluate(JSON.parse(schemaText), JSON.parse(outputText), { workLimit });
        const elapsed = performance.now() - start;
        // A timing observation must never affect the evaluator's result.
        const serialized = JSON.stringify(result);
        if (expected !== undefined && serialized !== expected) throw new Error(`Nondeterministic result: ${task.name}`);
        expected = serialized;
        if (i === 0) firstMs = elapsed;
        if (i >= warmups) times.push(elapsed);
      }
      times.sort((a, b) => a - b);
      const result = JSON.parse(expected);
      results.push({ name: task.name, workLimit, schemaUnits: schemaText.length, outputUnits: outputText.length,
        status: result.status, code: result.code ?? null, work: result.work, storage: result.storage,
        workFraction: result.work / workLimit, firstMs,
        medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1], maxMs: times.at(-1),
      });
    }
  }
  return { samples, warmups, results };
}
