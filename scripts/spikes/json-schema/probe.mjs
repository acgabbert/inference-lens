import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { Validator } from '@cfworker/json-schema';
import { cases } from './cases.mjs';
import { prepare, runCases } from './engines.mjs';

// Dangerous workloads run in disposable workers. A Promise timeout on the same
// thread cannot interrupt a synchronous validator.
function adversarial(engine, scenario) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { engine, scenario }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    const timer = setTimeout(async () => {
      await worker.terminate();
      resolve({ engine, scenario, status: 'terminated', budgetMs: 1500 });
    }, 1500);
    worker.once('message', async (result) => {
      clearTimeout(timer);
      await worker.terminate();
      resolve({ engine, scenario, ...result });
    });
    worker.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

for (const engine of ['cfworker', 'ajv']) {
  assert.equal(runCases(engine, cases).length, cases.length);
  console.log(`${engine}: ${cases.length} characterization cases passed (including nonmutation; see recorded draft-07 divergence).`);
  const formatSchema = { properties: { date: { type: 'string', format: 'date-time' } }, const: { date: 'invalid' } };
  assert.equal(prepare(engine, formatSchema)({ date: 'invalid' }).valid, true);
  const many = Array(1000).fill('invalid');
  const schema = { items: { type: 'number' } };
  const first = prepare(engine, schema, { allErrors: false })(many);
  const all = prepare(engine, schema)(many);
  assert.equal(first.valid, false);
  assert.equal(all.valid, false);
  assert.ok(all.errors.length >= 1000);
  console.log(JSON.stringify({ engine, firstErrorCount: first.errors.length, allErrorCount: all.errors.length }));
  // Engine error messages and instance paths are deliberately kept out of output.
  for (const scenario of ['depth-64', 'unique-items', 'non-consuming-ref', 'branching-refs']) console.log(JSON.stringify(await adversarial(engine, scenario)));
}
const rawSchema = { properties: { date: { format: 'date-time' } } };
const raw = new Validator(rawSchema, '7');
assert.equal(raw.validate({ date: 'invalid' }).valid, false);
assert.ok(Object.hasOwn(rawSchema, '__absolute_uri__'));
assert.throws(() => new Validator(Object.freeze({ type: 'number' }), '7'), TypeError);
console.log('cfworker defaults assert formats and mutate schema metadata; a private schema copy is required.');

// These are raw engine observations, not the application's acceptance policy.
// They establish why a schema preflight and diagnostic sanitizer are necessary.
for (const engine of ['cfworker', 'ajv']) {
  assert.equal(prepare(engine, { unknownAssertion: true })(1).valid, true);
  assert.equal(prepare(engine, { pattern: '^a' })('b').valid, false);
  const rawErrors = prepare(engine, { additionalProperties: false })({ providerDerivedKey: 1 }).errors;
  assert.ok(JSON.stringify(rawErrors).includes('providerDerivedKey'));
}
assert.equal(new Validator({ maximum: 'invalid' }, '7').validate(1).valid, true);
assert.equal(new Validator({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'number' }, '7').validate(1).valid, true);
const unresolved = new Validator({ properties: { absent: { $ref: '#/missing' } } }, '7');
assert.equal(unresolved.validate({}).valid, true);
assert.throws(() => unresolved.validate({ absent: 1 }));
console.log('Raw engines require profile enforcement and safe diagnostics; cfworker also requires meta-validation and eager reference checks.');
