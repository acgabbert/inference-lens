import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandToolCatalogError,
  DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  findCommandDeclaration,
  parseCommandToolCatalog,
} from "../packages/core/src/command-tool-catalog.ts";

function catalog(commands: unknown[]): unknown {
  return { schemaVersion: 1, commands };
}

test("a minimal declaration takes the documented defaults", () => {
  const parsed = parseCommandToolCatalog(
    catalog([{ id: "weather", executable: "/opt/bin/weather" }]),
  );

  assert.deepEqual(parsed.commands, [
    {
      id: "weather",
      label: "weather",
      executable: "/opt/bin/weather",
      args: [],
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
      // JSON rather than text, because text can never report a tool error and
      // a silent default that cannot fail is the wrong one to inherit.
      resultFormat: "json",
    },
  ]);
});

test("declared values survive parsing", () => {
  const parsed = parseCommandToolCatalog(
    catalog([
      {
        id: "db.query",
        label: "Query the fixture database",
        description: "Read-only.",
        executable: "./query",
        args: ["--json", "--limit", "5"],
        timeoutMs: 2_000,
        maxOutputBytes: 4_096,
        resultFormat: "text",
      },
    ]),
  );

  assert.deepEqual(parsed.commands[0], {
    id: "db.query",
    label: "Query the fixture database",
    description: "Read-only.",
    executable: "./query",
    args: ["--json", "--limit", "5"],
    timeoutMs: 2_000,
    maxOutputBytes: 4_096,
    resultFormat: "text",
  });
});

/**
 * A catalog is a permission, so an unusable one has to be reported rather than
 * treated as "nothing declared". The other registries in this project recover
 * silently because losing a malformed tool definition costs nothing; losing a
 * command silently sends an operator looking in the wrong place.
 */
test("an unusable catalog is refused, with the reason in the message", () => {
  assert.throws(
    () => parseCommandToolCatalog(catalog([{ id: "weather" }])),
    (error: unknown) =>
      error instanceof CommandToolCatalogError &&
      /executable/i.test(error.message),
  );

  assert.throws(
    () =>
      parseCommandToolCatalog(
        catalog([
          { id: "weather", executable: "/bin/a" },
          { id: "weather", executable: "/bin/b" },
        ]),
      ),
    (error: unknown) =>
      error instanceof CommandToolCatalogError &&
      /duplicate command id "weather"/i.test(error.message),
  );

  assert.throws(
    () => parseCommandToolCatalog({ schemaVersion: 2, commands: [] }),
    CommandToolCatalogError,
  );
});

test("a command id stays safe to put in a URL, a trace, and a log line", () => {
  assert.throws(
    () => parseCommandToolCatalog(catalog([{ id: "../../etc/passwd", executable: "/bin/a" }])),
    CommandToolCatalogError,
  );
  assert.throws(
    () => parseCommandToolCatalog(catalog([{ id: "weather tool", executable: "/bin/a" }])),
    CommandToolCatalogError,
  );
});

test("an unknown field is refused rather than ignored", () => {
  // A misspelled `timeout` that parsed happily would leave an operator certain
  // they had set one.
  assert.throws(
    () =>
      parseCommandToolCatalog(
        catalog([{ id: "weather", executable: "/bin/a", timeout: 5 }]),
      ),
    CommandToolCatalogError,
  );
});

test("a command is found by id", () => {
  const parsed = parseCommandToolCatalog(
    catalog([
      { id: "weather", executable: "/bin/a" },
      { id: "clock", executable: "/bin/b" },
    ]),
  );

  assert.equal(findCommandDeclaration(parsed, "clock")?.executable, "/bin/b");
  assert.equal(findCommandDeclaration(parsed, "absent"), undefined);
});
