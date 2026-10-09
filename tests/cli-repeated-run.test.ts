import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCli } from "../packages/cli/src/main.ts";
import { startHeadlessRepeat } from "../packages/cli/src/repeated-run.ts";
import {
  formatHeadlessRepeatedSummary,
  HEADLESS_REPEATED_SUMMARY_SCHEMA_VERSION,
} from "../packages/cli/src/summary.ts";
import { createInProcessTransport } from "../packages/cli/src/transport.ts";
import { loadProjectHistoryFiles } from "../packages/core/src/experiment-history.ts";
import {
  parseExperimentPlanJson,
  parseExperimentResultJson,
  repeatedExperimentAggregate,
} from "../packages/core/src/experiment.ts";
import { parseProjectFile } from "../packages/core/src/project.ts";
import type { ToolDefinition } from "../packages/core/src/run-kernel/types.ts";
import { parseRunTraceJson, runStateFromTrace } from "../packages/core/src/run-trace.ts";
import { HEADLESS_CONNECTION_ID, headlessProject, writeHeadlessProjectFolder } from "./fixtures/headless/project.ts";
import { ANSWER, recordingProvider } from "./fixtures/headless/recording-provider.ts";

const KEY = "sk-headless-repeat-value";
const KEY_VARIABLE = "INFERENCE_LENS_CONNECTION_HEADLESS_DEFAULT_API_KEY";

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

function repeat(directory: string, extra: Partial<Parameters<typeof startHeadlessRepeat>[0]> = {}) {
  return startHeadlessRepeat({
    projectDirectory: directory,
    environment: { [KEY_VARIABLE]: KEY },
    transport: createInProcessTransport({ containerized: false }),
    ...extra,
  });
}

/** The fixture project with its connection's declared capabilities changed. */
function withCapabilities(endpoint: string, capabilityOverrides: Record<string, boolean>) {
  const base = headlessProject({ endpoint });
  return parseProjectFile({
    ...base,
    connectionRequirements: base.connectionRequirements.map((requirement) => ({
      ...requirement,
      capabilityOverrides: { ...requirement.capabilityOverrides, ...capabilityOverrides },
    })),
  });
}

