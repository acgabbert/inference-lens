import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { CommandToolDeclaration } from "../packages/core/src/command-tool-catalog.ts";
import {
  commandToolStdin,
  interpretCommandToolResult,
} from "../packages/core/src/command-tool-outcome.ts";
import { runCommandTool } from "../services/api/src/command-tool-runner.ts";

/**
 * The abstraction proof, run against real processes.
 *
 * The mock executor could not falsify T1's contract: it has no transport, no
 * timeout, and no asynchronous failure. Everything below does, and each case
 * has to land on a *different* normalized classification — a vocabulary where
 * a hang and a crash arrive as the same failure would be worthless to the
 * person reading the trace.
 */

const fixtures = fileURLToPath(new URL("./fixtures/command-tools/", import.meta.url));

function declare(
  script: string,
  overrides: Partial<CommandToolDeclaration> = {},
  extraArgs: string[] = [],
): CommandToolDeclaration {
  return {
    id: script.replace(/\.mjs$/, ""),
    label: script,
    // The interpreter is named explicitly here so these cases do not also
    // depend on the fixture's executable bit; the catalog path exercises the
    // shebang form instead.
    executable: process.execPath,
    args: [join(fixtures, script), ...extraArgs],
    timeoutMs: 5_000,
    maxOutputBytes: 1_048_576,
    resultFormat: "json",
    ...overrides,
  };
}

const call = commandToolStdin({
  tool: "get_weather",
  toolCallId: "tool-call_1",
  arguments: '{"city":"Chicago"}',
});

test("a successful command answers with what it read on stdin", async () => {
  const declaration = declare("weather.mjs");
  const result = await runCommandTool(declaration, call);

  assert.equal(result.status, "exited");
  const outcome = interpretCommandToolResult(result, declaration);
  assert.deepEqual(outcome, {
    status: "completed",
    content: [
      {
        type: "text",
        text: "61F and drizzle in Chicago, measured by get_weather",
      },
    ],
    isError: false,
  });
});

test("a reported tool error completes; a nonzero exit fails", async () => {
  const errored = declare("tool-error.mjs");
  const errorOutcome = interpretCommandToolResult(
    await runCommandTool(errored, call),
    errored,
  );
  assert.equal(errorOutcome.status, "completed");
  assert.equal(errorOutcome.status === "completed" && errorOutcome.isError, true);

  const broken = declare("exit-nonzero.mjs");
  const brokenOutcome = interpretCommandToolResult(
    await runCommandTool(broken, call),
    broken,
  );
  assert.equal(
    brokenOutcome.status === "failed" && brokenOutcome.failure.kind,
    "execution_failed",
  );
  assert.match(
    JSON.stringify(brokenOutcome),
    /credentials file missing/,
  );
});

test("silence and undecodable output are both refused, differently", async () => {
  const silent = declare("silent.mjs");
  const silentOutcome = interpretCommandToolResult(
    await runCommandTool(silent, call),
    silent,
  );
  assert.equal(
    silentOutcome.status === "failed" && silentOutcome.failure.kind,
    "invalid_result",
  );
  assert.match(
    silentOutcome.status === "failed" ? silentOutcome.failure.message : "",
    /wrote nothing to stdout/,
  );

  const garbage = declare("not-json.mjs");
  const garbageOutcome = interpretCommandToolResult(
    await runCommandTool(garbage, call),
    garbage,
  );
  assert.match(
    garbageOutcome.status === "failed" ? garbageOutcome.failure.message : "",
    /did not write a JSON result/,
  );
});

test("output above the cap stops the command instead of being truncated", async () => {
  const declaration = declare("flood.mjs", { maxOutputBytes: 4_096 });
  const result = await runCommandTool(declaration, call);

  assert.equal(result.status, "output_limit_exceeded");
  const outcome = interpretCommandToolResult(result, declaration);
  assert.equal(
    outcome.status === "failed" && outcome.failure.kind,
    "invalid_result",
  );
});

test("a command that never finishes is stopped, with its children", async () => {
  const directory = mkdtempSync(join(tmpdir(), "command-tool-tree-"));
  const pidPath = join(directory, "child.pid");
  try {
    const declaration = declare("hang.mjs", { timeoutMs: 500 }, [pidPath]);
    const started = Date.now();
    const result = await runCommandTool(declaration, call);

    assert.equal(result.status, "timeout");
    assert.ok(Date.now() - started < 4_000, "should not have waited for the process");

    // The grandchild is the point: a `child.kill()` that only reached the
    // process this executor spawned would leave it running.
    const childPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    await gone(childPid);

    const outcome = interpretCommandToolResult(result, declaration);
    assert.equal(outcome.status === "failed" && outcome.failure.kind, "timeout");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancelling a run stops the command mid-execution", async () => {
  const declaration = declare("hang.mjs", { timeoutMs: 30_000 });
  const controller = new AbortController();
  const running = runCommandTool(declaration, call, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);

  const result = await running;
  assert.equal(result.status, "cancelled");
  const outcome = interpretCommandToolResult(result, declaration);
  assert.equal(outcome.status === "failed" && outcome.failure.kind, "cancelled");
});

test("an already-cancelled run never starts a process", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCommandTool(declare("weather.mjs"), call, {
    signal: controller.signal,
  });

  assert.deepEqual(result, { status: "cancelled" });
});

test("a missing executable fails to start rather than hanging", async () => {
  const declaration = declare("weather.mjs", {
    executable: join(fixtures, "no-such-command"),
    args: [],
  });
  const result = await runCommandTool(declaration, call);

  assert.equal(result.status, "spawn_failed");
  assert.equal(
    interpretCommandToolResult(result, declaration).status,
    "failed",
  );
});

/**
 * The service holds provider credentials. A command tool is a different trust
 * domain and gets a constructed environment, not an inherited one.
 */
test("the service's own environment does not reach a command", async () => {
  const declaration = declare("env-report.mjs");
  const result = await runCommandTool(declaration, call, {
    environment: {
      PATH: process.env.PATH,
      INFERENCE_LENS_API_KEY: "sk-should-never-be-visible",
    },
  });

  const outcome = interpretCommandToolResult(result, declaration);
  assert.deepEqual(outcome, {
    status: "completed",
    content: [{ type: "text", text: "INFERENCE_LENS_API_KEY=absent" }],
    isError: false,
  });
});

/**
 * No shell, stated as a test rather than as a comment. An argument that looks
 * like shell syntax has to arrive as one argument.
 */
test("arguments are a vector, not a command line", async () => {
  const declaration = declare("weather.mjs", {
    executable: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify({content:[{type:'text',text:process.argv[1]}]}))",
      "$(id -un); echo pwned",
    ],
  });

  const outcome = interpretCommandToolResult(
    await runCommandTool(declaration, call),
    declaration,
  );
  assert.deepEqual(outcome, {
    status: "completed",
    content: [{ type: "text", text: "$(id -un); echo pwned" }],
    isError: false,
  });
});

/** Polls until the pid is unreachable, so the assertion is not a race. */
async function gone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`process ${pid} was still running`);
}
