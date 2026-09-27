import assert from "node:assert/strict";
import test from "node:test";

import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import type { McpDiscoveryResponse } from "../packages/contracts/src/mcp-discovery.ts";
import { executeMcpTool } from "../services/api/src/mcp-execution.ts";
import type { McpExecutionDependencies } from "../services/api/src/mcp-execution.ts";
import { checkToolBindings } from "../services/api/src/tool-binding-check.ts";
import type { McpServerDeclaration } from "../services/api/src/mcp-server-catalog.ts";

const FINGERPRINT = "a".repeat(64);

const declaration: McpServerDeclaration = {
  id: "fixture",
  label: "Fixture",
  endpoint: "http://127.0.0.1:44019/mcp",
  transport: "streamable-http",
  authorization: { kind: "none" },
  connectTimeoutMs: 1_000,
  callTimeoutMs: 1_000,
  maxResponseBytes: 1_048_576,
};

function discovery(tools: McpDiscoveryResponse["tools"]): McpDiscoveryResponse {
  return {
    server: { id: "fixture", label: "Fixture", endpointIdentity: "http://127.0.0.1:44019" },
    serverIdentity: { name: "fixture", version: "1" },
    protocolVersion: "2025-11-25",
    capabilities: { tools: true },
    refreshedAt: "2026-09-26T00:00:00.000Z",
    tools,
  };
}

const lookup = { remoteName: "lookup_record", fingerprint: FINGERPRINT, inputSchema: { type: "object" } };

function dependencies(overrides: Partial<McpExecutionDependencies> & { invoked?: string[] } = {}): McpExecutionDependencies {
  const invoked = overrides.invoked ?? [];
  return {
    discover: overrides.discover ?? (async () => discovery([lookup])),
    invoke: overrides.invoke ?? (async (_declaration, name) => {
      invoked.push(name);
      return { content: [{ type: "text", text: "ok" }] };
    }),
  };
}

const target = { remoteToolName: "lookup_record", discoveryFingerprint: FINGERPRINT };

test("a server that cannot be reached is unavailable and is never called", async () => {
  const invoked: string[] = [];
  const outcome = await executeMcpTool(declaration, target, {}, undefined, dependencies({
    invoked,
    discover: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:44019"); },
  }));
  assert.deepEqual(outcome, {
    status: "failed",
    failure: { kind: "unavailable", message: "The MCP server could not be reached." },
  });
  assert.deepEqual(invoked, []);
});

test("a changed or missing tool is unavailable and is never called", async () => {
  for (const tools of [[{ ...lookup, fingerprint: "b".repeat(64) }], [], [{ ...lookup, invalidReason: "Bad schema." }]]) {
    const invoked: string[] = [];
    const outcome = await executeMcpTool(declaration, target, {}, undefined, dependencies({
      invoked,
      discover: async () => discovery(tools),
    }));
    assert.equal(outcome.status === "failed" && outcome.failure.kind, "unavailable");
    assert.deepEqual(invoked, []);
  }
});

test("failures after the call is sent fail only that call", async () => {
  const timeout = await executeMcpTool(declaration, target, {}, undefined, dependencies({
    invoke: async () => { throw new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"); },
  }));
  assert.equal(timeout.status === "failed" && timeout.failure.kind, "timeout");

  const broken = await executeMcpTool(declaration, target, {}, undefined, dependencies({
    invoke: async () => { throw new Error("http://127.0.0.1:44019/mcp said no"); },
  }));
  assert.deepEqual(broken, {
    status: "failed",
    failure: { kind: "execution_failed", message: "The MCP server could not complete the call." },
  });
});

test("a binding check reports each tool and discovers each server once", async () => {
  let discoveries = 0;
  const results = await checkToolBindings(
    [
      { toolId: "tool_lookup", kind: "mcp", serverId: "fixture", ...target },
      { toolId: "tool_stale", kind: "mcp", serverId: "fixture", remoteToolName: "lookup_record", discoveryFingerprint: "c".repeat(64) },
      { toolId: "tool_gone", kind: "mcp", serverId: "removed", ...target },
      { toolId: "tool_remote", kind: "mcp", serverId: "remote", ...target },
      { toolId: "tool_command", kind: "command", commandId: "weather" },
      { toolId: "tool_old_command", kind: "command", commandId: "removed" },
    ],
    {
      mcpServers: [declaration, { ...declaration, id: "remote", endpoint: "https://mcp.example.test/mcp" }],
      commandIds: ["weather"],
      discover: async () => { discoveries += 1; return discovery([lookup]); },
    },
  );
  assert.deepEqual(results.map(({ toolId, status, reason }) => ({ toolId, status, reason })), [
    { toolId: "tool_lookup", status: "ready", reason: undefined },
    { toolId: "tool_stale", status: "unavailable", reason: "fingerprint_changed" },
    { toolId: "tool_gone", status: "unavailable", reason: "declaration_missing" },
    { toolId: "tool_remote", status: "unavailable", reason: "not_executable" },
    { toolId: "tool_command", status: "ready", reason: undefined },
    { toolId: "tool_old_command", status: "unavailable", reason: "declaration_missing" },
  ]);
  assert.equal(discoveries, 1);
});

test("a binding check reports an unreachable server for each of its tools", async () => {
  const results = await checkToolBindings(
    [{ toolId: "tool_lookup", kind: "mcp", serverId: "fixture", ...target }],
    { mcpServers: [declaration], commandIds: [], discover: async () => { throw new Error("down"); } },
  );
  assert.deepEqual(results.map(({ status, reason }) => [status, reason]), [["unavailable", "server_unreachable"]]);
});
