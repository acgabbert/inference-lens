import { Validator } from '@cfworker/json-schema';
import { cases } from './cases.mjs';
import { copyWithoutFormats } from './schema-copy.mjs';

export function run() {
  let passed = 0;
  for (const [name, schema, data, expected] of cases) {
    const dataBefore = JSON.stringify(data);
    const validator = new Validator(copyWithoutFormats(schema), '7', false);
    if (validator.validate(data).valid !== expected) throw new Error(`cfworker: ${name}`);
    if (JSON.stringify(data) !== dataBefore) throw new Error(`cfworker mutation: ${name}`);
    passed++;
  }
  return { engine: 'cfworker', passed, draft7Differences: 0 };
}
