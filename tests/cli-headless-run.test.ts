import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { startHeadlessEvaluation } from "../packages/cli/src/evaluation-run.ts";
import { runCli } from "../packages/cli/src/main.ts";
import { HEADLESS_SUMMARY_SCHEMA_VERSION } from "../packages/cli/src/summary.ts";
import { createInProcessTransport } from "../packages/cli/src/transport.ts";
import { loadProjectHistoryFiles } from "../packages/core/src/experiment-history.ts";
import {
  evaluationExperimentAggregate,
  parseExperimentPlanJson,
  parseExperimentResultJson,
} from "../packages/core/src/experiment.ts";
import { parseProjectFile } from "../packages/core/src/project.ts";
import { parseRunTraceJson, runStateFromTrace } from "../packages/core/src/run-trace.ts";
import { HEADLESS_CONNECTION_ID, headlessProject, writeHeadlessProjectFolder } from "./fixtures/headless/project.ts";

const ANSWER = "Buffered fixture response: 2 + 2 = 4.";
const KEY = "sk-headless-secret-value";
const KEY_VARIABLE = "INFERENCE_LENS_CONNECTION_HEADLESS_DEFAULT_API_KEY";

/**
 * A chat-completions provider that records what reached it. The recorded
 * Authorization header is the proof the key got to the wire; scanning the
 * written files for the same key is the proof it went nowhere else.
 */
async function recordingProvider(options: { holdFirstRequest?: Promise<void> } = {}) {
  const requests: Array<{ authorization?: string; body: { model?: string; stream?: boolean } }> = [];
  let first = true;
  let notifyFirst: () => void = () => {};
  const firstArrived = new Promise<void>((resolve) => { notifyFirst = resolve; });
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push({
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    if (first) {
      first = false;
      notifyFirst();
      await options.holdFirstRequest;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-headless",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    requests,
    firstArrived,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

const twoCases: NonNullable<Parameters<typeof headlessProject>[0]["cases"]> = [
  {
    id: "evaluation-case_sum",
    name: "States the sum",
    topic: "addition",
    checks: [{ checkId: "check_sum", kind: "contains", value: "2 + 2 = 4" }],
  },
  {
    id: "evaluation-case_rollback",
    name: "Mentions rollback",
    topic: "migrations",
    checks: [{ checkId: "check_rollback", kind: "contains", value: "rollback" }],
  },
];

async function readArtifacts(directory: string) {
  const list = async (name: string) => {
    try {
      return await Promise.all((await readdir(path.join(directory, name))).map(async (fileName) => ({
        fileName,
        contents: await readFile(path.join(directory, name, fileName), "utf8"),
      })));
    } catch {
      return [];
    }
  };
  return { experiments: await list("experiments"), traces: await list("traces") };
}

function run(directory: string, environment: Record<string, string>, extra: Partial<Parameters<typeof startHeadlessEvaluation>[0]> = {}) {
  return startHeadlessEvaluation({
    projectDirectory: directory,
    environment,
    transport: createInProcessTransport({ containerized: false }),
    ...extra,
  });
}

test("a passing suite exits 0 and writes artifacts the app's history reads as an evaluation", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const project = headlessProject({ endpoint: provider.endpoint, repetitions: 2 });
  const directory = await writeHeadlessProjectFolder(project);
  const projectBefore = await readFile(path.join(directory, "project.json"), "utf8");

  const progress: string[] = [];
  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }, { onProgress: (line) => progress.push(line) }).done;

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.summary?.verdict, "passed");
  assert.deepEqual(progress, [
    "[1/2] Default · States the sum #1: completed",
    "[2/2] Default · States the sum #2: completed",
  ]);

  // The key reached the provider, and only the provider.
  assert.equal(provider.requests.length, 2);
  assert.ok(provider.requests.every(({ authorization, body }) =>
    authorization === `Bearer ${KEY}` && body.model === "buffered-test-model" && body.stream === false));
  const { experiments, traces } = await readArtifacts(directory);
  for (const file of [...experiments, ...traces]) {
    assert.ok(!file.contents.includes(KEY), `${file.fileName} must not contain the key`);
  }
  assert.equal(await readFile(path.join(directory, "project.json"), "utf8"), projectBefore, "project.json is never written");

  // Every artifact crosses the core parsers, and the app's history projection
  // groups them as one completed evaluation with no damaged files.
  const planFile = experiments.find(({ fileName }) => fileName.endsWith(".plan.json"))!;
  const resultFile = experiments.find(({ fileName }) => fileName.endsWith(".result.json"))!;
  const plan = parseExperimentPlanJson(planFile.contents);
  assert.equal(plan.kind, "evaluation");
  const result = parseExperimentResultJson(resultFile.contents, plan);
  assert.equal(result.status, "completed");
  assert.equal(traces.length, 2);
  const states = new Map(traces.map(({ contents }) => {
    const trace = parseRunTraceJson(contents);
    return [trace.runId, runStateFromTrace(trace)] as const;
  }));
  if (plan.kind !== "evaluation") throw new Error("unreachable");
  // Re-derived from disk alone, the reading matches what the CLI reported.
  const reread = evaluationExperimentAggregate(plan, result, states);
  assert.equal(reread.variants[0].passed, true);
  assert.equal(plan.suite.variants[0].target.endpoint, provider.endpoint);

  const history = loadProjectHistoryFiles(traces, experiments);
  assert.deepEqual(history.failures, []);
  assert.equal(history.experiments.length, 1);
  assert.equal(history.experiments[0].kind, "evaluation");
  assert.equal(history.experiments[0].lifecycle, "completed");
  assert.equal(history.experiments[0].completed, 2);

  assert.deepEqual(outcome.summary?.artifacts, {
    plan: path.join("experiments", planFile.fileName),
    result: path.join("experiments", resultFile.fileName),
  });
});

