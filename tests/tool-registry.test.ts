import assert from "node:assert/strict";
import test from "node:test";

import {
  createRegistryTool,
  emptyToolRegistry,
  parseToolRegistry,
  parseToolRegistryFile,
  parseToolRegistryJson,
  serializeToolRegistry,
  snapshotRegistryTool,
  ToolRegistryConflictError,
  ToolRegistryValidationError,
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

test("strict parsing distinguishes corrupt persistence from an empty registry", () => {
  const tool = createRegistryTool("registry-tool_search", createdAt, 0);

  assert.deepEqual(
    parseToolRegistryJson(JSON.stringify({ schemaVersion: 1, tools: [tool] })),
    { schemaVersion: 1, tools: [tool] },
  );
  assert.throws(
    () =>
      parseToolRegistryFile({
        schemaVersion: 1,
        tools: [{ ...tool, providerOptions: { api_key: "secret" } }],
      }),
    (error) =>
      error instanceof ToolRegistryValidationError &&
      error.issues.some(
        ({ path, message }) =>
          path.join(".") === "tools.0.providerOptions.api_key" &&
          message === "Secret-bearing fields are not valid registry data.",
      ),
  );
  assert.throws(
    () => parseToolRegistryJson("{"),
    (error) =>
      error instanceof ToolRegistryValidationError &&
      error.message.includes("File is not valid JSON."),
  );
});

test("serializes registries deterministically with a trailing newline", () => {
  const tool = createRegistryTool("registry-tool_search", createdAt, 0);
  tool.name = "search";
  tool.inputSchema = {
    properties: {
      query: {
        description: "Search query",
        type: "string",
      },
    },
    additionalProperties: false,
    type: "object",
  };

  const serialized = serializeToolRegistry({
    tools: [tool],
    schemaVersion: 1,
  });

  assert.equal(
    serialized,
    `{
  "schemaVersion": 1,
  "tools": [
    {
      "id": "registry-tool_search",
      "name": "search",
      "description": "",
      "inputSchema": {
        "additionalProperties": false,
        "properties": {
          "query": {
            "description": "Search query",
            "type": "string"
          }
        },
        "type": "object"
      },
      "createdAt": "2026-07-24T12:00:00.000Z",
      "updatedAt": "2026-07-24T12:00:00.000Z"
    }
  ]
}
`,
  );
  assert.equal(
    serializeToolRegistry(parseToolRegistryJson(serialized)),
    serialized,
  );
});

test("registry conflicts preserve the expected and actual opaque revisions", () => {
  const error = new ToolRegistryConflictError("revision_old", "revision_new");

  assert.equal(error.name, "ToolRegistryConflictError");
  assert.equal(error.expectedRevision, "revision_old");
  assert.equal(error.actualRevision, "revision_new");
  assert.match(error.message, /changed after it was loaded/i);
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
