import assert from "node:assert/strict";
import test from "node:test";
import { preflightJsonSchema } from "../packages/core/src/json-schema/preflight.ts";

const limits = {
  workLimit: 4_000_000,
  storageLimit: 4_000_000,
  maxSchemaCodeUnits: 65_536,
  maxDepth: 64,
};

test("assertions beside a local reference are rejected instead of silently ignored", () => {
  const schema = {
    definitions: { value: { type: "string" } },
    $ref: "#/definitions/value",
    type: "number",
  };
  const result = preflightJsonSchema(schema, limits);
  assert.equal(result.status, "not-evaluated");
  if (result.status === "not-evaluated") {
    assert.equal(result.diagnostic.code, "ref-sibling-assertion");
    assert.deepEqual(result.diagnostic.schemaPath, ["type"]);
  }
});

function rejected(schema: unknown, code: string, path?: string[]): void {
  const result = preflightJsonSchema(schema, limits);
  assert.equal(result.status, "not-evaluated");
  if (result.status !== "not-evaluated") return;
  assert.equal(result.diagnostic.code, code);
  if (path) assert.deepEqual(result.diagnostic.schemaPath, path);
}

function ready(schema: unknown) {
  const result = preflightJsonSchema(schema, limits);
  assert.equal(result.status, "ready", JSON.stringify(result));
  if (result.status !== "ready") throw new Error("Schema was rejected");
  return result;
}

test("supports nested assertions, tuple items, composition, and boolean schemas", () => {
  for (const schema of [true, false, {}, {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: ["object", "null"],
    required: ["answer"],
    properties: {
      answer: {
        type: "array", minItems: 1, maxItems: 10, uniqueItems: true,
        items: [{ type: "integer", multipleOf: 0.1, minimum: 0, exclusiveMaximum: 5 }, false],
        additionalItems: false, contains: { const: 1 },
      },
      text: { type: "string", minLength: 0, maxLength: 20, enum: ["a", "b"] },
    },
    additionalProperties: false,
    minProperties: 1, maxProperties: 2,
    propertyNames: { maxLength: 20 },
    dependencies: { answer: ["text"], text: { required: ["answer"] } },
    allOf: [true], anyOf: [true, false], oneOf: [true, false], not: false,
    if: { required: ["text"] }, then: true, else: false,
  }]) ready(schema);
});

test("rejects malformed values at every supported schema position", () => {
  for (const schema of [null, [], "schema", 1,
    { type: "bogus" }, { type: [] }, { type: ["string", "string"] }, { type: [1] },
    { minimum: "1" }, { maximum: null }, { exclusiveMinimum: true }, { exclusiveMaximum: [] },
    { multipleOf: 0 }, { multipleOf: -1 },
    { minLength: -1 }, { maxLength: 0.5 }, { minItems: "0" }, { maxItems: null },
    { minProperties: true }, { maxProperties: {} },
    { required: [1] }, { required: ["x", "x"] }, { required: null },
    { enum: [] }, { enum: "x" }, { uniqueItems: 1 },
    { properties: [] }, { properties: { x: 1 } }, { definitions: { x: null } }, { $defs: [] },
    { allOf: [] }, { anyOf: true }, { oneOf: [null] },
    { items: [] }, { items: [1] }, { items: null },
    { additionalProperties: 0 }, { additionalItems: 0 }, { contains: [] },
    { propertyNames: "x" }, { not: 1 }, { if: null }, { then: [] }, { else: 1 },
    { dependencies: [] }, { dependencies: { x: [1] } }, { dependencies: { x: null } },
    { title: 1 }, { description: [] }, { $comment: null }, { examples: {} },
    { readOnly: 1 }, { writeOnly: "true" }, { format: [] }, { $ref: 1 },
  ]) rejected(schema, "invalid-schema");
});

test("enum uniqueness uses JSON equality, including key order and negative zero", () => {
  for (const values of [[1, 1.0], [0, -0], [{ a: 1, b: 2 }, { b: 2, a: 1 }], [[1, 2], [1, 2]]]) {
    rejected({ enum: values }, "invalid-schema", ["enum"]);
  }
  ready({ enum: [[1, 2], [2, 1], { a: "b,c" }, { "a:b": "c" }] });
});