test("repeat sends the project's saved defaults, buffered, and writes a repeated run the app's history reads", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));
  const projectBefore = await readFile(path.join(directory, "project.json"), "utf8");

  const progress: string[] = [];
  const outcome = await repeat(directory, { repetitions: 3, onProgress: (line) => progress.push(line) }).done;

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(progress, [
    "[1/3] Repetition #1: completed",
    "[2/3] Repetition #2: completed",
    "[3/3] Repetition #3: completed",
  ]);

  // The saved defaults reached the wire: its model, its template use resolved
  // with the template's default value, and no stream.
  assert.equal(provider.requests.length, 3);
  for (const { authorization, body } of provider.requests) {
    assert.equal(authorization, `Bearer ${KEY}`);
    assert.equal(body.model, "buffered-test-model");
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages?.map(({ role }) => role), ["system", "user"]);
    assert.match(JSON.stringify(body.messages?.[1]), /Tell me about arithmetic\./);
  }
  assert.equal(await readFile(path.join(directory, "project.json"), "utf8"), projectBefore, "project.json is never written");

  const { experiments, traces } = await readArtifacts(directory);
  const plan = parseExperimentPlanJson(experiments.find(({ fileName }) => fileName.endsWith(".plan.json"))!.contents);
  if (plan.kind !== "repeated-request") throw new Error(`expected a repeated plan, not ${plan.kind}`);
  assert.equal(plan.cells.length, 3);
  assert.equal(plan.commonInput.responseMode, "buffered");
  assert.equal(plan.commonInput.target.endpoint, provider.endpoint);
  assert.equal(plan.commonInput.target.profileId, `profile_${HEADLESS_CONNECTION_ID}`);
  const result = parseExperimentResultJson(
    experiments.find(({ fileName }) => fileName.endsWith(".result.json"))!.contents,
    plan,
  );
  assert.equal(result.status, "completed");
  const states = new Map(traces.map(({ contents }) => {
    const trace = parseRunTraceJson(contents);
    return [trace.runId, runStateFromTrace(trace)] as const;
  }));
  assert.equal(repeatedExperimentAggregate(plan, result, states).completed, 3);
  const history = loadProjectHistoryFiles(traces, experiments);
  assert.deepEqual(history.failures, []);
  assert.equal(history.experiments.length, 1);
  assert.equal(history.experiments[0].kind, "repeated-request");
  assert.equal(history.experiments[0].completed, 3);

  const summary = outcome.summary!;
  assert.equal(summary.kind, "repeated-request");
  assert.equal(summary.schemaVersion, HEADLESS_REPEATED_SUMMARY_SCHEMA_VERSION);
  assert.equal(summary.outcome, "completed");
  assert.equal(summary.responseMode, "buffered");
  assert.deepEqual(summary.target, {
    connectionRequirementId: HEADLESS_CONNECTION_ID,
    protocol: "openai-compatible-chat-completions",
    model: "buffered-test-model",
  });
  assert.equal(summary.conversationRevisionId, plan.commonInput.conversationRevisionId);
  assert.deepEqual(summary.counts, {
    requested: 3, completed: 3, failed: 0, rateLimited: 0, cancelled: 0, notRun: 0, missingTrace: 0,
    retriedAfterRateLimit: 0,
  });
  assert.equal(summary.metrics.totalDurationMs.count, 3);
  assert.equal(summary.distinctFinalAssistantOutputs, 1);
  assert.deepEqual(summary.repetitions.map(({ ordinal, status }) => [ordinal, status]), [
    [1, "completed"], [2, "completed"], [3, "completed"],
  ]);
  assert.ok(summary.repetitions.every(({ trace }) => /^traces[/\\]run_.+\.json$/.test(trace ?? "")));
  assert.ok(!JSON.stringify(summary).includes(ANSWER), "the summary never copies model output");

  const text = formatHeadlessRepeatedSummary(summary);
  assert.match(text, /^Repeated run — COMPLETED$/m);
  assert.match(text, /^3 of 3 repetitions completed\.$/m);
  assert.match(text, /^Buffered, so TTFO is the time to the whole response\.$/m);
  assert.ok(!text.includes(ANSWER));
});

test("--response-mode streaming streams", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(withCapabilities(provider.endpoint, { streaming: true }));

  const outcome = await repeat(directory, { repetitions: 2, responseMode: "streaming" }).done;

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.exitCode, 0);
  assert.ok(provider.requests.every(({ body }) => body.stream === true));
  assert.equal(outcome.summary?.responseMode, "streaming");
  assert.equal(outcome.summary?.metrics.ttfoMs.count, 2);
  assert.doesNotMatch(formatHeadlessRepeatedSummary(outcome.summary!), /time to the whole response/);
});

test("streaming on a connection that does not declare it exits 2, never silently buffered", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(withCapabilities(provider.endpoint, { streaming: false }));

  const outcome = await repeat(directory, { responseMode: "streaming" }).done;

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.error ?? "", /connection "Default connection" \(connection_headless-default\) does not enable streaming/);
  assert.match(outcome.error ?? "", /--response-mode buffered/);
  assert.equal(provider.requests.length, 0);
  await assert.rejects(stat(path.join(directory, "experiments")), { code: "ENOENT" });
});

test("a failed repetition exits 1 and names it with its trace", async (t) => {
  const provider = await recordingProvider({ failFirstRequest: 400 });
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));

  const outcome = await repeat(directory, { repetitions: 2 }).done;

  assert.equal(outcome.exitCode, 1);
  const summary = outcome.summary!;
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.lifecycle, "completed");
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.completed, 1);
  const failed = summary.repetitions.find(({ status }) => status === "failed")!;
  assert.match(formatHeadlessRepeatedSummary(summary), new RegExp(`✗ #${failed.ordinal} failed \\(${failed.trace!.replace(/[\\/.]/g, "\\$&")}\\)`));
});

