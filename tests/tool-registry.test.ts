import assert from "node:assert/strict";
import test from "node:test";

import {
  createRegistryTool,
  emptyToolRegistry,
  parseToolRegistry,
  snapshotRegistryTool,
} from "../packages/core/src/tool-registry.ts";
import { createEntityId } from "../packages/core/src/run-kernel/types.ts";

const createdAt = "2026-07-24T12:00:00.000Z";

test("creates an empty versioned registry", () => {
  assert.deepEqual(emptyToolRegistry(), { schemaVersion: 1, tools: [] });
});

test("parses valid registry tools and rejects an invalid registry atomically", () => {
  const tool = createRegistryTool("registry-tool_search", createdAt, 0);
  assert.deepEqual(parseToolRegistry({ schemaVersion: 1, tools: [tool] }), {
    schemaVersion: 1,
    tools: [tool],
  });
  assert.deepEqual(
    parseToolRegistry({ schemaVersion: 1, tools: [{ ...tool, name: "" }] }),
    emptyToolRegistry(),
  );
  assert.deepEqual(
    parseToolRegistry({
      schemaVersion: 1,
      tools: [{ ...tool, providerOptions: { api_key: "secret" } }],
    }),
    emptyToolRegistry(),
  );
});

test("rejects a registry whose tool name a provider would refuse", () => {
  const tool = createRegistryTool("registry-tool_search", createdAt, 0);

  ["get weather", "search\ttool", "search.tool", "búsqueda", "a".repeat(65)].forEach(
    (name) => {
      assert.deepEqual(
        parseToolRegistry({ schemaVersion: 1, tools: [{ ...tool, name }] }),
        emptyToolRegistry(),
        `expected "${name}" to be rejected`,
      );
    },
  );

  ["get_weather", "get-weather", "getWeather9", "a".repeat(64)].forEach((name) => {
    assert.deepEqual(
      parseToolRegistry({ schemaVersion: 1, tools: [{ ...tool, name }] }),
      { schemaVersion: 1, tools: [{ ...tool, name }] },
      `expected "${name}" to be accepted`,
    );
  });
});

test("snapshots a registry tool under a fresh project-scoped identity", () => {
  const source = createRegistryTool("registry-tool_search", createdAt, 0);
  source.name = "search";
  source.inputSchema.properties = {
    query: { type: "string" },
  };
  const snapshot = snapshotRegistryTool(
    source,
    createEntityId("tool", "project-copy"),
  );

  assert.equal(snapshot.id, "tool_project-copy");
  assert.equal(snapshot.name, "search");
  assert.notEqual(snapshot.inputSchema, source.inputSchema);
  assert.deepEqual(snapshot.inputSchema, source.inputSchema);

  (snapshot.inputSchema.properties as Record<string, unknown>).limit = {
    type: "number",
  };
  assert.notDeepEqual(snapshot.inputSchema, source.inputSchema);
});
