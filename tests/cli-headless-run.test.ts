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
import { formatHeadlessSummary, HEADLESS_SUMMARY_SCHEMA_VERSION } from "../packages/cli/src/summary.ts";
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
async function recordingProvider(options: {
  holdFirstRequest?: Promise<void>;
  /**
   * Holds every request until this many are in flight at once, so a run that
   * never overlaps them is seen at a peak of 1 rather than passing by luck.
   * Gives up after a second so a sequential run still finishes.
   */
  holdUntilInFlight?: number;
  /** Answers the first request with a 429 carrying this `Retry-After`. */
  rateLimitFirstRequest?: string;
} = {}) {
  const requests: Array<{ authorization?: string; body: { model?: string; stream?: boolean } }> = [];
  let inFlight = 0;
  let peakInFlight = 0;
  let releaseOverlap: () => void = () => {};
  const overlapped = new Promise<void>((resolve) => { releaseOverlap = resolve; });
  const overlapTimeout = setTimeout(releaseOverlap, 1_000);
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
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (options.holdUntilInFlight !== undefined) {
      if (inFlight >= options.holdUntilInFlight) releaseOverlap();
      await overlapped;
    }
    if (first) {
      first = false;
      notifyFirst();
      await options.holdFirstRequest;
      if (options.rateLimitFirstRequest !== undefined) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": options.rateLimitFirstRequest });
        response.end(JSON.stringify({ error: { message: "Too many requests" } }));
        inFlight -= 1;
        return;
      }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-headless",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 },
    }));
    inFlight -= 1;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    requests,
    firstArrived,
    get peakInFlight() { return peakInFlight; },
    close: () => new Promise<void>((resolve) => {
      clearTimeout(overlapTimeout);
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

const threeCases: NonNullable<Parameters<typeof headlessProject>[0]["cases"]> = [
  ...twoCases,
  {
    id: "evaluation-case_product",
    name: "States the product",
    topic: "multiplication",
    checks: [{ checkId: "check_product", kind: "contains", value: "2 + 2 = 4" }],
  },
];

test("--concurrency runs cells at once, records the limit, and reports it", async (t) => {
  const provider = await recordingProvider({ holdUntilInFlight: 2 });
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint, cases: threeCases }));

  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }, { concurrency: { limit: 2 } }).done;

  assert.equal(outcome.exitCode, 1, outcome.error);
  assert.equal(provider.peakInFlight, 2, "two requests were in flight at once, never three");
  const recorded = {
    maxInFlight: 2,
    connections: [{ profileId: `profile_${HEADLESS_CONNECTION_ID}`, endpoint: provider.endpoint, limit: 2 }],
  };
  const { experiments } = await readArtifacts(directory);
  const plan = parseExperimentPlanJson(experiments.find(({ fileName }) => fileName.endsWith(".plan.json"))!.contents);
  const result = parseExperimentResultJson(experiments.find(({ fileName }) => fileName.endsWith(".result.json"))!.contents, plan);
  assert.deepEqual(result.concurrency, recorded);
  assert.deepEqual(outcome.summary?.concurrency, recorded);
  // Cells finish in any order but are reported in plan order.
  assert.deepEqual(
    outcome.summary?.configurations[0].cases.map(({ caseId }) => caseId),
    threeCases.map(({ id }) => id),
  );
  assert.match(formatHeadlessSummary(outcome.summary!), /^Ran up to 2 repetitions at once\.$/m);
});

test("--connection-concurrency caps one connection below the overall limit", async (t) => {
  const provider = await recordingProvider({ holdUntilInFlight: 2 });
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint, cases: twoCases }));

  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }, {
    concurrency: { limit: 3, connections: new Map([[HEADLESS_CONNECTION_ID, 1]]) },
  }).done;

  assert.equal(outcome.exitCode, 1, outcome.error);
  assert.equal(provider.peakInFlight, 1);
  assert.deepEqual(outcome.summary?.concurrency, {
    maxInFlight: 3,
    connections: [{ profileId: `profile_${HEADLESS_CONNECTION_ID}`, endpoint: provider.endpoint, limit: 1 }],
  });
});

