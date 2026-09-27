import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMcpTools } from "../services/api/src/mcp-discovery.ts";
import { parseMcpServerCatalog, publicMcpServer } from "../services/api/src/mcp-server-catalog.ts";
import { snapshotMcpTool } from "../app/tools/mcp-tool-snapshot.ts";
import { createEntityId } from "../packages/core/src/run-kernel/types.ts";
import { createProjectFile, parseProjectFile, serializeProjectFile } from "../packages/core/src/project.ts";
import type { Tool } from "@modelcontextprotocol/client";

function catalog(endpoint = "http://127.0.0.1:44018/mcp") {
  return { schemaVersion: 1, servers: [{ id: "fixture", label: "Fixture", endpoint, transport: "streamable-http", authorization: { kind: "none" } }] };
}

test("the MCP catalog pins a safe host endpoint and publishes only its origin", () => {
  const [server] = parseMcpServerCatalog(catalog());
  assert.equal(server.connectTimeoutMs, 10_000);
  assert.equal(server.maxResponseBytes, 1_048_576);
  assert.deepEqual(publicMcpServer(server), { id: "fixture", label: "Fixture", endpointIdentity: "http://127.0.0.1:44018", executionAvailable: true });
  for (const endpoint of [
    "http://example.com/mcp",
    "https://user:secret@example.com/mcp",
    "https://example.com/mcp?token=secret",
    "file:///tmp/mcp",
  ]) assert.throws(() => parseMcpServerCatalog(catalog(endpoint)));
  assert.throws(() => parseMcpServerCatalog({ ...catalog(), servers: [catalog().servers[0], catalog().servers[0]] }), /Duplicate server id/);
});

test("discovery fingerprints stable descriptors and refuses invalid schemas", () => {
  const raw: Tool = { name: "lookup_record", description: "Find a record.", inputSchema: { type: "object", properties: { record_id: { type: "string" } } } };
  const [first] = normalizeMcpTools([raw]);
  assert.match(first.fingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.equal(normalizeMcpTools([{ ...raw, inputSchema: { properties: { record_id: { type: "string" } }, type: "object" } }])[0]?.fingerprint, first.fingerprint);
  assert.notEqual(normalizeMcpTools([{ ...raw, description: "Changed." }])[0]?.fingerprint, first.fingerprint);
  assert.match(normalizeMcpTools([{ ...raw, inputSchema: { type: "array" } } as unknown as Tool])[0]?.invalidReason ?? "", /input schema/i);
  assert.match(normalizeMcpTools([raw, raw])[0]?.invalidReason ?? "", /duplicate/i);
});

test("an attached MCP descriptor survives project export without host capability", () => {
  const [discovered] = normalizeMcpTools([{ name: "lookup_record", description: "Find a record.", inputSchema: { type: "object", properties: {} } }]);
  const snapshot = snapshotMcpTool(discovered, "lookup_record", createEntityId("tool", "mcp-fixture"));
  const project = createProjectFile({
    name: "MCP snapshot", idSuffix: "mcp-fixture", createdAt: "2026-09-24T00:00:00.000Z",
    request: { provider: "openai-compatible", endpoint: "https://provider.example.test/v1", model: "fixture-model", messages: [{ role: "user", content: "Hello" }] },
  });
  const exported = serializeProjectFile({ ...project, tools: [snapshot] });
  const parsed = parseProjectFile(JSON.parse(exported));
  assert.deepEqual(parsed.tools[0], snapshot);
  assert.equal(snapshot.source?.remoteToolName, "lookup_record");
  for (const forbidden of ["127.0.0.1", "44018", "serverId", "authorization", "sessionId", "grantedAt"]) assert.equal(exported.includes(forbidden), false);
  assert.equal(JSON.stringify(parsed.tools[0]).includes("endpoint"), false);
});
