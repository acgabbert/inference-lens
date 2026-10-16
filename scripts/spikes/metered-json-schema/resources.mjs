// Experimental accounting model. Units are logical work / retained UTF-16
// payload plus record slots, not elapsed time or exact JavaScript heap bytes.
export class Stop extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function resources(options) {
  const limits = { workLimit: 4_000_000, storageLimit: 4_000_000, maxIssues: 20, ...options };
  for (const key of ['workLimit', 'storageLimit', 'maxIssues']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new Error(`Invalid ${key}`);
  }
  const stats = { work: 0, storage: 0, pairs: 0, memoHits: 0 };
  return {
    limits, stats,
    work(n = 1) {
      if (n > limits.workLimit - stats.work) throw new Stop('work-limit');
      stats.work += n;
    },
    retain(n = 1) {
      if (n > limits.storageLimit - stats.storage) throw new Stop('storage-limit');
      stats.storage += n;
    },
  };
}

// An explicitly specified merge sort avoids engine-dependent Array.sort
// comparison counts changing budget outcomes between V8 and WebKit.
export function sortedKeys(keys, meter) {
  if (keys.length < 2) return keys;
  meter.retain(keys.length * 2);
  const mid = Math.floor(keys.length / 2);
  const left = sortedKeys(keys.slice(0, mid), meter);
  const right = sortedKeys(keys.slice(mid), meter);
  const result = [];
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    // Charge an upper bound on UTF-16 comparison cost before comparing.
    meter.work(1 + left[a].length + right[b].length);
    result.push(left[a] <= right[b] ? left[a++] : right[b++]);
  }
  while (a < left.length) { meter.work(); result.push(left[a++]); }
  while (b < right.length) { meter.work(); result.push(right[b++]); }
  return result;
}

export function indexJson(value, meter, maxUnits, maxDepth = 64) {
  const nodes = [];
  let units = 0;
  const seen = new WeakSet();
  function addUnits(n) {
    units += n;
    if (units > maxUnits) throw new Stop('input-limit');
    meter.work(n);
  }
  function quoted(text) {
    // Native JSON.stringify only runs after its bounded input is charged.
    meter.work(text.length);
    const result = JSON.stringify(text);
    addUnits(result.length);
    meter.retain(result.length);
    return result;
  }
  function visit(raw, depth) {
    if (depth > maxDepth) throw new Stop('input-limit');
    meter.work(); meter.retain(8);
    const kind = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    if (!['null', 'array', 'object', 'number', 'string', 'boolean'].includes(kind)) throw new Stop('non-json-input');
    if (kind === 'number' && !Number.isFinite(raw)) throw new Stop('non-json-input');
    const node = { id: nodes.length, raw, kind, children: new Map(), keyEncodings: new Map() };
    nodes.push(node);
    if (kind === 'object' || kind === 'array') {
      if (seen.has(raw)) throw new Stop('non-json-input');
      seen.add(raw);
      addUnits(2);
      const keys = [];
      for (const key in raw) {
        if (!Object.hasOwn(raw, key)) continue;
        meter.work(); meter.retain(2 + key.length);
        keys.push(key);
      }
      if (kind === 'array' && keys.length !== raw.length) throw new Stop('non-json-input');
      node.keys = kind === 'array' ? keys : sortedKeys(keys, meter);
      for (let i = 0; i < node.keys.length; i++) {
        const key = node.keys[i];
        if (i) addUnits(1);
        if (kind === 'object') { node.keyEncodings.set(key, quoted(key)); addUnits(1); }
        node.children.set(key, visit(raw[key], depth + 1));
      }
      seen.delete(raw);
    } else if (kind === 'string') node.encoded = quoted(raw);
    else { node.encoded = JSON.stringify(raw); addUnits(node.encoded.length); meter.retain(node.encoded.length); }
    return node;
  }
  return { root: visit(value, 1), nodes, units };
}

export function canonical(node, meter) {
  if (node.canonical !== undefined) { meter.work(); return node.canonical; }
  const parts = [];
  let length = 2;
  for (const key of node.keys ?? []) {
    meter.work();
    const child = canonical(node.children.get(key), meter);
    const partLength = child.length + (node.kind === 'object' ? node.keyEncodings.get(key).length + 1 : 0);
    meter.work(partLength); meter.retain(partLength + 1);
    const part = node.kind === 'object' ? `${node.keyEncodings.get(key)}:${child}` : child;
    length += part.length + 1;
    parts.push(part);
  }
  if (node.kind !== 'object' && node.kind !== 'array') {
    node.canonical = node.encoded;
  } else {
    meter.work(length); meter.retain(length);
    node.canonical = node.kind === 'object' ? `{${parts.join(',')}}` : `[${parts.join(',')}]`;
  }
  return node.canonical;
}
