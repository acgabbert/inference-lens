import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from './evaluator.mjs';
import { cases } from '../json-schema/cases.mjs';

const dag = { definitions: { leaf: true }, $ref: '#/definitions/n0' };
for (let i = 0; i < 28; i++) {
  const ref = i === 27 ? '#/definitions/leaf' : `#/definitions/n${i + 1}`;
  dag.definitions[`n${i}`] = { allOf: [{ $ref: ref }, { $ref: ref }] };
}

test('a deterministic work limit stops an otherwise valid answer', () => {
  const result = evaluate({ items: { type: 'number' } }, [1, 2, 3], { workLimit: 1 });
  assert.equal(result.status, 'not-evaluated');
  assert.equal(result.code, 'work-limit');
});

test('the authored profile matrix and caller-owned frozen schemas', () => {
  for (const [name, schema, data, expected] of cases) {
    const frozenSchema = deepFreeze(structuredClone(schema));
    const frozenData = deepFreeze(structuredClone(data));
    const result = evaluate(frozenSchema, frozenData);
    assert.equal(result.status, expected ? 'valid' : 'invalid', `${name}: ${JSON.stringify(result)}`);
  }
});

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('memoization bounds branching references without a clock', () => {
  const result = evaluate(dag, null);
  assert.equal(result.status, 'valid');
  assert.ok(result.work < 20000, JSON.stringify(result));
  assert.ok(result.memoHits >= 27, JSON.stringify(result));
});

test('non-consuming cycles are rejected even in unused definitions', () => {
  for (const schema of [
    { $ref: '#' },
    { definitions: { unused: { allOf: [{ $ref: '#/definitions/unused' }] } } },
    { dependencies: { a: { $ref: '#' } } },
    { if: { $ref: '#' }, then: true },
  ]) {
    assert.equal(evaluate(schema, {}).code, 'non-consuming-cycle');
  }
});

test('consuming recursion is accepted and its mismatch has a safe location', () => {
  const schema = { type: 'object', properties: { next: { $ref: '#' } } };
  let data = {};
  for (let i = 0; i < 63; i++) data = { next: data };
  assert.equal(evaluate(schema, data).status, 'valid');
  const mismatch = evaluate(schema, { next: 1 });
  assert.equal(mismatch.status, 'invalid');
  assert.deepEqual(mismatch.issues, [{ keyword: 'type', location: [{ property: 'next' }] }]);
});

test('canonical uniqueness handles key order, numeric equality and array order', () => {
  for (const data of [[{ a: 1, b: 2 }, { b: 2, a: 1 }], [0, -0], [1, 1.0], [[1, 2], [1, 2]]]) {
    assert.equal(evaluate({ uniqueItems: true }, data).status, 'invalid');
  }
  assert.equal(evaluate({ uniqueItems: true }, [[1, 2], [2, 1]]).status, 'valid');
  const data = Array.from({ length: 12000 }, (_, i) => ({ i }));
  const result = evaluate({ uniqueItems: true }, data);
  assert.equal(result.status, 'valid', JSON.stringify(result));
  const doubled = evaluate({ uniqueItems: true }, [...data, ...data.map(({ i }) => ({ i: i + 12000 }))]);
  assert.equal(doubled.status, 'valid', JSON.stringify(doubled));
  assert.ok(doubled.work < result.work * 2.5, `${result.work} -> ${doubled.work}`);
});

test('budget outcomes and counts are independent of previous evaluations', () => {
  const schema = { items: { type: 'number' } };
  const data = Array(100).fill('private');
  const before = evaluate(schema, data, { workLimit: 500 });
  evaluate(schema, data);
  assert.deepEqual(evaluate(schema, data, { workLimit: 500 }), before);
  assert.equal(before.code, 'work-limit');
  const storage = evaluate(schema, data, { storageLimit: 10 });
  assert.equal(storage.code, 'storage-limit');
});

test('diagnostics are bounded and redact map keys, including cached references', () => {
  const schema = { definitions: { value: { type: 'number' } }, additionalProperties: { $ref: '#/definitions/value' } };
  const data = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`secret-${i}`, 'provider-value']));
  const result = evaluate(schema, data, { maxIssues: 3 });
  assert.equal(result.status, 'invalid');
  assert.equal(result.issues.length, 3);
  assert.equal(result.truncated, true);
  assert.ok(result.issues.every(({ location }) => location[0].redacted === true));
  assert.ok(!JSON.stringify(result).includes('secret-'));
  assert.ok(!JSON.stringify(result).includes('provider-value'));
});

