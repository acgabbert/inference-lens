import assert from "node:assert/strict";
import test from "node:test";
import { DataEncodings, indexData, DataStop } from "../packages/core/src/json-schema/data.ts";
import { indexSchema, SchemaMeter, SchemaStop } from "../packages/core/src/json-schema/resources.ts";
import type { JsonValue } from "../packages/core/src/run-kernel/types.ts";

const limits = { workLimit: 4_000_000, storageLimit: 4_000_000, maxSchemaCodeUnits: 65_536, maxDepth: 64 };
const meter = () => new SchemaMeter(limits);

test("lazy data encodings agree with authored JSON equality across escaped keys and scalars", () => {
  const values: JsonValue[] = [
    null, true, false, 0, -0, 1e-30, 1e30, "\u0000\n\"\\😀\ud800",
    [], {}, [[], {}, null, [0, true]],
    JSON.parse('{"__proto__":0,"constructor":[],"a/b~c":"value","":null}'),
    { z: [1, { "line\n\"": "tab\t" }], a: { b: 0 } },
  ];
  for (const value of values) {
    const root = indexData(value, meter());
    const encoded = new DataEncodings().canonical(root, meter());
    assert.equal(encoded, indexSchema(value, meter()).encoding);
    assert.deepEqual(JSON.parse(encoded), JSON.parse(JSON.stringify(value)));
  }
});

test("encoding a deep subtree emits the payload once and caches only requested nodes", () => {
  let value: JsonValue = "x".repeat(10_000);
  for (let i = 1; i < 64; i++) value = { next: value };
  const root = indexData(value, meter());
  const encodings = new DataEncodings();
  const initial = meter();
  assert.equal(encodings.canonical(root, initial), JSON.stringify(value));
  assert.ok(initial.stats.work < 50_000, `Single encoding used ${initial.stats.work} work units`);
  assert.ok(initial.stats.storage < 50_000, `Single encoding retained ${initial.stats.storage} units`);
  const hit = new SchemaMeter({ ...limits, workLimit: 1, storageLimit: 0 });
  assert.equal(encodings.canonical(root, hit), JSON.stringify(value));
  const child = root.children.get("next")!;
  // A parent request did not precompute and retain every descendant encoding.
  assert.throws(() => encodings.canonical(child, new SchemaMeter({ ...limits, workLimit: 1 })), SchemaStop);
  assert.equal(encodings.canonical(child, meter()), JSON.stringify((value as Record<string, JsonValue>).next));
  assert.throws(() => new DataEncodings().canonical(root, hit), SchemaStop);
});

test("cached descendants compose into a canonical parent without affecting equality", () => {
  const root = indexData({ z: [{ b: 2, a: 1 }], a: "text" }, meter());
  const encodings = new DataEncodings();
  const child = root.children.get("z")!;
  assert.equal(encodings.canonical(child, meter()), '[{"a":1,"b":2}]');
  assert.equal(encodings.canonical(root, meter()), '{"a":"text","z":[{"a":1,"b":2}]}');
});

test("lazy encoding has exact work/storage boundaries and failed construction never poisons its cache", () => {
  const root = indexData({ answer: ["private", 1] }, meter());
  const stats = meter();
  const expected = new DataEncodings().canonical(root, stats);
  for (const key of ["workLimit", "storageLimit"] as const) {
    const encodings = new DataEncodings();
    const exact = { ...limits, workLimit: stats.stats.work, storageLimit: stats.stats.storage };
    const stopped = new SchemaMeter({ ...exact, [key]: exact[key] - 1 });
    assert.throws(() => encodings.canonical(root, stopped), SchemaStop);
    assert.equal(encodings.canonical(root, new SchemaMeter(exact)), expected);
  }
});

test("structure-only indexing rejects cyclic, sparse, and non-JSON values at deterministic depth", () => {
  const cycle: Record<string, unknown> = {};
  cycle.next = cycle;
  const extraArray = [1];
  Object.assign(extraArray, { extra: true });
  for (const value of [cycle, Array(2), extraArray, [undefined], [NaN], [Infinity], { a: BigInt(1) }, new Date()]) {
    assert.throws(() => indexData(value as JsonValue, meter()), (error: unknown) => error instanceof DataStop && error.code === "non-json-data");
  }
  let deep: JsonValue = null;
  for (let i = 1; i < 64; i++) deep = [deep];
  indexData(deep, meter());
  assert.throws(() => indexData([deep], meter()), (error: unknown) => error instanceof DataStop && error.code === "data-depth-limit");
});