test("a failing case exits 1 and the summary names outcomes without quoting output", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint, cases: twoCases }));

  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }).done;

  assert.equal(outcome.exitCode, 1);
  const summary = outcome.summary!;
  assert.equal(summary.schemaVersion, HEADLESS_SUMMARY_SCHEMA_VERSION);
  assert.equal(summary.verdict, "failed");
  assert.equal(summary.lifecycle, "completed");
  const [configuration] = summary.configurations;
  assert.deepEqual(configuration.caseCounts, { total: 2, passed: 1, failed: 1, incomplete: 0 });
  const rollback = configuration.cases.find(({ caseId }) => caseId === "evaluation-case_rollback")!;
  assert.equal(rollback.passed, false);
  assert.deepEqual(rollback.checks, { total: 1, passed: 0, failed: 1, notEvaluated: 0 });
  assert.equal(rollback.repetitions[0].classification, "check-failed");
  assert.match(rollback.repetitions[0].trace ?? "", /^traces[/\\]run_.+\.json$/);
  assert.ok(!JSON.stringify(summary).includes("Buffered fixture response"), "the summary never copies model output");
});

test("a connection with no credential exits 2 before any request or artifact", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));

  const outcome = await run(directory, {
    INFERENCE_LENS_API_KEY: KEY,
    INFERENCE_LENS_API_ENDPOINT: "https://some-other-provider.example.test",
  }).done;

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.error ?? "", new RegExp(`No credential for connection "Default connection" \\(${HEADLESS_CONNECTION_ID}\\)`));
  assert.equal(provider.requests.length, 0);
  await assert.rejects(stat(path.join(directory, "experiments")), { code: "ENOENT" });
});

test("--no-auth calls the endpoint with no Authorization header", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));

  const outcome = await run(directory, {}, { noAuth: new Set([HEADLESS_CONNECTION_ID]) }).done;

  assert.equal(outcome.exitCode, 0);
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0].authorization, undefined);
});

test("a suite exposing a tool with no enabled mock exits 2, naming the tool", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const base = headlessProject({ endpoint: provider.endpoint });
  const project = parseProjectFile({
    ...base,
    connectionRequirements: base.connectionRequirements.map((requirement) => ({
      ...requirement,
      capabilityOverrides: { ...requirement.capabilityOverrides, tools: true },
    })),
    tools: [{ id: "tool_lookup", name: "lookup_order", inputSchema: { type: "object", properties: {} } }],
    evaluationSuites: base.evaluationSuites.map((suite) => ({
      ...suite,
      execution: { ...suite.execution, toolIds: ["tool_lookup"] },
    })),
  });
  const directory = await writeHeadlessProjectFolder(project);

  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }).done;

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.error ?? "", /exposes lookup_order, and headless runs can serve only enabled project mocks/);
  assert.equal(provider.requests.length, 0);
});

