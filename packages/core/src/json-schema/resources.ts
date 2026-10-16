import type { JsonValue } from "../run-kernel/types.ts";

/** Internal calibration inputs, not portable check options or frozen accounting. */
export interface SchemaLimits {
  workLimit: number;
  storageLimit: number;
  maxSchemaCodeUnits: number;
  maxDepth: number;
}

export interface SchemaStats {
  work: number;
  storage: number;
}

export type SchemaResourceCode =
  | "work-limit"
  | "storage-limit"
  | "schema-too-large"
  | "schema-depth-limit"
  | "non-json-schema";

/**
 * Work charges, calibrated so one unit costs roughly the same time whichever
 * operation spends it (docs/JSON_SCHEMA_CALIBRATION.md). Fixed charges price
 * an operation; the text divisors price its length in code units. Outcomes are
 * re-derived when evidence is opened, so once a check vocabulary ships these
 * values, changing any of them is a vocabulary change.
 */
export const WORK = Object.freeze({
  /** Index one JSON value, or advance one explicit traversal stack. */
  node: 2,
  /** Collect, merge-sort, or look up one object key, apart from its text. */
  key: 1,
  /** Start one subschema evaluation frame. */
  frame: 10,
  /** Decide one numeric multiple, apart from its decimal shift. */
  multiple: 8,
  /** Code units per unit when text is scanned code point by code point, quoted, or hashed. */
  scanText: 4,
  /** Code units per unit when text is copied or compared. */
  copyText: 256,
  /** Decimal digits of `multipleOf` shift per unit. */
  shiftDigits: 16,
});

/** The length-proportional part of a charge, in whole units. */
export function textWork(length: number, perUnit: number): number {
  return Math.floor(length / perUnit);
}

export class SchemaStop extends Error {
  readonly code: SchemaResourceCode;
  constructor(code: SchemaResourceCode) {
    super(code);
    this.code = code;
  }
}

/** Each invocation owns its meter and all retained state. No clock or cache. */
export class SchemaMeter {
  readonly limits: SchemaLimits;
  readonly stats: SchemaStats = { work: 0, storage: 0 };

  constructor(limits: SchemaLimits) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Schema limits must be non-negative safe integers.");
      }
    }
    this.limits = { ...limits };
  }

  work(units = 1): void {
    if (units > this.limits.workLimit - this.stats.work) throw new SchemaStop("work-limit");
    this.stats.work += units;
  }

  retain(units = 1): void {
    if (units > this.limits.storageLimit - this.stats.storage) throw new SchemaStop("storage-limit");
    this.stats.storage += units;
  }
}

export interface SchemaJsonNode {
  id: number;
  value: JsonValue;
  path: readonly string[];
  children: Map<string, SchemaJsonNode>;
  /** Authored-schema canonical JSON for equality and size accounting. */
  encoding: string;
}

/** Stable merge sort keeps work independent of engine Array.sort behavior. */
export function sortedKeys(keys: string[], meter: SchemaMeter): string[] {
  if (keys.length < 2) return keys;
  meter.retain(keys.length * 2);
  const middle = Math.floor(keys.length / 2);
  const left = sortedKeys(keys.slice(0, middle), meter);
  const right = sortedKeys(keys.slice(middle), meter);
  const result: string[] = [];
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    meter.work(WORK.key + textWork(left[a].length + right[b].length, WORK.copyText));
    result.push(left[a] <= right[b] ? left[a++] : right[b++]);
  }
  while (a < left.length) { meter.work(); result.push(left[a++]); }
  while (b < right.length) { meter.work(); result.push(right[b++]); }
  return result;
}

/**
 * Index JSON without native recursion, coercion, or mutation. Size is measured
 * as compact JSON, including literals/annotations; editor text is a separate
 * input boundary. Object keys are sorted before any observable preflight work.
 */
