import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { spawn } from "node:child_process";

/**
 * Every local fixture server has to stop when it is told to, while a client is
 * still holding a connection open.
 *
 * That qualifier is the whole test. All of these fixtures already stopped
 * promptly when nothing was connected, which is why the bug survived: the
 * n8n fixtures shut down with `server.close(() => process.exit(0))`, and
 * `close()` waits for open connections to end rather than ending them. With a
 * client mid-request, the callback never ran, SIGTERM was effectively ignored,
 * and the fixture kept its port until something SIGKILLed it — which is how a
 * later run comes to fail with a port already in use rather than with anything
 * that names the real cause.
 *
 * The connection here is a request whose headers never terminate. It is the
 * cheapest thing that is true of every fixture regardless of what it serves,
 * and it leaves the connection genuinely active rather than idle — Node closes
 * idle keep-alive sockets on `close()` by itself, so an idle one would pass
 * against the broken shutdown too.
 */
const FIXTURES = [
  ["scripts/buffered-openai-provider.mjs", "INFERENCE_LENS_BUFFERED_PORT"],
  ["scripts/echo-openai-provider.mjs", "INFERENCE_LENS_ECHO_PORT"],
  ["scripts/flaky-openai-provider.mjs", "INFERENCE_LENS_FLAKY_PORT"],
  ["scripts/large-catalogue-provider.mjs", "INFERENCE_LENS_LARGE_CATALOGUE_PORT"],
  ["scripts/markdown-openai-provider.mjs", "INFERENCE_LENS_MARKDOWN_PORT"],
  ["scripts/paced-openai-provider.mjs", "INFERENCE_LENS_PACED_PORT"],
  ["scripts/reasoning-openai-provider.mjs", "INFERENCE_LENS_REASONING_PORT"],
  ["scripts/repeated-experiment-provider.mjs", "INFERENCE_LENS_REPEAT_PORT"],
  ["scripts/n8n-echo-provider.mjs", "INFERENCE_LENS_N8N_ECHO_PORT"],
  ["scripts/n8n-public-api-fixture.mjs", "INFERENCE_LENS_N8N_FIXTURE_PORT"],
];

/** Generous for a loopback server that only has to bind a port. */
const START_TIMEOUT_MS = 10_000;
/** Prompt is the property: a fixture that needs seconds is a fixture that hangs. */
const STOP_TIMEOUT_MS = 3_000;

function waitForListening(child, port) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  return (async function attempt() {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`fixture exited with code ${child.exitCode} before listening`);
      }
      const connected = await new Promise((resolve) => {
        const probe = net.connect(port, "127.0.0.1");
        probe.once("connect", () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", () => resolve(false));
      });
      if (connected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`fixture did not listen on ${port} within ${START_TIMEOUT_MS}ms`);
  })();
}

/** Opens a request and deliberately never finishes sending it. */
function holdOpenRequest(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write("GET /v1/models HTTP/1.1\r\nHost: localhost\r\n");
      // The blank line that would end the headers is never sent.
      setTimeout(() => resolve(socket), 150);
    });
  });
}

// Distinct per fixture so the files can run concurrently without colliding.
let nextPort = 45_200;

for (const [script, portVariable] of FIXTURES) {
  test(`${script} stops on SIGTERM with a client connected`, async (t) => {
    const port = nextPort++;
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, [portVariable]: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));

    let socket;
    t.after(() => {
      socket?.destroy();
      if (child.exitCode === null) child.kill("SIGKILL");
    });

    await waitForListening(child, port);
    socket = await holdOpenRequest(port);

    const stopped = new Promise((resolve) => child.once("exit", () => resolve(true)));
    child.kill("SIGTERM");
    const exited = await Promise.race([
      stopped,
      new Promise((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
    ]);

    assert.ok(
      exited,
      `${script} ignored SIGTERM for ${STOP_TIMEOUT_MS}ms while a client held a ` +
        `connection open; it would keep port ${port} until killed.${stderr ? `\n${stderr}` : ""}`,
    );
  });
}
