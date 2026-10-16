import { Validator } from '@cfworker/json-schema';
import Ajv from 'ajv';

import { copyWithoutFormats } from './schema-copy.mjs';

export function prepare(engine, schema, { allErrors = true, annotationFormats = true } = {}) {
  const privateSchema = annotationFormats ? copyWithoutFormats(schema) : structuredClone(schema);
  if (engine === 'cfworker') {
    const validator = new Validator(privateSchema, '7', !allErrors);
    return (data) => validator.validate(data);
  }
  const ajv = new Ajv({ strict: false, allErrors, validateFormats: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
  const validate = ajv.compile(privateSchema);
  return (data) => ({ valid: validate(data), errors: validate.errors ?? [] });
}

export function runCases(engine, cases) {
  return cases.map(([name, schema, data, expected, engineExpectations]) => {
    const beforeSchema = JSON.stringify(schema);
    const beforeData = JSON.stringify(data);
    const result = prepare(engine, schema)(data);
    const observedExpectation = engineExpectations?.[engine] ?? expected;
    if (result.valid !== observedExpectation) throw new Error(`${engine}: ${name}: expected ${observedExpectation}, got ${result.valid}`);
    if (JSON.stringify(schema) !== beforeSchema || JSON.stringify(data) !== beforeData) throw new Error(`${engine}: ${name}: mutated fixture`);
    return name;
  });
}
