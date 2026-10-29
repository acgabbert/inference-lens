import { cases } from '../json-schema/cases.mjs';

export function workloads() {
  const dag = { definitions: { leaf: true }, $ref: '#/definitions/n0' };
  for (let i = 0; i < 28; i++) {
    const ref = i === 27 ? '#/definitions/leaf' : `#/definitions/n${i + 1}`;
    dag.definitions[`n${i}`] = { allOf: [{ $ref: ref }, { $ref: ref }] };
  }
  const failedDag = structuredClone(dag);
  failedDag.definitions.leaf = false;
  const chain = { definitions: { leaf: true }, $ref: '#/definitions/n0' };
  for (let i = 0; i < 160; i++) chain.definitions[`n${i}`] = { $ref: i === 159 ? '#/definitions/leaf' : `#/definitions/n${i + 1}` };
  let recursive = {};
  for (let i = 0; i < 63; i++) recursive = { next: recursive };
  const map = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`private-${i}`, 'private-value']));
  return [
    ...cases.map(([name, schema, data, valid]) => ({ name, schema, data, expected: valid ? 'valid' : 'invalid' })),
    { name: 'branching refs', schema: dag, data: null, expected: 'valid' },
    { name: 'non-consuming ref', schema: { $ref: '#' }, data: null, expected: 'not-evaluated', code: 'non-consuming-cycle' },
    { name: 'consuming recursion depth 64', schema: { type: 'object', properties: { next: { $ref: '#' } } }, data: recursive, expected: 'valid' },
    { name: 'unique 12000 objects', schema: { uniqueItems: true }, data: Array.from({ length: 12000 }, (_, i) => ({ i })), expected: 'valid' },
    { name: 'work limit', schema: { items: { type: 'number' } }, data: Array(100).fill(1), options: { workLimit: 500 }, expected: 'not-evaluated', code: 'work-limit' },
    { name: 'storage limit', schema: { items: { type: 'number' } }, data: Array(100).fill(1), options: { storageLimit: 10 }, expected: 'not-evaluated', code: 'storage-limit' },
    { name: 'bounded redacted diagnostics', schema: { additionalProperties: { type: 'number' } }, data: map, options: { maxIssues: 3 }, expected: 'invalid' },
    { name: 'failed branching refs', schema: failedDag, data: null, expected: 'invalid' },
    { name: 'long acyclic chain', schema: chain, data: null, expected: 'not-evaluated', code: 'evaluation-depth-limit' },
    { name: 'shared memo with different safe paths', schema: { definitions: { n: { type: 'number' } }, allOf: [{ properties: { answer: { $ref: '#/definitions/n' } } }, { additionalProperties: { $ref: '#/definitions/n' } }] }, data: { answer: 'private-value' }, expected: 'invalid' },
    { name: 'exact work boundary', schema: true, data: null, options: { workLimit: 14 }, expected: 'valid' },
    { name: 'below work boundary', schema: true, data: null, options: { workLimit: 13 }, expected: 'not-evaluated', code: 'work-limit' },
    { name: 'exact storage boundary', schema: true, data: null, options: { storageLimit: 37 }, expected: 'valid' },
    { name: 'below storage boundary', schema: true, data: null, options: { storageLimit: 36 }, expected: 'not-evaluated', code: 'storage-limit' },
    { name: 'zero issue budget', schema: false, data: null, options: { maxIssues: 0 }, expected: 'invalid' },
    { name: 'format annotation', schema: { format: 'date-time' }, data: 'invalid', expected: 'valid' },
  ];
}
