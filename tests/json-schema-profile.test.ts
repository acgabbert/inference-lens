import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { evaluateJsonSchema } from "../packages/core/src/json-schema/evaluator.ts";
import type { JsonValue } from "../packages/core/src/run-kernel/types.ts";
import { preflightJsonSchema } from "../packages/core/src/json-schema/preflight.ts";

const root = new URL("../scripts/spikes/metered-json-schema/official/", import.meta.url);
interface Group {
  description: string;
  schema: unknown;
  tests: { description: string; data: JsonValue; valid: boolean }[];
}
interface Entry {
  file: string;
  description: string;
  tests: number;
  exclude?: string;
  rejectionCode?: string;
}

test("the pinned upstream snapshot fixes the supported core schema profile", async (t) => {
  const manifest: { revision: string; groups: Entry[] } = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.revision, "55719286c33ae0d1823bfb65fea10338a19bc37c");
  const groups = new Map<string, Group>();
  const files = (await readdir(new URL("draft7/", root))).filter((file) => file.endsWith(".json"));
  assert.equal(files.length, 37);
  for (const file of files) {
    const contents: Group[] = JSON.parse(await readFile(new URL(`draft7/${file}`, root), "utf8"));
    for (const group of contents) {
      const key = `${file}: ${group.description}`;
      assert.ok(!groups.has(key), `Duplicate upstream group: ${key}`);
      groups.set(key, group);
    }
  }
  assert.equal(groups.size, 258);
  assert.equal(manifest.groups.length, groups.size);
  let selected = 0;
  let excluded = 0;
  for (const entry of manifest.groups) {
    const key = `${entry.file}: ${entry.description}`;
    const group = groups.get(key);
    assert.ok(group, `Missing or duplicated manifest entry: ${key}`);
    groups.delete(key);
    assert.equal(group.tests.length, entry.tests, key);
    if (entry.exclude !== undefined) excluded += entry.tests;
    else selected += entry.tests;
    await t.test(key, () => {
      const result = preflightJsonSchema(group.schema, {
        workLimit: 4_000_000, storageLimit: 4_000_000,
        maxSchemaCodeUnits: 65_536, maxDepth: 64,
      });
      if (entry.exclude !== undefined) {
        assert.ok(entry.exclude.trim(), "Each exclusion needs an authored reason");
        assert.ok(entry.rejectionCode, "Each exclusion needs an explicit diagnostic code");
        assert.equal(result.status, "not-evaluated");
        if (result.status === "not-evaluated") assert.equal(result.diagnostic.code, entry.rejectionCode);
      } else {
        assert.equal(entry.rejectionCode, undefined, "Supported entries cannot carry a rejection code");
        assert.equal(result.status, "ready", JSON.stringify(result));
        for (const example of group.tests) {
          const evaluated = evaluateJsonSchema(group.schema, example.data, {
            schema: { workLimit: 4_000_000, storageLimit: 4_000_000, maxSchemaCodeUnits: 65_536, maxDepth: 64 },
            verdict: { workLimit: 4_000_000, storageLimit: 4_000_000 },
            diagnostics: { workLimit: 4_000_000, storageLimit: 4_000_000, maxIssues: 20 },
            maxDataDepth: 64,
          });
          assert.equal(evaluated.status, example.valid ? "valid" : "invalid", `${example.description}: ${JSON.stringify(evaluated)}`);
        }
      }
    });
  }
  assert.equal(groups.size, 0, "Every vendored group must appear exactly once");
  assert.equal(selected, 804);
  assert.equal(excluded, 125);
});
