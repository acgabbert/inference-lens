// Private spike adapters, not portable check contracts or a schema preflight.
// The caller supplies JSON fixtures; only schema positions are traversed so
// literal values inside const, enum, examples and default stay intact.
export function copyWithoutFormats(schema) {
  if (typeof schema === 'boolean') return schema;
  const result = structuredClone(schema);
  delete result.format;
  for (const key of ['additionalItems', 'items', 'contains', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else']) {
    if (result[key] !== undefined && !Array.isArray(result[key])) result[key] = copyWithoutFormats(result[key]);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'items']) {
    if (Array.isArray(result[key])) result[key] = result[key].map(copyWithoutFormats);
  }
  for (const key of ['properties', 'definitions', '$defs', 'dependencies']) {
    if (result[key]) {
      for (const name of Object.keys(result[key])) {
        if (!Array.isArray(result[key][name])) result[key][name] = copyWithoutFormats(result[key][name]);
      }
    }
  }
  return result;
}
