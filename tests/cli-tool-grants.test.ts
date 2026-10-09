import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startHeadlessEvaluation } from "../packages/cli/src/evaluation-run.ts";
import { runCli } from "../packages/cli/src/main.ts";
import { parseToolGrants } from "../packages/cli/src/tool-grants.ts";
import { createInProcessTransport } from "../packages/cli/src/transport.ts";
import { parseProjectFile } from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import type { ToolDefinition } from "../packages/core/src/run-kernel/types.ts";
import { parseRunTraceJson } from "../packages/core/src/run-trace.ts";
import { discoverMcpServer } from "../services/api/src/mcp-discovery.ts";
import { parseMcpServerCatalog } from "../services/api/src/mcp-server-catalog.ts";
import { headlessToolProject, writeHeadlessProjectFolder } from "./fixtures/headless/project.ts";
import { toolCallingProvider } from "./fixtures/headless/tool-calling-provider.ts";

const KEY_VARIABLE = "INFERENCE_LENS_CONNECTION_HEADLESS_DEFAULT_API_KEY";
const COMMAND_CATALOG = path.resolve("tests/fixtures/command-tools/catalog.json");
const WEATHER = "61F and drizzle in Lisbon";

const weatherTool: ToolDefinition = {
  id: "tool_weather" as ToolDefinition["id"],
  name: "get_weather",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
};

function run(directory: string, environment: Record<string, string>, extra: Partial<Parameters<typeof startHeadlessEvaluation>[0]> = {}) {
  return startHeadlessEvaluation({
    projectDirectory: directory,
    // PATH lets a catalog script's `#!/usr/bin/env node` resolve, as it does
    // when the CLI passes its own process environment.
    environment: { PATH: process.env.PATH ?? "", [KEY_VARIABLE]: "sk-grant-test", ...environment },
    transport: createInProcessTransport({ containerized: false }),
    ...extra,
  });
}

async function onlyTrace(directory: string) {
  const [fileName] = await readdir(path.join(directory, "traces"));
  return parseRunTraceJson(await readFile(path.join(directory, "traces", fileName), "utf8"));
}

async function writtenFiles(directory: string) {
  const list = async (name: string) => readdir(path.join(directory, name)).catch(() => []);
  return [...await list("experiments"), ...await list("traces")];
}

test("parseToolGrants reads <tool>=command:<id> and <tool>=mcp:<server>, refusing anything else", () => {
  assert.deepEqual(parseToolGrants(["get_weather=command:weather", "lookup=mcp:fixture"]), [
    { toolName: "get_weather", target: { kind: "command", commandId: "weather" } },
    { toolName: "lookup", target: { kind: "mcp", serverId: "fixture" } },
  ]);
  for (const bad of ["get_weather", "get_weather=", "=command:weather", "get_weather=weather", "get_weather=shell:weather", "get_weather=command:"]) {
    assert.throws(() => parseToolGrants([bad]), /--allow-tool takes <tool-name>=command:<command-id> or <tool-name>=mcp:<server-id>/, bad);
  }
  assert.throws(
    () => parseToolGrants(["get_weather=command:weather", "get_weather=command:slow-weather"]),
    /--allow-tool names get_weather more than once/,
  );
});

test("a command grant runs the operator's declared command and its result reaches the provider", async (t) => {
  const provider = await toolCallingProvider({ name: "get_weather", arguments: { city: "Lisbon" } });
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessToolProject(provider.endpoint, weatherTool, WEATHER));

  const outcome = await run(directory, { INFERENCE_LENS_COMMAND_TOOLS: COMMAND_CATALOG }, {
    toolGrants: [{ toolName: "get_weather", target: { kind: "command", commandId: "weather" } }],
  }).done;

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.exitCode, 0);
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1].messages), /61F and drizzle in Lisbon, measured by get_weather/);
  const trace = await onlyTrace(directory);
  assert.deepEqual(trace.toolResults[0]?.resolution, { kind: "live", executorId: "weather" });
});

test("a grant outranks an enabled project mock for the same tool", async (t) => {
  const provider = await toolCallingProvider({ name: "get_weather", arguments: { city: "Lisbon" } });
  t.after(provider.close);
  const project = headlessToolProject(provider.endpoint, weatherTool, WEATHER, {
    toolMocks: [{
      id: "tool-mock_weather",
      toolId: weatherTool.id,
      name: "Canned weather",
      enabled: true,
      match: { kind: "always" },
      result: { content: [{ type: "text", text: "Mocked sunshine" }] },
    }],
  } as Partial<ProjectFile>);
  const directory = await writeHeadlessProjectFolder(project);

  const outcome = await run(directory, { INFERENCE_LENS_COMMAND_TOOLS: COMMAND_CATALOG }, {
    toolGrants: [{ toolName: "get_weather", target: { kind: "command", commandId: "weather" } }],
  }).done;

  assert.equal(outcome.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(provider.requests[1].messages), /Mocked sunshine/);
});