test("rejects unsupported assertions and identifiers even in unused schemas", () => {
  for (const key of ["$id", "require", "unknown", "unevaluatedProperties", "$async"]) {
    rejected({ [key]: true }, "unsupported-keyword", [key]);
    rejected({ definitions: { unused: { [key]: true } } }, "unsupported-keyword", ["definitions", "unused", key]);
  }
  for (const key of ["pattern", "patternProperties"]) {
    rejected({ [key]: {} }, "unsupported-pattern", [key]);
    rejected({ definitions: { unused: { [key]: {} } } }, "unsupported-pattern", ["definitions", "unused", key]);
  }
  rejected({ pattern: "private-pattern" }, "unsupported-pattern");
  for (const key of ["require", "$id"]) {
    const generic = preflightJsonSchema({ [key]: true }, limits);
    assert.equal(generic.status, "not-evaluated");
    if (generic.status === "not-evaluated") assert.doesNotMatch(generic.diagnostic.message, /pattern|Safe regex/i);
  }
  const result = preflightJsonSchema({ pattern: "private-pattern" }, limits);
  assert.ok(!JSON.stringify(result).includes("private-pattern"));
  if (result.status === "not-evaluated") assert.match(result.diagnostic.message, /Safe regex/);
});

test("only draft-07 dialects are accepted", () => {
  for (const protocol of ["http", "https"]) {
    for (const suffix of ["", "#"]) ready({ $schema: `${protocol}://json-schema.org/draft-07/schema${suffix}` });
  }
  for (const dialect of [null, 7, "http://json-schema.org/draft-04/schema#", "https://json-schema.org/draft/2020-12/schema"]) {
    rejected({ $schema: dialect }, "unsupported-dialect", ["$schema"]);
  }
});

test("annotations and literal JSON do not accidentally become assertions", () => {
  const result = ready({
    title: "title", description: "description", $comment: "comment",
    readOnly: true, writeOnly: false,
    default: { pattern: "literal" }, examples: [{ $ref: "remote" }],
    const: { pattern: "literal", $id: "literal" },
    properties: { first: { format: "date-time" }, second: { format: "date-time" } },
    format: "email",
  });
  assert.deepEqual(result.prepared.uncheckedFormats, [
    { format: "email", schemaPath: ["format"] },
    { format: "date-time", schemaPath: ["properties", "first", "format"] },
    { format: "date-time", schemaPath: ["properties", "second", "format"] },
  ]);
});

test("references allow annotations and definitions but reject all sibling assertions", () => {
  ready({
    $ref: "#/definitions/n", definitions: { n: true }, $defs: { other: false },
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "reference", default: 1, format: "email", examples: [],
  });
  for (const [key, value] of Object.entries({
    type: "number", const: 1, enum: [1], required: [], properties: {}, items: true,
    allOf: [true], anyOf: [true], oneOf: [true], not: false, if: true,
    minimum: 0, maxLength: 1, uniqueItems: false, additionalProperties: true,
    dependencies: {},
  })) rejected({ $ref: "#/definitions/n", definitions: { n: true }, [key]: value }, "ref-sibling-assertion", [key]);
});

test("resolves local pointers, URI escapes, array positions, and special own keys", () => {
  const result = ready(JSON.parse(`{
    "$defs": {"a/b~c": true, "": false, "__proto__": {"type":"number"}},
    "allOf": [{"$ref":"#/$defs/a~1b~0c"}, {"$ref":"#%2F$defs%2F"}, {"$ref":"#/$defs/__proto__"}]
  }`));
  const refs = [...result.prepared.nodes.values()].filter((node) => node.reference !== undefined);
  assert.equal(refs.length, 3);
  for (const ref of refs) assert.ok(result.prepared.nodes.has(ref.reference!));
  ready({ definitions: { a: { allOf: [true] } }, $ref: "#/definitions/a/allOf/0" });
  for (const keyword of ["const", "default", "examples", "enum"]) {
    const array = keyword === "examples" || keyword === "enum";
    const literal = { nested: { type: "number" } };
    ready({
      [keyword]: array ? [literal] : literal,
      allOf: [{ $ref: `#/${keyword}/${array ? "0/" : ""}nested` }],
    });
  }
  ready({ definitions: { "x y": true, "%": true }, allOf: [{ $ref: "#/definitions/x%20y" }, { $ref: "#/definitions/%25" }] });
});

