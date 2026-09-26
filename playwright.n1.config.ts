import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Opt-in Python integration: the ordinary suite needs only Node dependencies.
// Workers inherit the same fresh directory; the provider refuses overwrites.
const output = process.env.INFERENCE_LENS_N1_OUTPUT ?? mkdtempSync(path.join(tmpdir(), "inference-lens-n1-"));
process.env.INFERENCE_LENS_N1_OUTPUT = output;
const catalog = JSON.parse(readFileSync("tests/fixtures/mcp-servers/catalog.json", "utf8"));
catalog.servers.push({
  id: "n1-string-input", label: "N1 Python string input", transport: "streamable-http",
  endpoint: "http://127.0.0.1:44021/mcp", callTimeoutMs: 5000, authorization: { kind: "none" },
});
const catalogPath = path.join(output, "catalog.json");
writeFileSync(catalogPath, JSON.stringify(catalog));
const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  retries: 0, // One capture per lifecycle; retrying cannot reuse completed evidence.
  webServer: [
    ...servers.map((server, index) => index === 0
      ? { ...server, env: { ...server.env, INFERENCE_LENS_MCP_SERVERS: catalogPath } }
      : server),
    {
      command: ".venv-mcp/bin/python scripts/n1-string-input-mcp.py",
      url: "http://127.0.0.1:44021/health", reuseExistingServer: false, timeout: 15000,
      env: { INFERENCE_LENS_N1_OUTPUT: output },
    },
    {
      command: "node scripts/n8n-tool-capture-provider.mjs",
      url: "http://127.0.0.1:44022/status", reuseExistingServer: false, timeout: 10000,
      env: {
        INFERENCE_LENS_N8N_TOOL_CAPTURE_PORT: "44022",
        INFERENCE_LENS_N8N_TOOL_CAPTURE_SCENARIO: "string-input",
        INFERENCE_LENS_N8N_TOOL_CAPTURE_OUTPUT: output,
      },
    },
  ],
});