test("a grant the operator's catalogs cannot serve exits 2 before any request or artifact", async (t) => {
  const provider = await toolCallingProvider({ name: "get_weather", arguments: { city: "Lisbon" } });
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessToolProject(provider.endpoint, weatherTool, WEATHER));

  const undeclared = await run(directory, { INFERENCE_LENS_COMMAND_TOOLS: COMMAND_CATALOG }, {
    toolGrants: [{ toolName: "get_weather", target: { kind: "command", commandId: "no-such-command" } }],
  }).done;
  assert.equal(undeclared.exitCode, 2);
  assert.match(undeclared.error ?? "", /get_weather cannot run: .*no-such-command/);

  const noCatalog = await run(directory, {}, {
    toolGrants: [{ toolName: "get_weather", target: { kind: "command", commandId: "weather" } }],
  }).done;
  assert.equal(noCatalog.exitCode, 2);
  assert.match(noCatalog.error ?? "", /INFERENCE_LENS_COMMAND_TOOLS/);

  assert.equal(provider.requests.length, 0);
  assert.deepEqual(await writtenFiles(directory), []);
});

test("grants naming a tool the project lacks, or MCP for a tool not attached from MCP, exit 2", async (t) => {
  const provider = await toolCallingProvider({ name: "get_weather", arguments: { city: "Lisbon" } });
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessToolProject(provider.endpoint, weatherTool, WEATHER));

  const unknown = await run(directory, { INFERENCE_LENS_COMMAND_TOOLS: COMMAND_CATALOG }, {
    toolGrants: [{ toolName: "get_forecast", target: { kind: "command", commandId: "weather" } }],
  }).done;
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.error ?? "", /--allow-tool names get_forecast, which this project does not define/);

  const wrongKind = await run(directory, {}, {
    toolGrants: [{ toolName: "get_weather", target: { kind: "mcp", serverId: "fixture" } }],
  }).done;
  assert.equal(wrongKind.exitCode, 2);
  assert.match(wrongKind.error ?? "", /get_weather was not attached from an MCP server/);

  assert.equal(provider.requests.length, 0);
});

