import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

// `npm run dev` is documented as reading the server configuration from the
// repository's .env files. The script runs plain `vite dev`, so that rests on
// the vinext plugin loading them, not on a CLI wrapper. This starts the real
// script and reads the server-default connection back from the running server.
//
// The probe values go in a mode-specific file under a mode nothing else uses.
// `.env.<mode>.local` outranks `.env.local` and `.env`, so a developer's own
// files neither clobber the probe nor get clobbered by it.
const mode = "dotenv-probe";
const probeFile = new URL(`../.env.${mode}.local`, import.meta.url);
const probe = {
  INFERENCE_LENS_API_ENDPOINT: "http://127.0.0.1:9/dotenv-probe/v1",
  INFERENCE_LENS_MODEL: "dotenv-probe-model",
  INFERENCE_LENS_API_KEY: "dotenv-probe-key",
};

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Could not determine a free port."));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

async function fetchWhenReady(url, child, output) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `\`npm run dev\` exited with code ${child.exitCode}:\n${output.join("")}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`\`npm run dev\` did not answer ${url}:\n${output.join("")}`);
}

test("`npm run dev` loads .env files into the server", async (t) => {
  await writeFile(
    probeFile,
    Object.entries(probe)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
  t.after(() => rm(probeFile, { force: true }));

  // A value already in the environment outranks every .env file, so the
  // developer's shell must not supply the variables under test.
  const env = { ...process.env };
  for (const name of Object.keys(probe)) delete env[name];

  const port = await reservePort();
  const output = [];
  const dev = spawn(
    "npm",
    [
      "run",
      "dev",
      "--",
      "--mode",
      mode,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    // Its own process group, so stopping it also stops the server under npm.
    { env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  dev.stdout.on("data", (chunk) => output.push(String(chunk)));
  dev.stderr.on("data", (chunk) => output.push(String(chunk)));
  t.after(async () => {
    if (dev.exitCode !== null || dev.signalCode !== null) return;
    const exited = new Promise((resolve) => dev.once("exit", resolve));
    process.kill(-dev.pid, "SIGTERM");
    await exited;
  });

  const response = await fetchWhenReady(
    `http://127.0.0.1:${port}/api/runtime-status`,
    dev,
    output,
  );
  const { connections } = await response.json();
  const serverDefault = connections.find(({ id }) => id === "default");

  assert.deepEqual(
    serverDefault && {
      endpoint: serverDefault.endpoint,
      model: serverDefault.model,
      credentialConfigured: serverDefault.credentialConfigured,
    },
    {
      endpoint: probe.INFERENCE_LENS_API_ENDPOINT,
      model: probe.INFERENCE_LENS_MODEL,
      credentialConfigured: true,
    },
  );
});
