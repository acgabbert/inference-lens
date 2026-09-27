import assert from "node:assert/strict";
import test from "node:test";

import { commandToolBinding } from "../app/tools/command-tool-bindings.client.ts";
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

test("a grant becomes a binding that carries no device-local configuration", () => {
  // One grant per tool and storage round-trips are the shared record's
  // contract, tested in local-tool-grants.test.ts.
  const grant: CommandToolGrant = {
    kind: "command",
    toolId,
    commandId: "weather",
    grantedAt: "2026-08-04T10:00:00.000Z",
  };
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
    kind: "command",
    toolId,
    commandId: "weather",
    grantedAt: "2026-08-04T10:00:00.000Z",
  };

  assert.equal(commandToolBinding(grant, []), undefined);
  assert.equal(commandToolBinding(grant, [{ ...weather, id: "other" }]), undefined);
});
