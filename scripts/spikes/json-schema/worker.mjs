import { parentPort, workerData } from 'node:worker_threads';
import { prepare } from './engines.mjs';

const { engine, scenario } = workerData;
let schema;
let data;
if (scenario === 'depth-64') {
  schema = { type: 'object', properties: { next: { $ref: '#' } } };
  data = {};
  for (let i = 0; i < 63; i++) data = { next: data };
} else if (scenario === 'unique-items') {
  schema = { uniqueItems: true };
  data = Array.from({ length: 12000 }, (_, i) => ({ i }));
} else if (scenario === 'non-consuming-ref') {
  schema = { $ref: '#' };
  data = null;
} else if (scenario === 'branching-refs') {
  schema = { definitions: { leaf: true }, $ref: '#/definitions/n0' };
  for (let i = 0; i < 28; i++) {
    const ref = i === 27 ? '#/definitions/leaf' : `#/definitions/n${i + 1}`;
    schema.definitions[`n${i}`] = { allOf: [{ $ref: ref }, { $ref: ref }] };
  }
  data = null;
} else throw new Error(`Unknown scenario: ${scenario}`);
const start = performance.now();
try {
  const result = prepare(engine, schema)(data);
  parentPort.postMessage({ status: 'completed', valid: result.valid, elapsedMs: Math.round(performance.now() - start), schemaUnits: JSON.stringify(schema).length, outputUnits: JSON.stringify(data).length });
} catch (error) {
  parentPort.postMessage({ status: 'threw', errorName: error.name, elapsedMs: Math.round(performance.now() - start) });
}
