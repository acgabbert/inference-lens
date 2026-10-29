#!/usr/bin/env node

import { createRequire } from "node:module";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

import { CHROMIUM_OVERRIDE_ENV, resolveChromium } from "./e2e-chromium.mjs";

const LOOPBACK_PROBE_TIMEOUT_MS = 2_000;
const BROWSER_INSTALL_TIMEOUT_MS = 90_000;
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");

function isListCommand(argv) {
  return argv.includes("--list");
}

async function assertLoopbackAvailable() {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out while probing loopback availability."));
      }, LOOPBACK_PROBE_TIMEOUT_MS);
      const cleanup = () => clearTimeout(timeout);
      server.once("error", (error) => {
        cleanup();
        reject(error);
      });
      server.once("listening", () => {
        cleanup();
        resolve();
      });
      server.listen(0, "127.0.0.1");
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      throw new Error(
        "E2E_RUNTIME_NO_LOOPBACK: this environment forbids loopback listeners. Run npm run test:e2e with host-network or out-of-sandbox permission.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}

function runCommand(argumentsList, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, ...argumentsList], {
      stdio: "inherit",
    });
    let timeout;
    const forwardSignal = (signal) => child.kill(signal);
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) process.on(signal, forwardSignal);
    if (timeoutMs) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Playwright browser provisioning exceeded ${timeoutMs / 1_000} seconds.`));
      }, timeoutMs);
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      for (const registeredSignal of signals) process.off(registeredSignal, forwardSignal);
      if (code === 0) resolve();
      else reject(new Error(`Playwright exited with ${signal ?? `status ${code}`}.`));
    });
  });
}

async function ensureChromium() {
  const { chromium } = await import("@playwright/test");
  const { executablePath, notice } = await resolveChromium({
    env: process.env,
    pinnedExecutable: chromium.executablePath(),
    installPinned: () => runCommand(["install", "chromium"], { timeoutMs: BROWSER_INSTALL_TIMEOUT_MS }),
  });
  if (notice) console.warn(`\n${notice}\n`);
  // The Playwright child inherits this, and the config launches it.
  if (executablePath) process.env[CHROMIUM_OVERRIDE_ENV] = executablePath;
  return notice;
}

async function main(argv = process.argv.slice(2)) {
  if (isListCommand(argv)) {
    await runCommand(["test", ...argv]);
    return;
  }
  await assertLoopbackAvailable();
  const chromiumNotice = await ensureChromium();
  try {
    await runCommand(["test", ...argv]);
  } finally {
    // Repeated after the results so a report of the run cannot miss it.
    if (chromiumNotice) console.warn(`\n${chromiumNotice}\n`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
