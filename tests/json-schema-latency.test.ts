import assert from "node:assert/strict";
import test from "node:test";
import { budgets, latencyWorkloads, measure } from "../scripts/json-schema-latency-entry.ts";

test("the production latency probe exercises realistic, deep, and equality inputs with deterministic accounting", () => {
  const tasks = latencyWorkloads();
  const records = tasks.find((task) => task.name === "realistic 1000 records")!.data;
  assert.ok(Array.isArray(records));
  assert.equal(records.length, 1000);
  const report = measure({ samples: 2, warmups: 0 });
  assert.equal(report.results.length, tasks.length * budgets.length);
  for (const result of report.results) {
    for (const time of [result.firstMs, result.medianMs, result.p95Ms, result.maxMs]) assert.ok(Number.isFinite(time) && time >= 0);
    assert.ok(result.medianMs <= result.p95Ms && result.p95Ms <= result.maxMs);
    if (result.name === "realistic 1000 records" && result.workLimit >= 250_000) {
      assert.equal(result.status, "valid");
      assert.equal(result.outputUnits, 56_001);
    }
    if (result.name === "large payload at depth 64") assert.equal(result.status, "valid");
    if (result.name === "lazy equality at depth 64" && result.workLimit >= 750_000) assert.equal(result.status, "valid");
  }
  assert.throws(() => measure({ samples: 0 }), /Invalid sample counts/);
});
