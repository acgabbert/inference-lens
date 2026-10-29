import { Stop, resources, indexJson, canonical } from './resources.mjs';
import { preflight } from './preflight.mjs';

// An isolated feasibility API over parsed JSON values. No persisted contracts,
// provider types, clock, I/O, process-wide cache, or engine-generated code.
export function evaluate(schema, data, options = {}) {
  const meter = resources(options);
  const { stats } = meter;
  try {
    const schemas = indexJson(schema, meter, 65536);
    const { graph, formats } = preflight(schemas, meter);
    const instances = indexJson(data, meter, 1_000_000);
    const memo = new Map();
    let activeDepth = 0;
    let syntheticId = instances.nodes.length;
    const tasks = [];
    const issues = [];
    let truncated = false;
    let explaining = false;

    function lookup(sid, node) {
      meter.work();
      return memo.get(sid)?.get(node.id);
    }
    function check(sid, node) {
      const cached = lookup(sid, node);
      if (cached !== undefined) { stats.memoHits++; return cached; }
      // Deterministic stack guard, independent of the host's RangeError point.
      // Long valid reference chains remain supported schemas but may exhaust
      // this experimental evaluation resource budget.
      if (activeDepth === 128) throw new Stop('evaluation-depth-limit');
      activeDepth++;
      const valid = constraints(sid, node, []);
      activeDepth--;
      if (!memo.has(sid)) { meter.retain(2); memo.set(sid, new Map()); }
      meter.retain(3); stats.pairs++;
      memo.get(sid).set(node.id, valid);
      return valid;
    }
    function equal(a, b) {
      const left = canonical(a, meter);
      const right = canonical(b, meter);
      meter.work(1 + left.length + right.length);
      return left === right;
    }
    function segment(location, value) {
      meter.retain(location.length + 2);
      return [...location, value];
    }
    function issue(keyword, location) {
      if (!explaining || truncated) return;
      meter.work(); meter.retain(keyword.length + location.length + 2);
      if (issues.length === meter.limits.maxIssues) truncated = true;
      else issues.push({ keyword, location });
    }
    function child(sid, node, location) {
      const valid = check(sid, node);
      if (!valid && explaining) {
        meter.retain(location.length + 3);
        tasks.push({ sid, node, location });
      }
      return valid;
    }
    function stringLength(text) {
      let count = 0;
      for (const character of text) { meter.work(character.length); count++; }
      return count;
    }
    function decimal(number) {
      const text = number.toString();
      meter.work(text.length + 1);
      const [mantissa, exponent = '0'] = text.split('e');
      const dot = mantissa.indexOf('.');
      return { coefficient: BigInt(mantissa.replace('.', '')), exponent: Number(exponent) - (dot < 0 ? 0 : mantissa.length - dot - 1) };
    }
    function multipleOf(number, divisor) {
      const a = decimal(number);
      const b = decimal(divisor);
      const shift = a.exponent - b.exponent;
      meter.work(Math.abs(shift) + 1); meter.retain(Math.abs(shift) + 1);
      return shift >= 0
        ? (a.coefficient * 10n ** BigInt(shift)) % b.coefficient === 0n
        : a.coefficient % (b.coefficient * 10n ** BigInt(-shift)) === 0n;
    }
    function constraints(sid, node, location) {
      meter.work();
      const record = graph.get(sid);
      const schemaNode = record.node;
      const s = schemaNode.raw;
      if (typeof s === 'boolean') { if (!s) issue('false', location); return s; }
      if (record.ref !== undefined) return child(record.ref, node, location);
      let valid = true;
      function assert(condition, keyword) {
        meter.work();
        if (!condition) { valid = false; issue(keyword, location); }
      }
      function apply(schemaChild, dataChild, safeLocation = location) {
        if (!child(schemaChild.id, dataChild, safeLocation)) valid = false;
      }
      function sub(key) { return schemaNode.children.get(key); }
      if (s.type !== undefined) {
        const choices = Array.isArray(s.type) ? s.type : [s.type];
        let matches = false;
        for (const type of choices) { meter.work(); if (type === node.kind || (type === 'integer' && node.kind === 'number' && Number.isInteger(node.raw))) matches = true; }
        assert(matches, 'type');
      }
      if (s.const !== undefined) assert(equal(node, sub('const')), 'const');
      if (s.enum !== undefined) {
        let matches = false;
        for (const candidate of sub('enum').children.values()) { meter.work(); if (equal(node, candidate)) { matches = true; break; } }
        assert(matches, 'enum');
      }
      if (node.kind === 'number') {
        for (const [keyword, compare] of [
          ['minimum', (a, b) => a >= b], ['maximum', (a, b) => a <= b],
          ['exclusiveMinimum', (a, b) => a > b], ['exclusiveMaximum', (a, b) => a < b],
        ]) if (s[keyword] !== undefined) assert(compare(node.raw, s[keyword]), keyword);
        if (s.multipleOf !== undefined) assert(multipleOf(node.raw, s.multipleOf), 'multipleOf');
      }
      if (node.kind === 'string' && (s.minLength !== undefined || s.maxLength !== undefined)) {
        const length = stringLength(node.raw);
        if (s.minLength !== undefined) assert(length >= s.minLength, 'minLength');
        if (s.maxLength !== undefined) assert(length <= s.maxLength, 'maxLength');
      }
      if (node.kind === 'object') {
        if (s.minProperties !== undefined) assert(node.keys.length >= s.minProperties, 'minProperties');
        if (s.maxProperties !== undefined) assert(node.keys.length <= s.maxProperties, 'maxProperties');
        for (const key of s.required ?? []) { meter.work(key.length + 1); assert(node.children.has(key), 'required'); }
        const properties = sub('properties')?.children;
        for (const key of node.keys) {
          meter.work(key.length + 1);
          const value = node.children.get(key);
          const declared = properties?.get(key);
          if (declared) apply(declared, value, segment(location, { property: key }));
          else if (s.additionalProperties !== undefined) {
            if (s.additionalProperties === false) assert(false, 'additionalProperties');
            else apply(sub('additionalProperties'), value, segment(location, { redacted: true }));
          }
          if (s.propertyNames !== undefined) {
            if (!value.nameNode) {
              meter.work(key.length + 1); meter.retain(key.length + 8);
              value.nameNode = { id: syntheticId++, kind: 'string', raw: key, encoded: JSON.stringify(key), children: new Map() };
            }
            assert(check(sub('propertyNames').id, value.nameNode), 'propertyNames');
          }
        }
        for (const [key, dependency] of sub('dependencies')?.children ?? []) {
          meter.work(key.length + 1);
          if (!node.children.has(key)) continue;
          if (dependency.kind === 'array') {
            for (const required of dependency.raw) { meter.work(required.length + 1); assert(node.children.has(required), 'dependencies'); }
          } else apply(dependency, node);
        }
      }
      if (node.kind === 'array') {
        if (s.minItems !== undefined) assert(node.raw.length >= s.minItems, 'minItems');
        if (s.maxItems !== undefined) assert(node.raw.length <= s.maxItems, 'maxItems');
        if (s.items !== undefined) {
          for (let i = 0; i < node.raw.length; i++) {
            meter.work();
            const tuple = Array.isArray(s.items);
            const item = tuple ? sub('items').children.get(String(i)) : sub('items');
            if (item) apply(item, node.children.get(String(i)), segment(location, { index: i }));
            else if (s.additionalItems !== undefined) apply(sub('additionalItems'), node.children.get(String(i)), segment(location, { index: i }));
          }
        }
        if (s.contains !== undefined) {
          let found = false;
          for (const item of node.children.values()) { meter.work(); if (check(sub('contains').id, item)) { found = true; break; } }
          assert(found, 'contains');
        }
        if (s.uniqueItems === true) {
          const seen = new Set();
          let unique = true;
          for (const item of node.children.values()) {
            const encoding = canonical(item, meter);
            meter.work(encoding.length + 1); meter.retain(encoding.length + 1);
            if (seen.has(encoding)) { unique = false; break; }
            seen.add(encoding);
          }
          assert(unique, 'uniqueItems');
        }
      }
      for (const item of sub('allOf')?.children.values() ?? []) { meter.work(); apply(item, node); }
      if (s.anyOf !== undefined || s.oneOf !== undefined) {
        for (const keyword of ['anyOf', 'oneOf']) {
          if (s[keyword] === undefined) continue;
          let matches = 0;
          for (const item of sub(keyword).children.values()) { meter.work(); if (check(item.id, node)) matches++; }
          assert(keyword === 'anyOf' ? matches > 0 : matches === 1, keyword);
        }
      }
      if (s.not !== undefined) assert(!check(sub('not').id, node), 'not');
      if (s.if !== undefined) {
        const branch = check(sub('if').id, node) ? 'then' : 'else';
        if (s[branch] !== undefined) apply(sub(branch), node);
      }
      return valid;
    }
    const valid = check(schemas.root.id, instances.root);
    if (!valid) {
      explaining = true;
      tasks.push({ sid: schemas.root.id, node: instances.root, location: [] });
      // Memoize diagnostic traversal separately, including the safe path.
      // A shared boolean result cannot establish a safe display location.
      const seen = new Set();
      while (tasks.length && !truncated) {
        meter.work();
        const task = tasks.pop();
        meter.work(task.location.length + 1);
        const key = `${task.sid}:${task.node.id}:${JSON.stringify(task.location)}`;
        meter.work(key.length); meter.retain(key.length + 1);
        if (seen.has(key)) continue;
        seen.add(key);
        constraints(task.sid, task.node, task.location);
      }
    }
    return { accountingVersion: 'spike-1', status: valid ? 'valid' : 'invalid', ...stats, issues, truncated, uncheckedFormats: formats };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return { accountingVersion: 'spike-1', status: 'not-evaluated', code: error.code, ...stats, issues: [], truncated: false };
  }
}
