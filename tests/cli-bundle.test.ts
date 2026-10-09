import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, readdir, readFile, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before } from "node:test";

import type { ToolDefinition } from "../packages/core/src/run-kernel/types.ts";
import { mcpFixture } from "./fixtures/headless/mcp-fixture.ts";
import {
  HEADLESS_CONNECTION_ID,
  headlessProject,
  headlessToolProject,
  writeHeadlessProjectFolder,
} from "./fixtures/headless/project.ts";
import { toolCallingProvider } from "./fixtures/headless/tool-calling-provider.ts";

// The image runs the CLI from `npm run build:cli`'s single file, with no
// TypeScript sources and no node_modules beside it. These tests build that
// file, copy it somewhere nothing else is, and run it the way the image's
// `inference-lens` link does, so a dependency the bundle failed to inline
// fails here rather than in a container.

const root = path.resolve(import.meta.dirname, "..");
let cliLink = "";

function runBundle(args: string[], environment: Record<string, string> = {}) {
  const child = spawn(cliLink, args, {
    // A cwd holding only the bundle, so nothing resolves against the repository.
    cwd: path.dirname(cliLink),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // The pooled MCP client keeps a connection open; the process must still exit.
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  return once(child, "exit").then(([code]) => {
    clearTimeout(timer);
    return { code: code as number | null, stdout, stderr };
  });
}

before(async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "inference-lens-cli-build-"));
  const build = spawn(process.execPath, [
    path.join(root, "node_modules/vite/bin/vite.js"), "build",
    "-c", path.join(root, "vite.cli.config.ts"), "--outDir", outDir, "--logLevel", "error",
  ], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  const [code] = await once(build, "exit");
  assert.equal(code, 0, "npm run build:cli's Vite build failed");
  assert.deepEqual(await readdir(outDir), ["inference-lens.mjs"]);

  const isolated = await mkdtemp(path.join(tmpdir(), "inference-lens-cli-bin-"));
  const bundle = path.join(isolated, "inference-lens.mjs");
  await copyFile(path.join(outDir, "inference-lens.mjs"), bundle);
  await chmod(bundle, 0o755);
  cliLink = path.join(isolated, "inference-lens");
  await symlink(bundle, cliLink);
});

test("the bundle imports nothing but Node built-ins", async () => {
  const source = await readFile(path.join(path.dirname(cliLink), "inference-lens.mjs"), "utf8");
  assert.ok(source.startsWith("#!/usr/bin/env node\n"));
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map(([, specifier]) => specifier);
  assert.ok(specifiers.length > 0);
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith("node:")), []);
});

test("the bundled CLI prints its usage through a link, as the image's PATH entry runs it", async () => {
  const { code, stdout } = await runBundle(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /^Usage: inference-lens run <project-folder> \[options\]/);
});

test("the bundled CLI runs a suite against the committed buffered fixture provider", async (t) => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address() as AddressInfo;
      probe.close(() => resolve(free));
    });
  });
  const fixture = spawn(process.execPath, [path.join(root, "scripts/buffered-openai-provider.mjs")], {
    env: { ...process.env, INFERENCE_LENS_BUFFERED_PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => fixture.kill("SIGTERM"));
  await once(fixture.stdout!, "data");

  const directory = await writeHeadlessProjectFolder(headlessProject({
    endpoint: `http://127.0.0.1:${port}/v1`,
    cases: [
      { id: "evaluation-case_sum", name: "States the sum", topic: "addition", checks: [{ checkId: "check_sum", kind: "contains", value: "2 + 2 = 4" }] },
      { id: "evaluation-case_rollback", name: "Mentions rollback", topic: "deploys", checks: [{ checkId: "check_rollback", kind: "contains", value: "rollback" }] },
    ],
  }));
  const { code, stdout, stderr } = await runBundle(["run", directory, "--json", "--no-auth", HEADLESS_CONNECTION_ID]);

  assert.equal(code, 1, stderr);
  const summary = JSON.parse(stdout);
  assert.equal(summary.verdict, "failed");
  assert.deepEqual(
    summary.configurations[0].cases.map(({ name, passed }: { name: string; passed: boolean }) => [name, passed]),
    [["States the sum", true], ["Mentions rollback", false]],
  );
  assert.equal((await readdir(path.join(directory, "experiments"))).length, 2);
  assert.equal((await readdir(path.join(directory, "traces"))).length, 2);
});

test("the bundled CLI serves an MCP grant through the bundled MCP client", async (t) => {
  const fixture = await mcpFixture();
  t.after(fixture.close);
  const provider = await toolCallingProvider({ name: "lookup_record", arguments: { record_id: "A-1" } });
  t.after(provider.close);
  const lookup: ToolDefinition = {
    id: "tool_lookup" as ToolDefinition["id"],
    name: "lookup_record",
    inputSchema: fixture.inputSchema,
    source: { kind: "mcp", remoteToolName: "lookup_record", discoveryFingerprint: fixture.fingerprint },
  };
  const directory = await writeHeadlessProjectFolder(headlessToolProject(provider.endpoint, lookup, "Record A-1: local MCP result"));

  const { code, stderr } = await runBundle(["run", directory, "--allow-tool", "lookup_record=mcp:fixture"], {
    INFERENCE_LENS_CONNECTION_HEADLESS_DEFAULT_API_KEY: "sk-bundle-test",
    INFERENCE_LENS_MCP_SERVERS: fixture.catalogPath,
  });

  assert.equal(code, 0, stderr);
  assert.equal((await fixture.status()).calls, 1);
  assert.match(JSON.stringify(provider.requests[1].messages), /Record A-1: local MCP result/);
});