test("a grant for a tool the selected suite does not expose is ignored", async (t) => {
  const provider = await toolCallingProvider({ name: "get_weather", arguments: { city: "Lisbon" } });
  t.after(provider.close);
  const project = headlessToolProject(provider.endpoint, weatherTool, WEATHER);
  const unexposed = parseProjectFile({
    ...project,
    tools: [...project.tools, { id: "tool_other", name: "other_tool", inputSchema: { type: "object", properties: {} } }],
  });
  const directory = await writeHeadlessProjectFolder(unexposed);

  const outcome = await run(directory, { INFERENCE_LENS_COMMAND_TOOLS: COMMAND_CATALOG }, {
    toolGrants: [
      { toolName: "get_weather", target: { kind: "command", commandId: "weather" } },
      { toolName: "other_tool", target: { kind: "command", commandId: "no-such-command" } },
    ],
  }).done;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.exitCode, 0);
});

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** The committed MCP fixture, on its own port, with a catalog that declares it. */
async function mcpFixture() {
  const port = await freePort();
  const child = spawn(process.execPath, ["scripts/mcp-discovery-fixture.mjs"], {
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

test("an MCP grant calls the declared server after checking the attached fingerprint", async (t) => {
  const fixture = await mcpFixture();
  t.after(fixture.close);
  const provider = await toolCallingProvider({ name: "lookup_record", arguments: { record_id: "A-1" } });
  t.after(provider.close);
  const lookup = (fingerprint: string): ToolDefinition => ({
    id: "tool_lookup" as ToolDefinition["id"],
    name: "lookup_record",
    inputSchema: fixture.inputSchema,
    source: { kind: "mcp", remoteToolName: "lookup_record", discoveryFingerprint: fingerprint },
  });
  const grant = { toolName: "lookup_record", target: { kind: "mcp" as const, serverId: "fixture" } };

  const matching = await writeHeadlessProjectFolder(headlessToolProject(provider.endpoint, lookup(fixture.fingerprint), "Record A-1: local MCP result"));
  const outcome = await run(matching, { INFERENCE_LENS_MCP_SERVERS: fixture.catalogPath }, { toolGrants: [grant] }).done;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.exitCode, 0);
  assert.equal((await fixture.status()).calls, 1);

  // The same grant from a CLI process, which must exit on its own: the pooled
  // MCP client keeps its connection for minutes, and a CI job would wait on it.
  const cli = spawn(process.execPath, [
    "--experimental-strip-types", "packages/cli/src/main.ts", "run", matching, "--allow-tool", "lookup_record=mcp:fixture",
  ], {
    env: { ...process.env, [KEY_VARIABLE]: "sk-grant-test", INFERENCE_LENS_MCP_SERVERS: fixture.catalogPath },
    stdio: "ignore",
  });
  const exitTimer = setTimeout(() => cli.kill("SIGKILL"), 20_000);
  const [code] = await once(cli, "exit");
  clearTimeout(exitTimer);
  assert.equal(code, 0);
  assert.equal((await fixture.status()).calls, 2);

  const changed = await writeHeadlessProjectFolder(headlessToolProject(provider.endpoint, lookup("0".repeat(64)), "Record A-1: local MCP result"));
  const refused = await run(changed, { INFERENCE_LENS_MCP_SERVERS: fixture.catalogPath }, { toolGrants: [grant] }).done;
  assert.equal(refused.exitCode, 2);
  assert.match(refused.error ?? "", /lookup_record cannot run: The MCP tool changed since it was attached/);
  assert.equal((await fixture.status()).calls, 2);
  assert.deepEqual(await writtenFiles(changed), []);
});

test("--allow-tool is parsed on the command line, and a bad one exits 2 with nothing sent", async (t) => {
  const provider = await toolCallingProvider({ name: "get_weather", arguments: { city: "Lisbon" } });
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessToolProject(provider.endpoint, weatherTool, WEATHER));
  const io = (environment: Record<string, string>) => {
    const out = { stdout: "", stderr: "" };
    return {
      out,
      io: {
        stdout: (text: string) => { out.stdout += text; },
        stderr: (text: string) => { out.stderr += text; },
        environment: { PATH: process.env.PATH ?? "", [KEY_VARIABLE]: "sk-grant-test", ...environment },
      },
    };
  };

  const bad = io({});
  assert.equal(await runCli(["run", directory, "--allow-tool", "get_weather"], bad.io), 2);
  assert.match(bad.out.stderr, /--allow-tool takes <tool-name>=command:<command-id>/);
  assert.equal(provider.requests.length, 0);

  const good = io({ INFERENCE_LENS_COMMAND_TOOLS: COMMAND_CATALOG });
  assert.equal(await runCli(["run", directory, "--allow-tool", "get_weather=command:weather"], good.io), 0);
  assert.equal(provider.requests.length, 2);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a first interrupt during a granted command stops gracefully and ends the command's process tree", async (t) => {
  const provider = await toolCallingProvider({ name: "get_weather", arguments: { city: "Lisbon" } });
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessToolProject(provider.endpoint, weatherTool, WEATHER));
  // hang.mjs never finishes and starts a child of its own, writing that
  // child's pid here: its arrival proves the command is running, and its
  // death afterwards proves the tree was ended rather than orphaned.
  const scratch = await mkdtemp(path.join(tmpdir(), "inference-lens-hang-"));
  const pidPath = path.join(scratch, "child.pid");
  const catalogPath = path.join(scratch, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({
    schemaVersion: 1,
    commands: [{ id: "hang", label: "Hangs", executable: path.resolve("tests/fixtures/command-tools/hang.mjs"), args: [pidPath], timeoutMs: 60_000 }],
  }));

  const child = spawn(process.execPath, [
    "--experimental-strip-types", "packages/cli/src/main.ts", "run", directory, "--allow-tool", "get_weather=command:hang",
  ], {
    env: { ...process.env, [KEY_VARIABLE]: "sk-grant-test", INFERENCE_LENS_COMMAND_TOOLS: catalogPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = once(child, "exit");
  let grandchild = 0;
  for (let waited = 0; !grandchild && waited < 20_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    grandchild = Number.parseInt(await readFile(pidPath, "utf8").catch(() => ""), 10) || 0;
  }
  assert.ok(grandchild, "the granted command never started");

  child.kill("SIGINT");
  const [code] = await exited;

  assert.equal(code, 3, stderr);
  assert.match(stderr, /Stopping after the current request/);
  const experiments = await readdir(path.join(directory, "experiments"));
  assert.equal(experiments.filter((name) => name.endsWith(".result.json")).length, 1);
  for (let waited = 0; isAlive(grandchild) && waited < 5_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(isAlive(grandchild), false, "the command's own child outlived the CLI");
});
