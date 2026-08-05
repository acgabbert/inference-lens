import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import test from "node:test";

/**
 * What the render suite's shared Vite server owes the machine it ran on.
 *
 * Both properties here are invisible from inside a test file, because both
 * happen at teardown: the server closes and the dependency-optimizer cache is
 * removed only once the file is done. So the file under test is run as a real
 * child `node --test`, and the assertions are about what that child leaves
 * behind.
 *
 * These are regressions, not hypotheticals. Every render helper used to build
 * its own server per test and `mkdtemp` a cache directory that nothing ever
 * removed: one `npm test` left 146 directories and 127 MB in the temp
 * directory, and they accumulated across runs until the machine was rebooted.
 */
const PROBE = "tests/fixtures/ssr-probe.mjs";

/** Runs the probe to completion, or fails rather than hanging with it. */
function runProbe(timeoutMs) {
  return new Promise((resolve, reject) => {
    // `NODE_TEST_CONTEXT` is set for every process the runner starts, and a
    // child that inherits it declines to run any files at all — "run() is being
    // called recursively", on stderr, exit code 0. Left in place it makes both
    // assertions here pass against a probe that never rendered anything.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      ["--test", "--test-reporter=tap", PROBE],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const giveUp = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `The probe did not exit within ${timeoutMs}ms — a Vite server it ` +
            "left open is holding the event loop.",
        ),
      );
    }, timeoutMs);

    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(giveUp);
      resolve({ code, stdout, stderr });
    });
  });
}

// One run answers both questions, and running the probe twice would only pay
// Vite's startup again. Generous timeout: the bound under test is "terminates
// at all", not "is quick".
let probe;
const probed = () => (probe ??= runProbe(60_000));

test("a render file exits on its own once its shared server is closed", async () => {
  const { code, stdout, stderr } = await probed();
  assert.equal(code, 0, `probe failed:\n${stdout}\n${stderr}`);
});

test("the shared server leaves no dependency-optimizer cache behind", async () => {
  const { stdout, stderr } = await probed();

  // The TAP reporter forwards a child's stdout as a comment, so the marker
  // arrives prefixed rather than at the start of the line.
  const directories = [...stdout.matchAll(/^#\s*cache-dir:(.+?)\s*$/gm)].map(
    (match) => match[1],
  );
  assert.ok(
    directories.length > 0,
    `probe did not report its cache directories:\n${stdout}\n${stderr}`,
  );

  const survivors = directories.filter((directory) => existsSync(directory));
  assert.deepEqual(survivors, [], "cache directories outlived the test process");
});
