import assert from "node:assert/strict";
import test from "node:test";

import type { CommandToolDeclaration } from "../packages/core/src/command-tool-catalog.ts";
import {
  COMMAND_TOOL_STDIN_VERSION,
  commandToolStdin,
  interpretCommandToolResult,
} from "../packages/core/src/command-tool-outcome.ts";
import type { CommandProcessResult } from "../packages/core/src/command-tool-outcome.ts";

const declaration: CommandToolDeclaration = {
  id: "weather",
  label: "Local weather script",
  executable: "/home/someone/private-client/bin/weather",
  args: ["--json"],
  timeoutMs: 2_000,
  maxOutputBytes: 1_024,
  resultFormat: "json",
};

function classify(result: CommandProcessResult, overrides: Partial<CommandToolDeclaration> = {}) {
  return interpretCommandToolResult(result, { ...declaration, ...overrides });
}

test("a JSON envelope becomes a completed execution", () => {
  const outcome = classify({
    status: "exited",
    exitCode: 0,
    stdout: JSON.stringify({ content: [{ type: "text", text: "61F" }] }),
    stderr: "",
  });

  assert.deepEqual(outcome, {
    status: "completed",
    content: [{ type: "text", text: "61F" }],
    isError: false,
  });
});

test("non-text content survives the envelope, for the projection to handle", () => {
  const outcome = classify({
    status: "exited",
    exitCode: 0,
    stdout: JSON.stringify({
      content: [
        { type: "text", text: "Radar attached." },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    }),
    stderr: "",
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.status === "completed" && outcome.content.length, 2);
});

/**
 * The distinction the whole contract rests on. A tool that ran and said "no"
 * is a completed execution the model is entitled to reason about; a process
 * that fell over is not, and may not answer the model at all.
 */
test("a tool error completes; a nonzero exit fails", () => {
  const reported = classify({
    status: "exited",
    exitCode: 0,
    stdout: JSON.stringify({
      content: [{ type: "text", text: "no such city" }],
      isError: true,
    }),
    stderr: "",
  });
  assert.deepEqual(reported, {
    status: "completed",
    content: [{ type: "text", text: "no such city" }],
    isError: true,
  });

  const crashed = classify({
    status: "exited",
    exitCode: 3,
    stdout: JSON.stringify({ content: [{ type: "text", text: "ignored" }] }),
    stderr: "credentials file missing",
  });
  assert.equal(crashed.status, "failed");
  assert.equal(
    crashed.status === "failed" && crashed.failure.kind,
    "execution_failed",
  );
  assert.deepEqual(crashed.status === "failed" && crashed.failure.details, {
    exitCode: 3,
    stderr: "credentials file missing",
  });
});

test("each way of producing no usable result gets its own classification", () => {
  const cases: Array<[CommandProcessResult, string, RegExp]> = [
    [{ status: "cancelled" }, "cancelled", /cancelled/i],
    [{ status: "timeout", stderr: "" }, "timeout", /2000ms/],
    [
      { status: "output_limit_exceeded", stderr: "" },
      "invalid_result",
      /more than 1024 bytes/,
    ],
    [
      { status: "spawn_failed", message: "ENOENT" },
      "execution_failed",
      /could not be started/i,
    ],
    [
      { status: "exited", exitCode: 0, stdout: "   ", stderr: "" },
      "invalid_result",
      /wrote nothing to stdout/i,
    ],
    [
      { status: "exited", exitCode: 0, stdout: "everything is fine", stderr: "" },
      "invalid_result",
      /did not write a JSON result/i,
    ],
    [
      {
        status: "exited",
        exitCode: 0,
        stdout: JSON.stringify({ result: "61F" }),
        stderr: "",
      },
      "invalid_result",
      /not a tool result/i,
    ],
    [
      {
        status: "exited",
        exitCode: 0,
        stdout: JSON.stringify({ content: [] }),
        stderr: "",
      },
      "invalid_result",
      /not a tool result/i,
    ],
    [
      { status: "exited", exitCode: null, signal: "SIGSEGV", stdout: "", stderr: "" },
      "execution_failed",
      /signal SIGSEGV/,
    ],
  ];

  for (const [result, kind, message] of cases) {
    const outcome = classify(result);
    assert.equal(outcome.status, "failed", JSON.stringify(result));
    assert.equal(
      outcome.status === "failed" && outcome.failure.kind,
      kind,
      JSON.stringify(result),
    );
    assert.match(
      outcome.status === "failed" ? outcome.failure.message : "",
      message,
    );
  }
});

/**
 * A failure message travels into a run trace, and a trace is a portable
 * artifact a teammate opens. Keeping bindings device-local means nothing if an
 * error string writes the executable's path into one.
 */
test("no failure message or detail names the executable", () => {
  const results: CommandProcessResult[] = [
    { status: "timeout", stderr: "" },
    { status: "cancelled" },
    { status: "output_limit_exceeded", stderr: "" },
    { status: "spawn_failed", message: "spawn ENOENT" },
    { status: "exited", exitCode: 9, stdout: "", stderr: "" },
    { status: "exited", exitCode: 0, stdout: "nope", stderr: "" },
  ];

  for (const result of results) {
    const outcome = classify(result);
    const serialized = JSON.stringify(outcome);
    assert.doesNotMatch(serialized, /private-client/);
    assert.doesNotMatch(serialized, /--json/);
  }
});

test("text format takes stdout verbatim and can never report a tool error", () => {
  const outcome = classify(
    { status: "exited", exitCode: 0, stdout: "  61F and drizzle\n", stderr: "" },
    { resultFormat: "text" },
  );

  assert.deepEqual(outcome, {
    status: "completed",
    content: [{ type: "text", text: "  61F and drizzle\n" }],
    isError: false,
  });
});

test("stderr is bounded before it reaches evidence", () => {
  const outcome = classify({
    status: "exited",
    exitCode: 1,
    stdout: "",
    stderr: "e".repeat(5_000),
  });

  const details = outcome.status === "failed" ? outcome.failure.details : undefined;
  const stderr = (details as { stderr?: string } | undefined)?.stderr ?? "";
  assert.equal(stderr.length, 501);
  assert.ok(stderr.endsWith("…"));
});

/**
 * The model's own argument text is passed through rather than re-serialized.
 * A model that emits invalid JSON is a case this app exists to show, and a
 * repaired copy would hide it from the tool and from the person debugging it.
 */
test("stdin carries the call verbatim", () => {
  const stdin = commandToolStdin({
    tool: "get_weather",
    toolCallId: "tool-call_1",
    arguments: '{"city": "Chicago",}',
  });

  assert.ok(stdin.endsWith("\n"));
  assert.deepEqual(JSON.parse(stdin), {
    version: 1,
    tool: "get_weather",
    toolCallId: "tool-call_1",
    arguments: '{"city": "Chicago",}',
  });
});

/**
 * The catalog is versioned and the payload should be too: a script written
 * against v1 must be able to refuse a payload it does not understand rather
 * than misreading a field that moved.
 */
test("stdin declares its payload version", () => {
  const payload = JSON.parse(
    commandToolStdin({ tool: "t", toolCallId: "tool-call_1", arguments: "{}" }),
  );

  assert.equal(payload.version, COMMAND_TOOL_STDIN_VERSION);
  assert.equal(COMMAND_TOOL_STDIN_VERSION, 1);
});
