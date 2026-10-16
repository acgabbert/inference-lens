import Ajv from 'ajv';
import { cases } from './cases.mjs';
import { copyWithoutFormats } from './schema-copy.mjs';

export function run() {
  let passed = 0;
  let draft7Differences = 0;
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
  for (const [name, schema, data, expected, engineExpectations] of cases) {
    const dataBefore = JSON.stringify(data);
    const actual = ajv.compile(copyWithoutFormats(schema))(data);
    if (actual !== (engineExpectations?.ajv ?? expected)) throw new Error(`ajv: ${name}`);
    if (actual !== expected) draft7Differences++;
    if (JSON.stringify(data) !== dataBefore) throw new Error(`ajv mutation: ${name}`);
    passed++;
  }
  return { engine: 'ajv', passed, draft7Differences };
}