test("rejects remote, unresolved, malformed, and non-schema reference targets", () => {
  for (const ref of ["https://example.com/schema", "other.json#/x", "#anchor"]) {
    rejected({ $ref: ref }, "unsupported-reference", ["$ref"]);
  }
  for (const ref of ["#/missing", "#/definitions/a~2b", "#/%GG", "#/definitions/toString"]) {
    rejected({ $ref: ref, definitions: {} }, "unresolved-reference", ["$ref"]);
  }
  rejected({ const: "literal", allOf: [{ $ref: "#/const" }] }, "unresolved-reference");
  rejected({ definitions: { a: { allOf: [true] } }, $ref: "#/definitions/a/allOf/00" }, "unresolved-reference");
  rejected({ definitions: { unused: { $ref: "#/missing" } } }, "unresolved-reference", ["definitions", "unused", "$ref"]);
});

test("rejects every same-instance cycle, including unused definitions and schema dependencies", () => {
  for (const schema of [
    { $ref: "#" },
    { definitions: { unused: { allOf: [{ $ref: "#/definitions/unused" }] } } },
    { definitions: { a: { $ref: "#/definitions/b" }, b: { $ref: "#/definitions/a" } } },
    { dependencies: { x: { $ref: "#" } } },
    { anyOf: [{ $ref: "#" }] }, { oneOf: [{ $ref: "#" }] }, { not: { $ref: "#" } },
    { if: { $ref: "#" }, then: true },
  ]) rejected(schema, "non-consuming-cycle");
});

test("property and item descent break cycles; long acyclic chains use an explicit stack", () => {
  for (const schema of [
    { properties: { next: { $ref: "#" } } },
    { items: { allOf: [{ $ref: "#" }] } },
    { additionalProperties: { $ref: "#" } },
    { contains: { $ref: "#" } },
  ]) ready(schema);
  const definitions: Record<string, unknown> = { end: true };
  for (let i = 0; i < 300; i++) definitions[`n${i}`] = { $ref: i === 299 ? "#/definitions/end" : `#/definitions/n${i + 1}` };
  const result = ready({ $ref: "#/definitions/n0", definitions });
  assert.equal(result.prepared.nodes.size, 302);
});

test("never mutates frozen schemas and has no invocation-dependent state", () => {
  const schema = Object.freeze({
    properties: Object.freeze({ answer: Object.freeze({ type: "number" }) }),
    default: Object.freeze({ answer: 3 }),
  });
  const before = JSON.stringify(schema);
  const first = ready(schema);
  ready({ format: "email" });
  assert.deepEqual(ready(schema), first);
  assert.equal(JSON.stringify(schema), before);
  const reordered = ready({ default: { answer: 3 }, properties: { answer: { type: "number" } } });
  assert.deepEqual(reordered, first);
});

test("work, storage, size and nesting limits have exact deterministic boundaries", () => {
  const schema = { properties: { answer: { type: "number" } } };
  const result = ready(schema);
  const exact = { ...limits, workLimit: result.stats.work, storageLimit: result.stats.storage };
  assert.deepEqual(preflightJsonSchema(schema, exact), result);
  for (const [key, code] of [["workLimit", "work-limit"], ["storageLimit", "storage-limit"]] as const) {
    const stopped = preflightJsonSchema(schema, { ...exact, [key]: exact[key] - 1 });
    assert.equal(stopped.status, "not-evaluated");
    if (stopped.status === "not-evaluated") assert.equal(stopped.diagnostic.code, code);
  }
  assert.equal(preflightJsonSchema(schema, { ...limits, maxSchemaCodeUnits: JSON.stringify(schema).length }).status, "ready");
  const oversized = preflightJsonSchema(schema, { ...limits, maxSchemaCodeUnits: JSON.stringify(schema).length - 1 });
  assert.equal(oversized.status, "not-evaluated");
  if (oversized.status === "not-evaluated") assert.equal(oversized.diagnostic.code, "schema-too-large");
  let nested: unknown = true;
  for (let i = 0; i < 63; i++) nested = { not: nested };
  ready(nested);
  rejected({ not: nested }, "schema-depth-limit");
  rejected({ description: "x".repeat(limits.maxSchemaCodeUnits) }, "schema-too-large");
});

test("invalid JSON values and cyclic input fail with owned diagnostics", () => {
  const cycle: Record<string, unknown> = {};
  cycle.default = cycle;
  const sparse = Array(2);
  for (const value of [undefined, NaN, Infinity, { default: undefined }, { default: BigInt(1) }, { default: sparse }, { default: new Date() }, cycle]) {
    rejected(value, "non-json-schema");
  }
  for (const value of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => preflightJsonSchema(true, { ...limits, workLimit: value }), /non-negative safe integers/);
  }
  ready(JSON.parse('{"properties":{"__proto__":{"type":"number"},"constructor":false}}'));
});