test("a capability the project does not declare is refused in the CLI's own words", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const base = headlessProject({ endpoint: provider.endpoint });
  const project = parseProjectFile({
    ...base,
    connectionRequirements: base.connectionRequirements.map((requirement) => ({
      ...requirement,
      capabilityOverrides: { ...requirement.capabilityOverrides, streaming: false },
    })),
    evaluationSuites: base.evaluationSuites.map((suite) => ({
      ...suite,
      execution: { ...suite.execution, responseMode: "streaming" },
    })),
  });
  const directory = await writeHeadlessProjectFolder(project);

  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }).done;

  assert.equal(outcome.exitCode, 2);
  // The app's remedy is a button in its preflight; here it is the project file.
  assert.equal(
    outcome.error,
    `Configuration "Default" uses streaming, but connection "Default connection" (${HEADLESS_CONNECTION_ID}) ` +
      "does not enable it. Enable it in that connection's capabilityOverrides, or set the suite to buffered delivery.",
  );
  assert.equal(provider.requests.length, 0);
});

test("an interrupted run exits 3 and still leaves a readable, cancelled experiment", async (t) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const provider = await recordingProvider({ holdFirstRequest: held });
  t.after(async () => {
    release();
    await provider.close();
  });
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint, cases: twoCases }));

  const active = run(directory, { [KEY_VARIABLE]: KEY });
  await provider.firstArrived;
  active.cancel();
  const outcome = await active.done;

  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.summary?.verdict, "incomplete");
  assert.equal(outcome.summary?.lifecycle, "cancelled");
  assert.equal(provider.requests.length, 1, "no later case starts after the interrupt");
  const { experiments } = await readArtifacts(directory);
  const history = loadProjectHistoryFiles((await readArtifacts(directory)).traces, experiments);
  assert.deepEqual(history.failures, []);
  assert.equal(history.experiments[0].lifecycle, "cancelled");
});

test("the command line rejects bad usage with exit 2 and prints --json on stdout only", async (t) => {
  const usage: string[] = [];
  assert.equal(await runCli(["evaluate", "x"], { stdout: () => {}, stderr: (text) => usage.push(text), environment: {} }), 2);
  assert.match(usage.join(""), /Unknown command "evaluate"/);
  assert.equal(await runCli(["run"], { stdout: () => {}, stderr: () => {}, environment: {} }), 2);

  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["run", directory, "--suite", "Arithmetic", "--json"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    environment: { [KEY_VARIABLE]: KEY },
  });
  assert.equal(code, 0);
  const summary = JSON.parse(stdout.join(""));
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.suite.suiteId, "evaluation-suite_arithmetic");
  assert.match(stderr.join(""), /\[1\/1\] Default · States the sum #1: completed/);

  const missing: string[] = [];
  assert.equal(await runCli(["run", directory, "--suite", "Nope"], {
    stdout: () => {}, stderr: (text) => missing.push(text), environment: { [KEY_VARIABLE]: KEY },
  }), 2);
  assert.match(missing.join(""), /No evaluation suite has the ID or name "Nope"\. Available: evaluation-suite_arithmetic \("Arithmetic"\)/);
});

test("the CLI process runs a suite against the committed buffered fixture provider", async (t) => {
  const root = path.resolve(import.meta.dirname, "..");
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
    cases: twoCases,
  }));
  const cli = spawn(process.execPath, [
    "--experimental-strip-types", "--no-warnings",
    path.join(root, "packages/cli/src/main.ts"),
    "run", directory, "--json", "--no-auth", HEADLESS_CONNECTION_ID,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  cli.stdout.on("data", (chunk) => { stdout += chunk; });
  cli.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(cli, "exit");

  assert.equal(code, 1, stderr);
  const summary = JSON.parse(stdout);
  assert.equal(summary.verdict, "failed");
  assert.deepEqual(
    summary.configurations[0].cases.map(({ name, passed }: { name: string; passed: boolean }) => [name, passed]),
    [["States the sum", true], ["Mentions rollback", false]],
  );
  const { experiments, traces } = await readArtifacts(directory);
  assert.equal(experiments.length, 2);
  assert.equal(traces.length, 2);
});
