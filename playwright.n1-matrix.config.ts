import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import scenarios from "./tests/fixtures/mcp-servers/n1-matrix.json" with { type: "json" };
import base from "./playwright.config";

// Fresh evidence for each invocation. Workers inherit this directory. Retries
// cannot reuse providers or Python execution receipts from a previous attempt.
const output = process.env.INFERENCE_LENS_N1_MATRIX_OUTPUT ?? mkdtempSync(path.join(tmpdir(), "inference-lens-n1-matrix-"));
process.env.INFERENCE_LENS_N1_MATRIX_OUTPUT = output;
for (const scenario of scenarios) mkdirSync(path.join(output, scenario.id), { recursive: true });
const catalog = JSON.parse(readFileSync("tests/fixtures/mcp-servers/catalog.json", "utf8"));
catalog.servers.push({ id: "n1-matrix", label: "N1 Python matrix", transport: "streamable-http",
  endpoint: "http://127.0.0.1:44030/mcp", callTimeoutMs: 5000, authorization: { kind: "none" } });
const catalogPath = path.join(output, "catalog.json");
writeFileSync(catalogPath, JSON.stringify(catalog));
const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  retries: 0,
  webServer: [
    ...servers.map((server, index) => index === 0
      ? { ...server, env: { ...server.env, INFERENCE_LENS_MCP_SERVERS: catalogPath } } : server),
    { command: ".venv-mcp/bin/python scripts/n1-matrix-mcp.py",
      url: "http://127.0.0.1:44030/health", reuseExistingServer: false, timeout: 15000,
      env: { INFERENCE_LENS_N1_MATRIX_OUTPUT: output } },
    ...scenarios.map((scenario) => ({
      command: "node scripts/n8n-tool-capture-provider.mjs",
      url: `http://127.0.0.1:${scenario.port}/status`, reuseExistingServer: false, timeout: 10000,
      env: { INFERENCE_LENS_N8N_TOOL_CAPTURE_PORT: String(scenario.port),
        INFERENCE_LENS_N8N_TOOL_CAPTURE_SCENARIO: scenario.id,
        INFERENCE_LENS_N8N_TOOL_CAPTURE_OUTPUT: path.join(output, scenario.id) },
    })),
  ],
});
