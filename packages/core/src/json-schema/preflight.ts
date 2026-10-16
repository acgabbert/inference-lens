import type { JsonObject } from "../run-kernel/types.ts";
import {
  indexSchema, SchemaMeter, SchemaStop,
  type SchemaJsonNode, type SchemaLimits, type SchemaResourceCode, type SchemaStats,
} from "./resources.ts";

export type SchemaPreflightCode = SchemaResourceCode
  | "invalid-schema"
  | "unsupported-keyword"
  | "unsupported-dialect"
  | "unsupported-reference"
  | "unresolved-reference"
  | "ref-sibling-assertion"
  | "non-consuming-cycle";

/** Authored-schema locations only. No model data or native errors enter these. */
export interface SchemaPreflightDiagnostic {
  code: SchemaPreflightCode;
  schemaPath: readonly string[];
  message: string;
}

/** Internal execution graph; never serialize it into a check or result. */
export interface PreparedSchemaNode {
  node: SchemaJsonNode;
  sameInstance: number[];
  reference?: number;
}

export interface PreparedSchema {
  root: number;
  nodes: Map<number, PreparedSchemaNode>;
  uncheckedFormats: { format: string; schemaPath: readonly string[] }[];
}

export type SchemaPreflightResult =
  | { status: "ready"; prepared: PreparedSchema; stats: SchemaStats }
  | { status: "not-evaluated"; diagnostic: SchemaPreflightDiagnostic; stats: SchemaStats };

const annotations = new Set([
  "title", "description", "examples", "default", "$comment", "readOnly", "writeOnly", "format",
]);
const singles = ["additionalItems", "contains", "additionalProperties", "propertyNames", "not", "if", "then", "else"];
const lists = ["allOf", "anyOf", "oneOf"];
const maps = ["properties", "definitions", "$defs"];
const numbers = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
const counts = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"];
const sameInstance = new Set(["not", "if", "then", "else"]);
const allowed = new Set([
  ...annotations, ...singles, ...lists, ...maps, ...numbers, ...counts,
  "$schema", "$ref", "type", "const", "enum", "required", "dependencies", "items", "uniqueItems",
]);
const refSiblings = new Set([...annotations, "definitions", "$defs", "$schema", "$ref"]);
const types = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const dialects = new Set([
  "http://json-schema.org/draft-07/schema#", "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema",
]);
const messages: Record<SchemaPreflightCode, string> = {
  "invalid-schema": "Expected a valid schema in the supported draft-07 profile.",
  "unsupported-keyword": "This keyword is unsupported. For pattern constraints, use a Safe regex check.",
  "unsupported-dialect": "Only the JSON Schema draft-07 dialect is supported.",
  "unsupported-reference": "Only local JSON Pointer references within this schema are supported.",
  "unresolved-reference": "The local reference does not resolve to a schema.",
  "ref-sibling-assertion": "Assertions beside $ref are unsupported; move them into an allOf branch.",
  "non-consuming-cycle": "Every recursive reference cycle must descend into a property or item.",
  "work-limit": "Schema preflight exceeded its work budget.",
  "storage-limit": "Schema preflight exceeded its storage budget.",
  "schema-too-large": "The schema exceeds its size limit.",
  "schema-depth-limit": "The schema exceeds its nesting limit.",
  "non-json-schema": "The schema must contain only JSON values.",
};

