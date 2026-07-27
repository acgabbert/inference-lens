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

test("standalone Node server reads INFERENCE_LENS_API_KEY at runtime", async (t) => {
  const expectedKey = "runtime-only-test-key";
  let authorization;
  const provider = createServer((request, response) => {
    authorization = request.headers.authorization;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/models");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
  });
  const providerPort = await listen(provider);
  const appPort = await reservePort();
  const app = spawn("node", ["dist/standalone/server.js"], {
    env: {
      ...process.env,
      INFERENCE_LENS_API_KEY: expectedKey,
      INFERENCE_LENS_API_ENDPOINT: `http://127.0.0.1:${providerPort}/v1`,
      HOST: "127.0.0.1",
      PORT: String(appPort),
    },
    stdio: "ignore",
  });

  t.after(async () => {
    if (app.exitCode === null) {
      const exited = new Promise((resolve) => app.once("exit", resolve));
      app.kill("SIGTERM");
      await exited;
    }
    await close(provider);
  });

  await waitForServer(`http://127.0.0.1:${appPort}/`, app);
  const response = await fetch(`http://127.0.0.1:${appPort}/api/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: `http://127.0.0.1:${providerPort}/v1`,
      credential: { kind: "environment-default" },
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: ["test-model"] });
  assert.equal(authorization, `Bearer ${expectedKey}`);
});

test("standalone Node server rejects cross-origin credential redirection", async (t) => {
  const appPort = await reservePort();
  const app = spawn("node", ["dist/standalone/server.js"], {
    env: {
      ...process.env,
      INFERENCE_LENS_API_KEY: "runtime-only-test-key",
      INFERENCE_LENS_API_ENDPOINT: "https://api.example.test/v1",
      HOST: "127.0.0.1",
      PORT: String(appPort),
    },
    stdio: "ignore",
  });

  t.after(async () => {
    if (app.exitCode === null) {
      const exited = new Promise((resolve) => app.once("exit", resolve));
      app.kill("SIGTERM");
      await exited;
    }
  });

  await waitForServer(`http://127.0.0.1:${appPort}/`, app);
  const response = await fetch(`http://127.0.0.1:${appPort}/api/models`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: JSON.stringify({
      endpoint: "https://attacker.example/v1",
      credential: { kind: "environment-default" },
    }),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Cross-origin API requests are not allowed.",
  });
});
