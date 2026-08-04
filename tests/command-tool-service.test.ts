import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  COMMAND_TOOLS_VARIABLE,
  executeCommandTool,
  readCommandToolCatalog,
  resolveCommandToolExecutionRequest,
  WorkbenchRequestError,
} from "../services/api/src/index.ts";

const fixtureCatalog = fileURLToPath(
  new URL("./fixtures/command-tools/catalog.json", import.meta.url),
);

function withCatalog(contents: string, run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "command-tool-catalog-"));
  const path = join(directory, "catalog.json");
  writeFileSync(path, contents);
  try {
    run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a service with no catalog declares nothing, and says so without alarm", () => {
  const source = readCommandToolCatalog({});

  assert.deepEqual(source, { available: false, commands: [] });
});

test("a catalog that cannot be used is reported, never silently empty", () => {
  const missing = readCommandToolCatalog({
    [COMMAND_TOOLS_VARIABLE]: join(tmpdir(), "definitely-not-here.json"),
  });
  assert.equal(missing.available, false);
  assert.match(missing.problem ?? "", new RegExp(COMMAND_TOOLS_VARIABLE));

  withCatalog("{ not json", (path) => {
    const broken = readCommandToolCatalog({ [COMMAND_TOOLS_VARIABLE]: path });
    assert.equal(broken.available, false);
    assert.match(broken.problem ?? "", /not JSON/i);
  });

  withCatalog(
    JSON.stringify({ schemaVersion: 1, commands: [{ id: "weather" }] }),
    (path) => {
      const invalid = readCommandToolCatalog({ [COMMAND_TOOLS_VARIABLE]: path });
      assert.equal(invalid.available, false);
      assert.match(invalid.problem ?? "", /executable/i);
    },
  );
});

/**
 * A catalog and the scripts it declares are one thing an operator moves
 * around; the service's working directory is not something they chose.
 */
test("a relative executable resolves against the catalog, not the process", () => {
  const source = readCommandToolCatalog({
    [COMMAND_TOOLS_VARIABLE]: fixtureCatalog,
  });

  assert.equal(source.available, true);
  const weather = source.commands.find(({ id }) => id === "weather");
  assert.ok(weather && isAbsolute(weather.executable));
  assert.match(weather.executable, /fixtures\/command-tools\/weather\.mjs$/);
});

test("a declared command runs and answers the call", async () => {
  const outcome = await executeCommandTool(
    {
      commandId: "weather",
      tool: "get_weather",
      toolCallId: "tool-call_1",
      arguments: '{"city":"Boston"}',
    },
    { environment: { ...process.env, [COMMAND_TOOLS_VARIABLE]: fixtureCatalog } },
  );

  assert.deepEqual(outcome, {
    status: "completed",
    content: [
      {
        type: "text",
        text: "61F and drizzle in Boston, measured by get_weather (v1)",
      },
    ],
    isError: false,
  });
});

/**
 * The catalog is the ceiling. A page that asks for something undeclared is
 * refused by policy — which is a different fact from a command that failed,
 * and the vocabulary has said so since T1.
 */
test("an undeclared command is rejected, not attempted", async () => {
  const outcome = await executeCommandTool(
    {
      commandId: "/bin/sh",
      tool: "get_weather",
      toolCallId: "tool-call_1",
      arguments: "{}",
    },
    { environment: { ...process.env, [COMMAND_TOOLS_VARIABLE]: fixtureCatalog } },
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.status === "failed" && outcome.failure.kind, "rejected");
});

test("a service with no catalog rejects every command, naming the fix", async () => {
  const outcome = await executeCommandTool(
    {
      commandId: "weather",
      tool: "get_weather",
      toolCallId: "tool-call_1",
      arguments: "{}",
    },
    { environment: {} },
  );

  assert.equal(outcome.status === "failed" && outcome.failure.kind, "rejected");
  assert.match(
    outcome.status === "failed" ? outcome.failure.message : "",
    new RegExp(COMMAND_TOOLS_VARIABLE),
  );
});

test("a malformed request is refused before anything runs", () => {
  assert.throws(
    () => resolveCommandToolExecutionRequest({ tool: "get_weather" }),
    WorkbenchRequestError,
  );
  assert.throws(
    () => resolveCommandToolExecutionRequest({ commandId: "  ", tool: "t", toolCallId: "c", arguments: "{}" }),
    WorkbenchRequestError,
  );
  assert.deepEqual(
    resolveCommandToolExecutionRequest({
      commandId: " weather ",
      tool: "get_weather",
      toolCallId: "tool-call_1",
      arguments: "{}",
    }),
    {
      commandId: "weather",
      tool: "get_weather",
      toolCallId: "tool-call_1",
      arguments: "{}",
    },
  );
});