test("the default runs one repetition at a time and says nothing about concurrency", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint, cases: twoCases }));

  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }).done;

  assert.equal(provider.peakInFlight, 1);
  assert.equal(outcome.summary?.concurrency?.maxInFlight, 1);
  assert.doesNotMatch(formatHeadlessSummary(outcome.summary!), /at once/);
});

test("a rate-limit pause is announced on the progress stream when it starts", async (t) => {
  const provider = await recordingProvider({ rateLimitFirstRequest: "1" });
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint, cases: twoCases }));

  const progress: string[] = [];
  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }, { onProgress: (line) => progress.push(line) }).done;

  assert.equal(outcome.error, undefined);
  assert.equal(provider.requests.length, 2);
  // Named by the requirement ID --connection-concurrency takes, and printed
  // before the cell that hit the limit is reported, so a quiet second reads
  // as waiting rather than hung.
  assert.deepEqual(progress, [
    `Rate limited on ${HEADLESS_CONNECTION_ID} (${provider.endpoint}); new repetitions there wait 1 s.`,
    "[1/2] Default · States the sum #1: failed",
    "[2/2] Default · Mentions rollback #1: completed",
  ]);
});

test("a suite held back only by rate limiting exits 3, not 1", async (t) => {
  const provider = await recordingProvider({ rateLimitFirstRequest: "0" });
  t.after(provider.close);
  const cases: typeof twoCases = [twoCases[0]!, {
    ...twoCases[0]!, id: "evaluation-case_sum-again", name: "States the sum again",
    checks: [{ checkId: "check_sum-again", kind: "contains", value: "2 + 2 = 4" }],
  }];
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint, cases }));

  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }).done;

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.exitCode, 3);
  const summary = outcome.summary!;
  assert.equal(summary.verdict, "incomplete");
  assert.equal(summary.lifecycle, "completed");
  const [configuration] = summary.configurations;
  assert.deepEqual(configuration.caseCounts, { total: 2, passed: 1, failed: 0, incomplete: 1 });
  assert.equal(configuration.cases[0].repetitions[0].classification, "rate-limited");
});

test("bad concurrency flags exit 2 before any request or artifact", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));
  const attempt = async (...flags: string[]) => {
    const stderr: string[] = [];
    const code = await runCli(["run", directory, ...flags], {
      stdout: () => {}, stderr: (text) => stderr.push(text), environment: { [KEY_VARIABLE]: KEY },
    });
    return { code, stderr: stderr.join("") };
  };

  for (const value of ["0", "-1", "1.5", "two", ""]) {
    const { code, stderr } = await attempt(`--concurrency=${value}`);
    assert.equal(code, 2, value);
    assert.match(stderr, /--concurrency must be a positive whole number/, value);
  }
  for (const value of ["connection_headless-default", "=2", "connection_headless-default=0"]) {
    const { code, stderr } = await attempt("--concurrency", "2", "--connection-concurrency", value);
    assert.equal(code, 2, value);
    assert.match(stderr, /--connection-concurrency takes <connection-id>=<positive whole number>/, value);
  }
  {
    const { code, stderr } = await attempt("--concurrency", "2", "--connection-concurrency", "connection_nope=1");
    assert.equal(code, 2);
    assert.match(stderr, /--connection-concurrency names connection_nope, which this project does not declare/);
  }
  {
    const { code, stderr } = await attempt("--connection-concurrency", `${HEADLESS_CONNECTION_ID}=4`);
    assert.equal(code, 2);
    assert.match(stderr, /--connection-concurrency allows connection_headless-default 4 at once, more than the overall --concurrency of 1/);
  }
  {
    const { code, stderr } = await attempt(
      "--concurrency", "4",
      "--connection-concurrency", `${HEADLESS_CONNECTION_ID}=2`,
      "--connection-concurrency", `${HEADLESS_CONNECTION_ID}=3`,
    );
    assert.equal(code, 2);
    assert.match(stderr, /--connection-concurrency names connection_headless-default more than once/);
  }
  assert.equal(provider.requests.length, 0);
  await assert.rejects(stat(path.join(directory, "experiments")), { code: "ENOENT" });
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
