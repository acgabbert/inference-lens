import type { JsonValue } from "../run-kernel/types.ts";
import { SchemaMeter, sortedKeys, textWork, WORK } from "./resources.ts";

/** Answer nodes keep no copied paths or canonical encodings. */
export interface JsonDataNode {
  id: number;
  value: JsonValue;
  children: Map<string, JsonDataNode>;
}

export class DataStop extends Error {
  readonly code: "data-depth-limit" | "non-json-data";
  constructor(code: DataStop["code"]) {
    super(code);
    this.code = code;
  }
}

/** Structure-only indexing; key order is deterministic before evaluation. */
export function indexData(value: JsonValue, meter: SchemaMeter): JsonDataNode {
  type Frame = { node: JsonDataNode; keys: string[]; next: number };
  const active = new WeakSet<object>();
  let nextId = 0;
  function enter(raw: unknown, depth: number): Frame {
    if (depth > meter.limits.maxDepth) throw new DataStop("data-depth-limit");
    meter.work(WORK.node); meter.retain(10);
    const container = raw !== null && typeof raw === "object";
    if (!container && raw !== null && !["boolean", "number", "string"].includes(typeof raw)) {
      throw new DataStop("non-json-data");
    }
    if (typeof raw === "number" && !Number.isFinite(raw)) throw new DataStop("non-json-data");
    const node: JsonDataNode = { id: nextId++, value: raw as JsonValue, children: new Map() };
    let keys: string[] = [];
    if (container) {
      if (active.has(raw)) throw new DataStop("non-json-data");
      active.add(raw);
      for (const key in raw) {
        if (!Object.hasOwn(raw, key)) continue;
        meter.work(WORK.key + textWork(key.length, WORK.scanText)); meter.retain(key.length + 2);
        keys.push(key);
      }
      if (Array.isArray(raw)) {
        if (keys.length !== raw.length) throw new DataStop("non-json-data");
        for (let i = 0; i < keys.length; i++) {
          meter.work();
          if (keys[i] !== String(i)) throw new DataStop("non-json-data");
        }
      } else {
        const prototype = Object.getPrototypeOf(raw);
        if (prototype !== Object.prototype && prototype !== null) throw new DataStop("non-json-data");
        keys = sortedKeys(keys, meter);
      }
    } else if (typeof raw === "string") {
      // Indexing neither copies nor escapes the text; storage accounts for it.
      meter.work(textWork(raw.length, WORK.copyText)); meter.retain(raw.length);
    }
    return { node, keys, next: 0 };
  }
  const root = enter(value, 1);
  const stack = [root];
  while (stack.length) {
    meter.work();
    const frame = stack[stack.length - 1];
    if (frame.next < frame.keys.length) {
      const key = frame.keys[frame.next++];
      const raw = (frame.node.value as Record<string, unknown>)[key];
      const child = enter(raw, stack.length + 1);
      frame.node.children.set(key, child.node);
      stack.push(child);
    } else {
      if (frame.node.value !== null && typeof frame.node.value === "object") active.delete(frame.node.value);
      stack.pop();
    }
  }
  return root.node;
}

/**
 * One evaluation owns this cache. Encode only requested subtrees, emitting a
 * single sequence of chunks rather than constructing every ancestor's string.
 * Descendants visited during construction are not implicitly cached. A later
 * request for a descendant pays for that separate encoding explicitly.
 */
export class DataEncodings {
  private readonly cache = new Map<JsonDataNode, string>();

  canonical(node: JsonDataNode, meter: SchemaMeter): string {
    meter.work();
    const cached = this.cache.get(node);
    if (cached !== undefined) return cached;
    type Frame = { entries: MapIterator<[string, JsonDataNode]>; array: boolean; first: boolean };
    const stack: Frame[] = [];
    const chunks: string[] = [];
    let length = 0;
    function emit(text: string): void {
      meter.work(WORK.node + textWork(text.length, WORK.copyText)); meter.retain(text.length + 1);
      chunks.push(text);
      length += text.length;
    }
    function quoted(text: string): string {
      meter.work(textWork(text.length, WORK.scanText));
      return JSON.stringify(text);
    }
    const enter = (current: JsonDataNode): void => {
      meter.work();
      const encoding = this.cache.get(current);
      if (encoding !== undefined) { emit(encoding); return; }
      const value = current.value;
      if (value !== null && typeof value === "object") {
        const array = Array.isArray(value);
        emit(array ? "[" : "{");
        meter.retain(4);
        stack.push({ entries: current.children.entries(), array, first: true });
      } else {
        emit(typeof value === "string" ? quoted(value) : JSON.stringify(value));
      }
    };
    enter(node);
    while (stack.length) {
      meter.work();
      const frame = stack[stack.length - 1];
      const next = frame.entries.next();
      if (next.done) {
        emit(frame.array ? "]" : "}");
        stack.pop();
      } else {
        if (!frame.first) emit(",");
        frame.first = false;
        const [key, child] = next.value;
        if (!frame.array) { emit(quoted(key)); emit(":"); }
        enter(child);
      }
    }
    // Charge the final copy and cache record before retaining the encoding.
    meter.work(WORK.node + textWork(length, WORK.copyText)); meter.retain(length + 2);
    const encoding = chunks.join("");
    this.cache.set(node, encoding);
    return encoding;
  }
}