test("a run held back only by rate limiting exits 3, not 1", async (t) => {
  const provider = await recordingProvider({ rateLimitFirstRequest: "0" });
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));

  const outcome = await repeat(directory, { repetitions: 2 }).done;

  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.summary?.outcome, "incomplete");
  assert.equal(outcome.summary?.lifecycle, "completed");
  assert.equal(outcome.summary?.counts.rateLimited, 1);
});

test("an enabled tool with no mock or grant exits 2, naming the tool", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const tool: ToolDefinition = {
    id: "tool_weather" as ToolDefinition["id"],
    name: "get_weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  };
  const base = withCapabilities(provider.endpoint, { tools: true });
  const directory = await writeHeadlessProjectFolder(parseProjectFile({
    ...base,
    tools: [tool],
    defaults: { ...base.defaults, enabledToolIds: [tool.id] },
  }));

  const outcome = await repeat(directory).done;

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.error ?? "", /The project's defaults enable get_weather, and nothing in this run can answer it\./);
  assert.equal(provider.requests.length, 0);
});

test("the repeat command defaults to 5 repetitions and prints its --json summary on stdout only", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runCli(["repeat", directory, "--json"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    environment: { [KEY_VARIABLE]: KEY },
  });

  assert.equal(code, 0);
  assert.equal(provider.requests.length, 5);
  const summary = JSON.parse(stdout.join(""));
  assert.equal(summary.kind, "repeated-request");
  assert.equal(summary.counts.requested, 5);
  assert.match(stderr.join(""), /\[5\/5\] Repetition #5: completed/);
});

test("the evaluation summary now says its kind", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));
  const stdout: string[] = [];
  assert.equal(await runCli(["run", directory, "--json"], {
    stdout: (text) => stdout.push(text), stderr: () => {}, environment: { [KEY_VARIABLE]: KEY },
  }), 0);
  const summary = JSON.parse(stdout.join(""));
  assert.equal(summary.kind, "evaluation");
  assert.equal(summary.schemaVersion, 1);
});

test("bad repeat usage exits 2 before any request or artifact", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));
  const attempt = async (...argv: string[]) => {
    const stderr: string[] = [];
    const code = await runCli(argv, {
      stdout: () => {}, stderr: (text) => stderr.push(text), environment: { [KEY_VARIABLE]: KEY },
    });
    return { code, stderr: stderr.join("") };
  };

  for (const flag of ["--suite", "--case", "--configuration"]) {
    const { code, stderr } = await attempt("repeat", directory, flag, "x");
    assert.equal(code, 2, flag);
    assert.match(stderr, new RegExp(`Unknown option '${flag}'`), flag);
  }
  for (const value of ["1", "101", "two", "2.5"]) {
    const { code, stderr } = await attempt("repeat", directory, "--repetitions", value);
    assert.equal(code, 2, value);
    assert.match(stderr, /--repetitions must be a whole number from 2 to 100/, value);
  }
  {
    const { code, stderr } = await attempt("repeat", directory, "--response-mode", "chunked");
    assert.equal(code, 2);
    assert.match(stderr, /--response-mode must be streaming or buffered, not "chunked"/);
  }
  for (const flag of ["--repetitions", "--response-mode"]) {
    const { code, stderr } = await attempt("run", directory, flag, "3");
    assert.equal(code, 2, flag);
    assert.match(stderr, new RegExp(`Unknown option '${flag}'`), flag);
  }
  assert.equal(provider.requests.length, 0);
  await assert.rejects(stat(path.join(directory, "experiments")), { code: "ENOENT" });
});
