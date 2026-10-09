import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { discoverMcpServer } from "../../../services/api/src/mcp-discovery.ts";
import { parseMcpServerCatalog } from "../../../services/api/src/mcp-server-catalog.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** The committed MCP fixture, on its own port, with a catalog that declares it. */
export async function mcpFixture() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "scripts/mcp-discovery-fixture.mjs")], {
    env: { ...process.env, INFERENCE_LENS_MCP_FIXTURE_PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("MCP discovery fixture at")) resolve(); });
  });
  const catalog = { schemaVersion: 1, servers: [{ id: "fixture", label: "Fixture", endpoint: `http://127.0.0.1:${port}/mcp`, transport: "streamable-http", authorization: { kind: "none" } }] };
  const catalogPath = path.join(await mkdtemp(path.join(tmpdir(), "inference-lens-mcp-catalog-")), "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  const [declaration] = parseMcpServerCatalog(catalog);
  const discovered = (await discoverMcpServer(declaration)).tools.find(({ remoteName }) => remoteName === "lookup_record");
  return {
    catalogPath,
    fingerprint: discovered!.fingerprint!,
    inputSchema: discovered!.inputSchema!,
    status: async () => (await fetch(`http://127.0.0.1:${port}/status`)).json() as Promise<{ calls: number }>,
    close: async () => {
      // SIGKILL: the fixture's SIGTERM handler waits for idle connections,
      // and the pooled MCP client keeps one open until its idle timeout.
      child.kill("SIGKILL");
      await once(child, "exit");
    },
  };
}