test('preflight rejects unsupported assertions, malformed schemas and missing refs', () => {
  for (const schema of [{ pattern: 'x' }, { patternProperties: {} }, { unknownAssertion: true }, { $id: 'x' }, { $schema: 'https://json-schema.org/draft/2020-12/schema' }]) {
    assert.equal(evaluate(schema, {}).code, 'unsupported-schema');
  }
  for (const schema of [{ maximum: 'invalid' }, { type: 'bogus' }, { required: [1] }, { properties: { x: 1 } }, { anyOf: [] }]) {
    assert.equal(evaluate(schema, {}).code, 'invalid-schema');
  }
  assert.equal(evaluate({ properties: { absent: { $ref: '#/missing' } } }, {}).code, 'unresolved-ref');
});

test('format annotations and schema keywords inside literals are preserved', () => {
  const schema = { properties: { date: { format: 'date-time' } }, const: { date: 'invalid', pattern: 'literal' } };
  assert.equal(evaluate(schema, { date: 'invalid', pattern: 'literal' }).status, 'valid');
});

test('budgets have exact deterministic boundaries', () => {
  const schema = { properties: { answer: { type: 'number' } } };
  const data = { answer: 3 };
  const result = evaluate(schema, data);
  assert.equal(result.status, 'valid');
  assert.deepEqual(evaluate(schema, data, { workLimit: result.work, storageLimit: result.storage }), result);
  assert.equal(evaluate(schema, data, { workLimit: result.work - 1 }).code, 'work-limit');
  assert.equal(evaluate(schema, data, { storageLimit: result.storage - 1 }).code, 'storage-limit');
});

test('failed branching references cannot expand diagnostic trees exponentially', () => {
  const schema = structuredClone(dag);
  schema.definitions.leaf = false;
  const result = evaluate(schema, null);
  assert.equal(result.status, 'invalid');
  assert.ok(result.work < 20000, JSON.stringify(result));
  assert.deepEqual(result.issues, [{ keyword: 'false', location: [] }]);
  assert.equal(result.truncated, false);
});

test('a shared boolean memo cannot confer schema ownership on a map location', () => {
  const ref = { $ref: '#/definitions/n' };
  const schema = {
    definitions: { n: { type: 'number' } },
    allOf: [{ properties: { answer: ref } }, { additionalProperties: ref }],
  };
  const result = evaluate(schema, { answer: 'provider' });
  assert.equal(result.status, 'invalid');
  assert.ok(result.issues.some(({ location }) => location[0]?.property === 'answer'));
  assert.ok(result.issues.some(({ location }) => location[0]?.redacted === true));
  assert.ok(!JSON.stringify(result).includes('provider'));
});

test('canonical encodings preserve structure and own special property names', () => {
  const schema = { uniqueItems: true };
  assert.equal(evaluate(schema, [['a,b', 'c'], ['a', 'b,c']]).status, 'valid');
  assert.equal(evaluate(schema, [{ a: ['x', { b: 2, c: 3 }] }, { a: ['x', { c: 3, b: 2 }] }]).status, 'invalid');
  assert.equal(evaluate({ properties: JSON.parse('{"__proto__":{"type":"number"}}') }, JSON.parse('{"__proto__":"bad"}')).status, 'invalid');
  assert.equal(evaluate(schema, [JSON.parse('{"__proto__":1}'), {}]).status, 'valid');
});

test('long acyclic reference chains exhaust a deterministic stack allowance', () => {
  const schema = { definitions: { leaf: true }, $ref: '#/definitions/n0' };
  for (let i = 0; i < 160; i++) schema.definitions[`n${i}`] = { $ref: i === 159 ? '#/definitions/leaf' : `#/definitions/n${i + 1}` };
  assert.equal(evaluate(schema, null).code, 'evaluation-depth-limit');
});

test('input and schema validation limits are explicit and formats are annotations', () => {
  assert.equal(evaluate({ enum: [1, 1] }, 1).code, 'invalid-schema');
  assert.equal(evaluate({ title: 1 }, null).code, 'invalid-schema');
  assert.equal(evaluate({}, 'a'.repeat(1_000_000)).code, 'input-limit');
  assert.equal(evaluate({ description: 'a'.repeat(65536) }, null).code, 'input-limit');
  assert.deepEqual(evaluate({ format: 'date-time' }, 'bad').uncheckedFormats, ['date-time']);
  assert.equal(evaluate({}, undefined).code, 'non-json-input');
  let data = {};
  for (let i = 0; i < 64; i++) data = { next: data };
  assert.equal(evaluate({}, data).code, 'input-limit');
});