class PreflightStop extends Error {
  readonly code: SchemaPreflightCode;
  readonly path: readonly string[];
  constructor(code: SchemaPreflightCode, path: readonly string[]) {
    super(code);
    this.code = code;
    this.path = path;
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pure schema-side preparation. Callers supply calibration limits explicitly;
 * accounting is not yet exposed through the portable check vocabulary.
 */
export function preflightJsonSchema(schema: unknown, limits: SchemaLimits): SchemaPreflightResult {
  const meter = new SchemaMeter(limits);
  try {
    const root = indexSchema(schema, meter);
    const nodes = new Map<number, PreparedSchemaNode>();
    const pending: PreparedSchemaNode[] = [];
    const uncheckedFormats: PreparedSchema["uncheckedFormats"] = [];
    function fail(code: SchemaPreflightCode, node: SchemaJsonNode): never {
      throw new PreflightStop(code, node.path);
    }
    function register(node: SchemaJsonNode): number {
      if (typeof node.value !== "boolean" && !isObject(node.value)) fail("invalid-schema", node);
      if (!nodes.has(node.id)) {
        meter.work();
        meter.retain(8);
        const record: PreparedSchemaNode = { node, sameInstance: [] };
        nodes.set(node.id, record);
        pending.push(record);
      }
      return node.id;
    }
    function sub(record: PreparedSchemaNode, child: SchemaJsonNode, same: boolean): number {
      const id = register(child);
      meter.work();
      if (same) { meter.retain(); record.sameInstance.push(id); }
      return id;
    }
    function stringList(node: SchemaJsonNode): void {
      if (!Array.isArray(node.value)) fail("invalid-schema", node);
      const seen = new Set<string>();
      for (const child of node.children.values()) {
        const item = child.value;
        meter.work(typeof item === "string" ? item.length + 1 : 1);
        meter.retain();
        if (typeof item !== "string" || seen.has(item)) fail("invalid-schema", node);
        seen.add(item);
      }
    }
    function resolve(node: SchemaJsonNode): SchemaJsonNode {
      const ref = node.value;
      meter.work(typeof ref === "string" ? ref.length + 1 : 1);
      if (typeof ref !== "string") fail("invalid-schema", node);
      if (!ref.startsWith("#")) fail("unsupported-reference", node);
      let pointer: string;
      try { pointer = decodeURIComponent(ref.slice(1)); }
      catch { fail("unresolved-reference", node); }
      if (pointer !== "" && !pointer.startsWith("/")) fail("unsupported-reference", node);
      let target = root;
      if (pointer) {
        for (const token of pointer.slice(1).split("/")) {
          meter.work(token.length + 1);
          meter.retain(token.length + 1);
          if (/~(?:[^01]|$)/.test(token)) fail("unresolved-reference", node);
          const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
          // Array pointers use canonical non-negative integer tokens only.
          if (Array.isArray(target.value) && !/^(0|[1-9][0-9]*)$/.test(key)) fail("unresolved-reference", node);
          const child = target.children.get(key);
          if (!child) fail("unresolved-reference", node);
          target = child;
        }
      }
      if (typeof target.value !== "boolean" && !isObject(target.value)) fail("unresolved-reference", node);
      return target;
    }
    register(root);
    for (let i = 0; i < pending.length; i++) {
      const record = pending[i];
      const node = record.node;
      if (typeof node.value === "boolean") continue;
      const s = node.value as JsonObject;
      const child = (key: string): SchemaJsonNode => node.children.get(key)!;
      for (const [key, value] of node.children) {
        meter.work(key.length + 1);
        if (!allowed.has(key)) fail("unsupported-keyword", value);
        if (key === "$schema" && (typeof value.value !== "string" || !dialects.has(value.value))) {
          fail("unsupported-dialect", value);
        }
        if (node.children.has("$ref") && !refSiblings.has(key)) fail("ref-sibling-assertion", value);
        if (["title", "description", "$comment", "format"].includes(key) && typeof value.value !== "string") {
          fail("invalid-schema", value);
        }
        if (["readOnly", "writeOnly"].includes(key) && typeof value.value !== "boolean") fail("invalid-schema", value);
        if (key === "examples" && !Array.isArray(value.value)) fail("invalid-schema", value);
        if (key === "format") {
          meter.retain((value.value as string).length + value.path.length + 2);
          uncheckedFormats.push({ format: value.value as string, schemaPath: value.path });
        }
      }
      if (node.children.has("type")) {
        const choices = Array.isArray(s.type) ? s.type : [s.type];
        if (choices.length === 0) fail("invalid-schema", child("type"));
        const seen = new Set<string>();
        for (const type of choices) {
          meter.work(); meter.retain();
          if (typeof type !== "string" || !types.has(type) || seen.has(type)) fail("invalid-schema", child("type"));
          seen.add(type);
        }
      }
      for (const key of numbers) {
        if (node.children.has(key) && (typeof s[key] !== "number" || (key === "multipleOf" && (s[key] as number) <= 0))) {
          fail("invalid-schema", child(key));
        }
      }
      for (const key of counts) {
        if (node.children.has(key) && (typeof s[key] !== "number" || !Number.isInteger(s[key]) || (s[key] as number) < 0)) {
          fail("invalid-schema", child(key));
        }
      }
      if (node.children.has("required")) stringList(child("required"));
      if (node.children.has("enum")) {
        const values = child("enum");
        if (!Array.isArray(values.value) || !values.value.length) fail("invalid-schema", values);
        const seen = new Set<string>();
        for (const value of values.children.values()) {
          meter.work(value.encoding.length + 1); meter.retain(value.encoding.length + 1);
          if (seen.has(value.encoding)) fail("invalid-schema", values);
          seen.add(value.encoding);
        }
      }
      if (node.children.has("uniqueItems") && typeof s.uniqueItems !== "boolean") fail("invalid-schema", child("uniqueItems"));
      for (const key of singles) {
        if (node.children.has(key)) sub(record, child(key), sameInstance.has(key));
      }
      for (const key of lists) {
        if (!node.children.has(key)) continue;
        const list = child(key);
        if (!Array.isArray(list.value) || !list.value.length) fail("invalid-schema", list);
        for (const item of list.children.values()) sub(record, item, true);
      }
      for (const key of maps) {
        if (!node.children.has(key)) continue;
        const map = child(key);
        if (!isObject(map.value)) fail("invalid-schema", map);
        for (const item of map.children.values()) sub(record, item, false);
      }
      if (node.children.has("items")) {
        const items = child("items");
        if (Array.isArray(items.value)) {
          if (!items.value.length) fail("invalid-schema", items);
          for (const item of items.children.values()) sub(record, item, false);
        } else sub(record, items, false);
      }
      if (node.children.has("dependencies")) {
        const dependencies = child("dependencies");
        if (!isObject(dependencies.value)) fail("invalid-schema", dependencies);
        for (const dependency of dependencies.children.values()) {
          if (Array.isArray(dependency.value)) stringList(dependency);
          else sub(record, dependency, true);
        }
      }
      if (node.children.has("$ref")) record.reference = sub(record, resolve(child("$ref")), true);
    }
    // Three-colour DFS scans unused definitions too. Only same-instance edges
    // participate: property/item transitions consume data and break cycles.
    const colours = new Map<number, 1 | 2>();
    for (const id of nodes.keys()) {
      if (colours.has(id)) continue;
      meter.retain(3);
      const stack = [{ id, next: 0 }];
      colours.set(id, 1);
      while (stack.length) {
        meter.work();
        const top = stack[stack.length - 1];
        const current = nodes.get(top.id)!;
        if (top.next === current.sameInstance.length) {
          colours.set(top.id, 2); stack.pop(); continue;
        }
        const next = current.sameInstance[top.next++];
        if (colours.get(next) === 1) fail("non-consuming-cycle", current.node);
        if (!colours.has(next)) {
          meter.retain(3);
          colours.set(next, 1); stack.push({ id: next, next: 0 });
        }
      }
    }
    return { status: "ready", prepared: { root: root.id, nodes, uncheckedFormats }, stats: { ...meter.stats } };
  } catch (error) {
    if (!(error instanceof SchemaStop) && !(error instanceof PreflightStop)) throw error;
    return {
      status: "not-evaluated",
      diagnostic: {
        code: error.code,
        schemaPath: error instanceof PreflightStop ? error.path : [],
        message: messages[error.code],
      },
      stats: { ...meter.stats },
    };
  }
}
