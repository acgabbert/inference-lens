import type { JsonObject } from "../run-kernel/types.ts";
import { parseJsonInput } from "../json-input.ts";
import { SCHEMA_CHECK_LIMITS } from "./limits.ts";
import { preflightJsonSchema, type SchemaPreflightCode } from "./preflight.ts";
import { indexSchema, SchemaMeter, SchemaStop, type SchemaJsonNode } from "./resources.ts";

export type SchemaGenerationResult =
  | { status: "ready"; schema: JsonObject; warnings: ("empty-array")[] }
  | { status: "invalid"; code: "invalid-example" | "example-too-large" | "example-depth-limit" | SchemaPreflightCode; message: string };

/** Local authoring only. Examples and warnings are never part of a saved check. */
export function generateJsonSchema(
  text: string,
  options: { disallowExtraProperties?: boolean } = {},
): SchemaGenerationResult {
  const limits = SCHEMA_CHECK_LIMITS.schema;
  if (text.length > limits.maxSchemaCodeUnits) {
    return { status: "invalid", code: "example-too-large", message: "The example exceeds the schema/example size limit." };
  }
  const parsed = parseJsonInput(text);
  if (!parsed.valid) return { status: "invalid", code: "invalid-example", message: "Enter a valid JSON example." };
  const meter = new SchemaMeter(limits);
  try {
    // Reuse the same finite-value, depth, size, and structural budgets as schema input.
    const root = indexSchema(parsed.value, meter);
    const schemas = new Map<number, JsonObject>();
    const pending: { node: SchemaJsonNode; visited: boolean }[] = [{ node: root, visited: false }];
    let emptyArray = false;
    while (pending.length) {
      meter.work();
      const { node, visited } = pending.pop()!;
      if (!visited) {
        pending.push({ node, visited: true });
        for (const child of [...node.children.values()].reverse()) pending.push({ node: child, visited: false });
        continue;
      }
      const value = node.value;
      let schema: JsonObject;
      if (Array.isArray(value)) {
        const branches = new Map<string, JsonObject>();
        for (const child of node.children.values()) {
          const item = schemas.get(child.id)!;
          const encoded = JSON.stringify(item);
          meter.work(1 + encoded.length);
          if (!branches.has(encoded)) branches.set(encoded, item);
        }
        const items = [...branches.values()];
        if (!items.length) emptyArray = true;
        schema = { type: "array", items: items.length === 0 ? true : items.length === 1 ? items[0] : { anyOf: items } };
      } else if (value !== null && typeof value === "object") {
        const entries = [...node.children].map(([key, child]) => [key, schemas.get(child.id)!] as const);
        schema = { type: "object", properties: Object.fromEntries(entries), required: entries.map(([key]) => key) };
        if (options.disallowExtraProperties) schema.additionalProperties = false;
      } else {
        const type = value === null ? "null" : typeof value === "number" ? Number.isInteger(value) ? "integer" : "number" : typeof value;
        schema = { type };
      }
      const encodedSize = JSON.stringify(schema).length;
      if (encodedSize > limits.maxSchemaCodeUnits) throw new SchemaStop("schema-too-large");
      meter.retain(encodedSize);
      schemas.set(node.id, schema);
    }
    const schema = schemas.get(root.id)!;
    const preflight = preflightJsonSchema(schema, limits);
    if (preflight.status !== "ready") return { status: "invalid", code: preflight.diagnostic.code, message: preflight.diagnostic.message };
    return { status: "ready", schema, warnings: emptyArray ? ["empty-array"] : [] };
  } catch (error) {
    if (!(error instanceof SchemaStop)) throw error;
    if (error.code === "schema-depth-limit") return { status: "invalid", code: "example-depth-limit", message: "The example exceeds the nesting limit." };
    return { status: "invalid", code: error.code, message: "The example or generated schema exceeds the supported JSON schema budgets. Use a smaller example." };
  }
}
