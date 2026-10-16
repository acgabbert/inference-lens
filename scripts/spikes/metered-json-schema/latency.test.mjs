import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from './evaluator.mjs';
import { budgets, latencyWorkloads, measure } from './latency-entry.mjs';

test('latency fixtures reach candidate work ceilings and cover realistic valid answers', () => {
  const tasks = latencyWorkloads();
  for (const workLimit of budgets) {
    const results = tasks.map(({ schema, data }) => evaluate(schema, data, { workLimit }));
    assert.ok(results.some((r) => r.code === 'work-limit' && r.work >= workLimit * 0.99), `No full-budget fixture at ${workLimit}`);
    assert.equal(results[0].status, 'valid');
    if (workLimit >= 250_000) assert.equal(results[1].status, 'valid');
  }
  for (const { name, schema, data } of tasks) {
    assert.ok(JSON.stringify(schema).length <= 65_536, name);
    assert.ok(JSON.stringify(data).length <= 1_000_000, name);
    const result = evaluate(schema, data, { workLimit: 20_000_000, storageLimit: 20_000_000 });
    assert.equal(result.status, name === 'invalid item diagnostics' ? 'invalid' : 'valid', name);
  }
});

test('measurement includes sample counts and ordered finite timing summaries', () => {
  const report = measure({ samples: 2, warmups: 0 });
  assert.equal(report.samples, 2);
  assert.equal(report.warmups, 0);
  assert.equal(report.results.length, budgets.length * latencyWorkloads().length);
  for (const result of report.results) {
    for (const key of ['firstMs', 'medianMs', 'p95Ms', 'maxMs']) assert.ok(Number.isFinite(result[key]) && result[key] >= 0);
    assert.ok(result.medianMs <= result.p95Ms && result.p95Ms <= result.maxMs);
  }
  assert.throws(() => measure({ samples: 0 }), /Invalid sample counts/);
});