export function indexSchema(value: unknown, meter: SchemaMeter): SchemaJsonNode {
  type Frame = { node: SchemaJsonNode; keys: string[]; next: number; parts: string[] };
  const active = new WeakSet<object>();
  let nextId = 0;
  let codeUnits = 0;
  function size(units: number): void {
    if (units > meter.limits.maxSchemaCodeUnits - codeUnits) throw new SchemaStop("schema-too-large");
    codeUnits += units;
  }
  function quoted(text: string): string {
    // Bound input before invoking the native encoder; escaped size is checked next.
    if (text.length > meter.limits.maxSchemaCodeUnits - codeUnits) throw new SchemaStop("schema-too-large");
    meter.work(WORK.node + textWork(text.length, WORK.scanText));
    const encoding = JSON.stringify(text);
    size(encoding.length);
    meter.retain(encoding.length);
    return encoding;
  }
  function enter(raw: unknown, path: readonly string[]): Frame {
    if (path.length + 1 > meter.limits.maxDepth) throw new SchemaStop("schema-depth-limit");
    // Each node copies its authored path, so deep schemas pay for that copy.
    meter.work(WORK.node + textWork(path.length, WORK.scanText));
    meter.retain(8 + path.length);
    const container = raw !== null && typeof raw === "object";
    if (!container && raw !== null && !["boolean", "string", "number"].includes(typeof raw)) {
      throw new SchemaStop("non-json-schema");
    }
    if (typeof raw === "number" && !Number.isFinite(raw)) throw new SchemaStop("non-json-schema");
    const node: SchemaJsonNode = {
      id: nextId++, value: raw as JsonValue, path, children: new Map(), encoding: "",
    };
    let keys: string[] = [];
    if (container) {
      if (active.has(raw)) throw new SchemaStop("non-json-schema");
      active.add(raw);
      size(2);
      for (const key in raw) {
        if (!Object.hasOwn(raw, key)) continue;
        meter.work(WORK.key + textWork(key.length, WORK.scanText));
        meter.retain(key.length + 2);
        keys.push(key);
      }
      if (Array.isArray(raw)) {
        if (keys.length !== raw.length || keys.some((key, i) => key !== String(i))) {
          throw new SchemaStop("non-json-schema");
        }
      } else {
        const prototype = Object.getPrototypeOf(raw);
        if (prototype !== Object.prototype && prototype !== null) throw new SchemaStop("non-json-schema");
        keys = sortedKeys(keys, meter);
      }
    } else {
      node.encoding = typeof raw === "string" ? quoted(raw) : JSON.stringify(raw);
      if (typeof raw !== "string") { size(node.encoding.length); meter.retain(node.encoding.length); }
    }
    return { node, keys, next: 0, parts: [] };
  }
  const root = enter(value, []);
  const stack = [root];
  while (stack.length) {
    meter.work();
    const frame = stack[stack.length - 1];
    if (frame.next < frame.keys.length) {
      const key = frame.keys[frame.next++];
      if (frame.next > 1) size(1);
      if (!Array.isArray(frame.node.value)) {
        frame.parts.push(quoted(key) + ":");
        size(1);
      }
      const raw = (frame.node.value as Record<string, unknown>)[key];
      const child = enter(raw, [...frame.node.path, key]);
      frame.node.children.set(key, child.node);
      stack.push(child);
    } else {
      if (frame.node.value !== null && typeof frame.node.value === "object") {
        const array = Array.isArray(frame.node.value);
        // Delimiters are explicit: commas separate values, not object key/value pairs.
        const parts = frame.keys.map((key, i) => {
          const child = frame.node.children.get(key)!;
          return array ? child.encoding : frame.parts[i] + child.encoding;
        });
        const length = parts.reduce((sum, part) => sum + part.length + 1, 2);
        meter.work(WORK.node + frame.keys.length + textWork(length, WORK.copyText));
        meter.retain(length);
        frame.node.encoding = array ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
        active.delete(frame.node.value);
      }
      stack.pop();
    }
  }
  return root.node;
}
