import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_COMMAND_TOOL_GRANTS_STORAGE_KEY,
  LOCAL_TOOL_GRANTS_STORAGE_KEY,
  localToolGrantCheckItem,
  mcpToolBinding,
  readLocalToolGrants,
  withLocalToolGrant,
  withoutLocalToolGrant,
  writeLocalToolGrants,
} from "../app/tools/local-tool-grants.client.ts";
import type { LocalToolGrant, McpToolGrant } from "../app/tools/local-tool-grants.client.ts";
import type { ToolDefinition } from "../packages/core/src/run-kernel/types.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const FINGERPRINT = "a".repeat(64);

const mcpGrant: McpToolGrant = {
  kind: "mcp",
  toolId: "tool_lookup",
  serverId: "execution-fixture",
  remoteToolName: "lookup_record",
  discoveryFingerprint: FINGERPRINT,
  mode: "ask",
  grantedAt: "2026-09-26T10:00:00.000Z",
};

const lookupTool: ToolDefinition = {
  id: "tool_lookup",
  name: "lookup_record",
  inputSchema: { type: "object" },
  source: { kind: "mcp", remoteToolName: "lookup_record", discoveryFingerprint: FINGERPRINT },
};

test("Version 1 command grants migrate once and still resolve", () => {
  const storage = memoryStorage({
    [LEGACY_COMMAND_TOOL_GRANTS_STORAGE_KEY]: JSON.stringify([
      { toolId: "tool_weather", commandId: "weather", grantedAt: "2026-08-04T10:00:00.000Z" },
      { toolId: "tool_broken" },
    ]),
  });

  const expected: LocalToolGrant[] = [
    { kind: "command", toolId: "tool_weather", commandId: "weather", grantedAt: "2026-08-04T10:00:00.000Z" },
  ];
  assert.deepEqual(readLocalToolGrants(storage), expected);
  assert.equal(storage.values.has(LEGACY_COMMAND_TOOL_GRANTS_STORAGE_KEY), false);
  assert.deepEqual(JSON.parse(storage.values.get(LOCAL_TOOL_GRANTS_STORAGE_KEY)!), expected);
  // A second read comes from Version 2 and is unchanged.
  assert.deepEqual(readLocalToolGrants(storage), expected);
});

test("Version 2 wins over a leftover Version 1 key, and unreadable storage yields none", () => {
  const storage = memoryStorage({
    [LOCAL_TOOL_GRANTS_STORAGE_KEY]: JSON.stringify([mcpGrant, { kind: "mcp", toolId: "tool_x" }]),
    [LEGACY_COMMAND_TOOL_GRANTS_STORAGE_KEY]: JSON.stringify([
      { toolId: "tool_weather", commandId: "weather", grantedAt: "now" },
    ]),
  });
  assert.deepEqual(readLocalToolGrants(storage), [mcpGrant]);
  assert.equal(storage.values.has(LEGACY_COMMAND_TOOL_GRANTS_STORAGE_KEY), false);

  assert.deepEqual(readLocalToolGrants(memoryStorage({ [LOCAL_TOOL_GRANTS_STORAGE_KEY]: "not json" })), []);
  assert.deepEqual(readLocalToolGrants(undefined), []);
});

test("a tool has one grant of any kind, so a second replaces the first", () => {
  const command: LocalToolGrant = { kind: "command", toolId: "tool_lookup", commandId: "weather", grantedAt: "now" };
  const granted = withLocalToolGrant([command], mcpGrant);
  assert.deepEqual(granted, [mcpGrant]);
  assert.deepEqual(withoutLocalToolGrant(granted, "tool_lookup"), []);

  const storage = memoryStorage();
  writeLocalToolGrants(granted, storage);
  assert.deepEqual(readLocalToolGrants(storage), [mcpGrant]);
});

test("an MCP grant resolves only for the snapshot it was granted against, with no approval mode", () => {
  const servers = [{ id: "execution-fixture", label: "Fixture", endpointIdentity: "http://127.0.0.1:44019" }];
  const binding = mcpToolBinding(mcpGrant, lookupTool, servers);
  assert.deepEqual(binding, {
    kind: "mcp",
    toolId: "tool_lookup",
    executorId: `lookup_record@${FINGERPRINT.slice(0, 12)}`,
    label: "Fixture",
    serverId: "execution-fixture",
    remoteToolName: "lookup_record",
    discoveryFingerprint: FINGERPRINT,
  });
  assert.equal(mcpToolBinding(mcpGrant, { ...lookupTool, source: { ...lookupTool.source!, discoveryFingerprint: "b".repeat(64) } }, servers), undefined);
  assert.equal(mcpToolBinding(mcpGrant, { ...lookupTool, source: undefined }, servers), undefined);
  assert.equal(mcpToolBinding(mcpGrant, lookupTool, []), undefined);
});

test("a grant names itself to the host without device configuration", () => {
  assert.deepEqual(localToolGrantCheckItem(mcpGrant), {
    toolId: "tool_lookup",
    kind: "mcp",
    serverId: "execution-fixture",
    remoteToolName: "lookup_record",
    discoveryFingerprint: FINGERPRINT,
  });
  assert.deepEqual(
    localToolGrantCheckItem({ kind: "command", toolId: "tool_weather", commandId: "weather", grantedAt: "now" }),
    { toolId: "tool_weather", kind: "command", commandId: "weather" },
  );
});
