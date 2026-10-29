import { Stop, canonical } from './resources.mjs';

const annotations = new Set(['title', 'description', 'examples', 'default', '$comment', 'readOnly', 'writeOnly', 'format']);
const singles = ['additionalItems', 'contains', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else'];
const lists = ['allOf', 'anyOf', 'oneOf'];
const maps = ['properties', 'definitions', '$defs'];
const numeric = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const counts = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];
const allowed = new Set([...annotations, ...singles, ...lists, ...maps, ...numeric, ...counts, '$schema', '$ref', 'type', 'const', 'enum', 'required', 'dependencies', 'items', 'uniqueItems']);
const types = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function preflight(index, meter) {
  const graph = new Map();
  const pending = [];
  const formats = new Set();
  function register(node) {
    if (node.kind !== 'object' && node.kind !== 'boolean') throw new Stop('invalid-schema');
    if (!graph.has(node.id)) {
      meter.work(); meter.retain(8);
      graph.set(node.id, { node, edges: [], same: [] });
      pending.push(node);
    }
    return node.id;
  }
  function sub(record, child, same) {
    const id = register(child);
    meter.work(); meter.retain(2);
    record.edges.push(id);
    if (same) record.same.push(id);
    return id;
  }
  function stringList(value) {
    if (!Array.isArray(value)) throw new Stop('invalid-schema');
    const seen = new Set();
    for (const item of value) {
      meter.work(typeof item === 'string' ? item.length + 1 : 1); meter.retain();
      if (typeof item !== 'string' || seen.has(item)) throw new Stop('invalid-schema');
      seen.add(item);
    }
  }
  function resolve(ref) {
    meter.work(typeof ref === 'string' ? ref.length + 1 : 1);
    if (typeof ref !== 'string') throw new Stop('invalid-schema');
    if (ref !== '#' && !ref.startsWith('#/')) throw new Stop('unsupported-schema');
    let pointer;
    try { pointer = decodeURIComponent(ref.slice(1)); } catch { throw new Stop('unresolved-ref'); }
    let target = index.root;
    if (pointer) {
      for (const raw of pointer.slice(1).split('/')) {
        meter.work(raw.length + 1); meter.retain(raw.length + 1);
        if (/~(?:[^01]|$)/.test(raw)) throw new Stop('unresolved-ref');
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        target = target.children.get(key);
        if (!target) throw new Stop('unresolved-ref');
      }
    }
    return target;
  }
  register(index.root);
  for (let i = 0; i < pending.length; i++) {
    const node = pending[i];
    if (node.kind === 'boolean') continue;
    const record = graph.get(node.id);
    const schema = node.raw;
    for (const key of node.keys) {
      meter.work(key.length + 1);
      if (!allowed.has(key)) throw new Stop('unsupported-schema');
      if (key === '$schema' && !['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-07/schema', 'https://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-07/schema'].includes(schema[key])) throw new Stop('unsupported-schema');
      if (annotations.has(key)) {
        if (['title', 'description', '$comment', 'format'].includes(key) && typeof schema[key] !== 'string') throw new Stop('invalid-schema');
        if (['readOnly', 'writeOnly'].includes(key) && typeof schema[key] !== 'boolean') throw new Stop('invalid-schema');
        if (key === 'examples' && !Array.isArray(schema[key])) throw new Stop('invalid-schema');
        if (key === 'format') { meter.retain(schema[key].length + 1); formats.add(schema[key]); }
      }
    }
    if (schema.type !== undefined) {
      const choices = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!choices.length) throw new Stop('invalid-schema');
      const seen = new Set();
      for (const type of choices) {
        meter.work();
        if (!types.has(type) || seen.has(type)) throw new Stop('invalid-schema');
        seen.add(type);
      }
    }
    for (const key of numeric) {
      if (schema[key] !== undefined && (typeof schema[key] !== 'number' || (key === 'multipleOf' && schema[key] <= 0))) throw new Stop('invalid-schema');
    }
    for (const key of counts) {
      if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) throw new Stop('invalid-schema');
    }
    if (schema.required !== undefined) stringList(schema.required);
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Stop('invalid-schema');
    if (schema.enum !== undefined) {
      const seen = new Set();
      for (const item of node.children.get('enum').children.values()) {
        const key = canonical(item, meter);
        meter.work(key.length + 1); meter.retain(key.length + 1);
        if (seen.has(key)) throw new Stop('invalid-schema');
        seen.add(key);
      }
    }
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') throw new Stop('invalid-schema');
    for (const key of singles) {
      if (schema[key] !== undefined) sub(record, node.children.get(key), ['not', 'if', 'then', 'else'].includes(key));
    }
    for (const key of lists) {
      if (schema[key] === undefined) continue;
      if (!Array.isArray(schema[key]) || !schema[key].length) throw new Stop('invalid-schema');
      for (const child of node.children.get(key).children.values()) sub(record, child, true);
    }
    for (const key of maps) {
      if (schema[key] === undefined) continue;
      if (!isObject(schema[key])) throw new Stop('invalid-schema');
      for (const child of node.children.get(key).children.values()) sub(record, child, false);
    }
    if (schema.items !== undefined) {
      const child = node.children.get('items');
      if (child.kind === 'array') {
        if (!child.raw.length) throw new Stop('invalid-schema');
        for (const item of child.children.values()) sub(record, item, false);
      } else sub(record, child, false);
    }
    if (schema.dependencies !== undefined) {
      if (!isObject(schema.dependencies)) throw new Stop('invalid-schema');
      for (const child of node.children.get('dependencies').children.values()) {
        if (child.kind === 'array') stringList(child.raw);
        else sub(record, child, true);
      }
    }
    if (schema.$ref !== undefined) {
      const target = resolve(schema.$ref);
      record.ref = sub(record, target, true);
      // Other schema positions are preflighted, but are not evaluated as
      // siblings of a draft-07 reference and must not create false cycles.
      record.same = [record.ref];
    }
  }
  // Iterative three-colour DFS on same-instance edges only. Scans all loaded
  // schema nodes, including unused definitions and reference targets.
  const colours = new Map();
  for (const id of graph.keys()) {
    if (colours.has(id)) continue;
    const stack = [[id, 0]];
    colours.set(id, 1);
    while (stack.length) {
      meter.work();
      const top = stack[stack.length - 1];
      const children = graph.get(top[0]).same;
      if (top[1] === children.length) { colours.set(top[0], 2); stack.pop(); continue; }
      const next = children[top[1]++];
      if (colours.get(next) === 1) throw new Stop('non-consuming-cycle');
      if (!colours.has(next)) { meter.retain(2); colours.set(next, 1); stack.push([next, 0]); }
    }
  }
  return { graph, formats: [...formats] };
}
