import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine the test server port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function reservePort() {
  const server = createServer();
  return listen(server).then(async (port) => {
    await close(server);
    return port;
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Standalone server exited with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Standalone server did not become ready.");
}

test("standalone Node server renders the Inference Lens workbench", async (t) => {
  const appPort = await reservePort();
  const app = spawn("node", ["dist/standalone/server.js"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(appPort) },
    stdio: "ignore",
  });
  t.after(async () => {
    if (app.exitCode === null) {
      const exited = new Promise((resolve) => app.once("exit", resolve));
      app.kill("SIGTERM");
      await exited;
    }
  });

  const url = `http://127.0.0.1:${appPort}/`;
  await waitForServer(url, app);
  const response = await fetch(url, { headers: { accept: "text/html" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Inference Lens — Inspect Every Model Run<\/title>/i);
  assert.match(html, /Inspect every model run/);
  assert.match(html, /Run request/);
  assert.match(html, /Download diagnostics/);
  assert.match(html, /Run history/);
  assert.match(html, /Prompt library/);
  assert.match(html, /Run data/);
  assert.match(html, /Run details/);
  assert.doesNotMatch(html, /Your site is taking shape/);
});
