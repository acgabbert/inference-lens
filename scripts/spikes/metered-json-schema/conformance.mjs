import assert from 'node:assert/strict';
import { evaluate } from './evaluator.mjs';
import { loadOfficial } from './load-official.mjs';

const { tasks, excluded, revision } = await loadOfficial();
const failures = [];
for (const { name, schema, data, expected } of tasks) {
  const result = evaluate(schema, data);
  if (result.status !== expected) failures.push({ name, expected, result });
}
console.log(JSON.stringify({ revision, passed: tasks.length - failures.length, excluded, failures }, null, 2));
assert.deepEqual(failures, []);
assert.equal(tasks.length, 807, 'Update the reviewed manifest and count deliberately');
