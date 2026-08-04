import assert from "node:assert/strict";
import test from "node:test";

import {
  commandToolBinding,
  findCommandToolGrant,
  readCommandToolGrants,
  withCommandToolGrant,
  withoutCommandToolGrant,
  writeCommandToolGrants,
} from "../app/tools/command-tool-bindings.client.ts";
import type { CommandToolGrant } from "../app/tools/command-tool-bindings.client.ts";
import type { CommandToolDeclaration } from "../packages/core/src/command-tool-catalog.ts";
import type { ToolId } from "../packages/core/src/run-kernel/index.ts";

const weather: CommandToolDeclaration = {
  id: "weather",
  label: "Local weather script",
  executable: "/opt/tools/weather",
  args: [],
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
  resultFormat: "json",
};

const toolId = "tool_weather" as ToolId;

test("a tool has one grant, so a second replaces the first", () => {
  const first = withCommandToolGrant([], toolId, "weather", "2026-08-04T10:00:00.000Z");
  const second = withCommandToolGrant(first, toolId, "clock", "2026-08-04T11:00:00.000Z");

  assert.equal(second.length, 1);
  assert.equal(findCommandToolGrant(second, toolId)?.commandId, "clock");
  assert.equal(withoutCommandToolGrant(second, toolId).length, 0);
  // The input array is never mutated: React state holds it.
  assert.equal(first[0]?.commandId, "weather");
});

test("a grant becomes a binding that carries no device-local configuration", () => {
  const grant = withCommandToolGrant([], toolId, "weather", "2026-08-04T10:00:00.000Z")[0]!;
  const binding = commandToolBinding(grant, [weather]);

  assert.deepEqual(binding, {
    toolId,
    kind: "command",
    executorId: "weather",
    label: "Local weather script",
    grantedAt: "2026-08-04T10:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(binding), /opt\/tools/);
});

/**
 * Removing a command from the catalog is how an operator revokes it. A grant
 * that outlived its declaration must stop resolving, or a run would keep
 * claiming the tool is served by something that no longer exists.
 */
test("a grant whose command is gone resolves to nothing", () => {
  const grant: CommandToolGrant = {
    toolId,
    commandId: "weather",
    grantedAt: "2026-08-04T10:00:00.000Z",
  };

  assert.equal(commandToolBinding(grant, []), undefined);
  assert.equal(commandToolBinding(grant, [{ ...weather, id: "other" }]), undefined);
});

test("stored grants round-trip, and unreadable storage yields none", () => {
  let stored = "";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    },
  });

  try {
    writeCommandToolGrants([
      { toolId, commandId: "weather", grantedAt: "2026-08-04T10:00:00.000Z" },
    ]);
    assert.deepEqual(readCommandToolGrants(), [
      { toolId, commandId: "weather", grantedAt: "2026-08-04T10:00:00.000Z" },
    ]);

    stored = '{"toolId":"tool_weather"}';
    assert.deepEqual(readCommandToolGrants(), []);

    stored = "[{}, {\"toolId\":\"tool_a\",\"commandId\":\"c\",\"grantedAt\":\"now\"}]";
    assert.deepEqual(readCommandToolGrants(), [
      { toolId: "tool_a", commandId: "c", grantedAt: "now" },
    ]);

    stored = "not json";
    assert.deepEqual(readCommandToolGrants(), []);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});
