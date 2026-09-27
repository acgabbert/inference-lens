import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * The browser lane that runs against the official Python MCP SDK.
 *
 * The Node fixture's SDK negotiates at most `2025-11-25`, so a run on a newer
 * protocol, and a server process that is really killed, need the Python
 * server. Prepare `.venv-mcp` from `scripts/requirements-mcp.txt`; the
 * ordinary config skips this lane's spec and needs no Python.
 */
export const PYTHON_MCP_PORT = 44024;
/** Started and killed by the spec itself, once per test. */
export const PYTHON_MCP_KILL_PORT = 44025;

const python = { transport: "streamable-http", callTimeoutMs: 120_000, authorization: { kind: "none" } };
const catalog = JSON.parse(readFileSync("tests/fixtures/mcp-servers/catalog.json", "utf8"));
catalog.servers.push(
  { id: "python-local", label: "Python local MCP example", endpoint: `http://127.0.0.1:${PYTHON_MCP_PORT}/mcp`, ...python },
  { id: "python-kill", label: "Python MCP example to kill", endpoint: `http://127.0.0.1:${PYTHON_MCP_KILL_PORT}/mcp`, ...python },
);
const catalogPath = path.join(mkdtempSync(path.join(tmpdir(), "inference-lens-python-mcp-")), "catalog.json");
writeFileSync(catalogPath, JSON.stringify(catalog));
process.env.INFERENCE_LENS_PYTHON_MCP = "1";
const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  testMatch: "mcp-python.spec.ts",
  projects: base.projects?.filter(({ name }) => name === "chromium-light"),
  webServer: [
    ...servers.map((server, index) => index === 0
      ? { ...server, env: { ...server.env, INFERENCE_LENS_MCP_SERVERS: catalogPath } }
      : server),
    {
      command: ".venv-mcp/bin/python scripts/local-mcp-server.py",
      // A GET on /mcp is not a health check for MCP; an open port is enough
      // here, and the spec's discovery proves the protocol connection.
      port: PYTHON_MCP_PORT,
      reuseExistingServer: false,
      timeout: 15_000,
      env: { INFERENCE_LENS_LOCAL_MCP_PORT: String(PYTHON_MCP_PORT) },
    },
  ],
});
