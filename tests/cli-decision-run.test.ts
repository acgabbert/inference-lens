import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { startHeadlessEvaluation } from "../packages/cli/src/evaluation-run.ts";
import { runCli } from "../packages/cli/src/main.ts";
import { createInProcessTransport } from "../packages/cli/src/transport.ts";
import { loadProjectHistoryFiles } from "../packages/core/src/experiment-history.ts";
import { parseExperimentPlanJson, parseExperimentResultJson } from "../packages/core/src/experiment.ts";
import { parseSavedRunTraceJson } from "../packages/core/src/run-trace.ts";
import { CAPTURED_QUESTIONS, recordingDecisionProvider } from "./fixtures/headless/decision-provider.ts";
import { headlessDecisionProject, headlessProject, writeHeadlessProjectFolder } from "./fixtures/headless/project.ts";
import { recordingProvider } from "./fixtures/headless/recording-provider.ts";
import { createDecisionTemplateEvaluation, retargetDecisionTemplateEvaluation } from "../packages/core/src/decision-template-evaluation.ts";
import { createDecisionPromptTemplate, appendDecisionPromptTemplateRevision } from "../packages/core/src/decision-template.ts";
import { parseProjectFile } from "../packages/core/src/project.ts";
import { inlineRevision } from "./project-kind-helpers.ts";

/**
 * 5c: `inference-lens run` dispatches on the suite's kind (D36). A decision
 * suite needs no System One flag: the suite is the declaration (D54).
 */

const KEY = "sk-headless-decision-secret";
const KEY_VARIABLE = "INFERENCE_LENS_CONNECTION_HEADLESS_DEFAULT_API_KEY";

async function list(directory: string, name: string) {
  try {
    return await Promise.all((await readdir(path.join(directory, name))).map(async (fileName) => ({
      fileName,
      contents: await readFile(path.join(directory, name, fileName), "utf8"),
    })));
  } catch {
    return [];
  }
}

function run(directory: string, environment: Record<string, string>, extra: Partial<Parameters<typeof startHeadlessEvaluation>[0]> = {}) {
  return startHeadlessEvaluation({
    projectDirectory: directory,
    environment,
    transport: createInProcessTransport({ containerized: false }),
    ...extra,
  });
}

test("a passing decision suite exits 0, reaches /systemone with the key, and writes artifacts history reads", async (t) => {
  const provider = await recordingDecisionProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(
    headlessDecisionProject({ endpoint: provider.endpoint, questions: CAPTURED_QUESTIONS, repetitions: 2 }),
  );
  const projectBefore = await readFile(path.join(directory, "project.json"), "utf8");

  const progress: string[] = [];
  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }, { onProgress: (line) => progress.push(line) }).done;

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.summary?.verdict, "passed");
  assert.equal(outcome.summary?.runKind, "decision");
  assert.deepEqual(
    outcome.summary?.configurations.map(({ protocol, model, passed }) => ({ protocol, model, passed })),
    [{ protocol: "systemone", model: "local-decision", passed: true }],
  );
  assert.deepEqual(progress, [
    "[1/2] Default · Routes billing #1: completed",
    "[2/2] Default · Routes billing #2: completed",
  ]);

  // The case value reached the state, and the key reached only the provider.
  assert.equal(provider.requests.length, 2);
  for (const request of provider.requests) {
    assert.equal(request.path, "/v1/systemone");
    assert.equal(request.authorization, `Bearer ${KEY}`);
    assert.equal(request.body.model, "local-decision");
    assert.deepEqual(request.body.state, { ticket: "I was charged twice.", plan: "pro" });
  }
  const experiments = await list(directory, "experiments");
  const traces = await list(directory, "traces");
  for (const file of [...experiments, ...traces]) {
    assert.ok(!file.contents.includes(KEY), `${file.fileName} must not contain the key`);
  }
  assert.equal(await readFile(path.join(directory, "project.json"), "utf8"), projectBefore, "project.json is never written");

  const plan = parseExperimentPlanJson(experiments.find(({ fileName }) => fileName.endsWith(".plan.json"))!.contents);
  assert.equal(plan.kind, "decision-evaluation");
  const result = parseExperimentResultJson(experiments.find(({ fileName }) => fileName.endsWith(".result.json"))!.contents, plan);
  assert.equal(result.status, "completed");
  assert.equal(traces.length, 2);
  assert.ok(traces.every(({ contents }) => parseSavedRunTraceJson(contents).kind === "decision"));

  const history = loadProjectHistoryFiles(traces, experiments);
  assert.deepEqual(history.failures, []);
  assert.equal(history.experiments.length, 1);
  const [entry] = history.experiments;
  assert.equal(entry.kind, "evaluation");
  assert.equal(entry.kind === "evaluation" ? entry.evaluation.runKind : undefined, "decision");
  assert.equal(entry.completed, 2);
});

test("a failing decision check exits 1 and names the case", async (t) => {
  const provider = await recordingDecisionProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(
    headlessDecisionProject({ endpoint: provider.endpoint, questions: CAPTURED_QUESTIONS, expectBug: true }),
  );

  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }).done;

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.summary?.verdict, "failed");
  const [configuration] = outcome.summary!.configurations;
  assert.deepEqual(configuration.caseCounts, { total: 2, passed: 1, failed: 1, incomplete: 0 });
  const crash = configuration.cases.find(({ caseId }) => caseId === "evaluation-case_crash")!;
  assert.equal(crash.passed, false);
  assert.deepEqual(crash.checks, { total: 1, passed: 0, failed: 1, notEvaluated: 0 });
  assert.equal(crash.repetitions[0].classification, "check-failed");
});

test("a rate-limited decision suite is incomplete, and --retry-rate-limits retries it", async (t) => {
  const limited = await recordingDecisionProvider({ alwaysRateLimit: true });
  t.after(limited.close);
  const limitedDirectory = await writeHeadlessProjectFolder(
    headlessDecisionProject({ endpoint: limited.endpoint, questions: CAPTURED_QUESTIONS }),
  );
  const refused = await run(limitedDirectory, { [KEY_VARIABLE]: KEY }).done;
  assert.equal(refused.exitCode, 3);
  assert.equal(refused.summary?.verdict, "incomplete");
  assert.equal(refused.summary?.configurations[0].cases[0].repetitions[0].classification, "rate-limited");
  assert.equal(limited.requests.length, 1);

  const once = await recordingDecisionProvider({ rateLimitFirstRequest: "0" });
  t.after(once.close);
  const onceDirectory = await writeHeadlessProjectFolder(
    headlessDecisionProject({ endpoint: once.endpoint, questions: CAPTURED_QUESTIONS }),
  );
  const retried = await run(onceDirectory, { [KEY_VARIABLE]: KEY }, { retryRateLimits: true }).done;
  assert.equal(retried.exitCode, 0);
  assert.equal(once.requests.length, 2);
  assert.equal(retried.summary?.configurations[0].retriedAfterRateLimit, 1);
});

test("a decision suite with no credential is a setup error and sends nothing", async (t) => {
  const provider = await recordingDecisionProvider();
  t.after(provider.close);
  const directory = await writeHeadlessProjectFolder(
    headlessDecisionProject({ endpoint: provider.endpoint, questions: CAPTURED_QUESTIONS }),
  );

  const outcome = await run(directory, {}).done;

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.error ?? "", /No credential for connection/);
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(await list(directory, "experiments"), []);
});

test("`run --json` reports a decision suite, and a chat suite reports runKind chat", async (t) => {
  const decisions = await recordingDecisionProvider();
  t.after(decisions.close);
  const decisionDirectory = await writeHeadlessProjectFolder(
    headlessDecisionProject({ endpoint: decisions.endpoint, questions: CAPTURED_QUESTIONS }),
  );
  let stdout = "";
  const exitCode = await runCli(["run", decisionDirectory, "--suite", "Triage", "--json"], {
    stdout: (text) => { stdout += text; },
    stderr: () => {},
    environment: { [KEY_VARIABLE]: KEY },
  });
  assert.equal(exitCode, 0);
  const summary = JSON.parse(stdout);
  assert.equal(summary.kind, "evaluation");
  assert.equal(summary.runKind, "decision");
  assert.equal(summary.suite.suiteId, "evaluation-suite_triage");

  const chat = await recordingProvider();
  t.after(chat.close);
  const chatDirectory = await writeHeadlessProjectFolder(headlessProject({ endpoint: chat.endpoint }));
  const chatOutcome = await run(chatDirectory, { [KEY_VARIABLE]: KEY }).done;
  assert.equal(chatOutcome.exitCode, 0);
  assert.equal(chatOutcome.summary?.runKind, "chat");
});

test("the CLI resolves a saved decision template pin before case values and preserves the shared project", async (t) => {
  const { createDecisionPromptTemplate } = await import("../packages/core/src/decision-template.ts");
  const { useDecisionPromptTemplateRevision } = await import("../packages/core/src/decision-request.ts");
  const { parseProjectFile } = await import("../packages/core/src/project.ts");
  const { inlineRevision } = await import("./project-kind-helpers.ts");
  const provider = await recordingDecisionProvider();
  t.after(provider.close);
  let project = headlessDecisionProject({ endpoint: provider.endpoint, questions: CAPTURED_QUESTIONS });
  const source = inlineRevision(project.decisionRequestRevisions[0]);
  project = createDecisionPromptTemplate(project, { name: "Reusable routing", decision: source.decision,
    variableDefaults: { ...source.values, ticket: "Template fallback" }, idSuffix: "routing", revisionIdSuffix: "routing" });
  project = useDecisionPromptTemplateRevision(project, { templateId: "template_routing", overrides: { ticket: "Request override" }, idSuffix: "template-pin", activate: false });
  project = parseProjectFile({ ...project, evaluationSuites: project.evaluationSuites.map((suite) => ({ ...suite,
    input: { kind: "decision-request-revision", decisionRequestRevisionId: "decision-revision_template-pin" } })) });
  const directory = await writeHeadlessProjectFolder(project);
  const before = await readFile(path.join(directory, "project.json"), "utf8");
  const outcome = await run(directory, { [KEY_VARIABLE]: KEY }).done;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.exitCode, 0);
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(provider.requests[0]!.body.state, { ticket: "I was charged twice.", plan: "pro" });
  assert.deepEqual(provider.requests[0]!.body.questions, CAPTURED_QUESTIONS);
  const files = await list(directory, "experiments");
  const plan = parseExperimentPlanJson(files.find(({ fileName }) => fileName.endsWith(".plan.json"))!.contents);
  assert.ok(plan.kind === "decision-evaluation");
  assert.equal(plan.suite.decisionRequestRevisionId, "decision-revision_template-pin");
  assert.equal(await readFile(path.join(directory, "project.json"), "utf8"), before);
});

test("library-created and deliberately retargeted decision suites run through the CLI with immutable historical inputs", async (t) => {
  const provider = await recordingDecisionProvider();
  t.after(provider.close);
  const original = headlessDecisionProject({ endpoint: provider.endpoint, questions: CAPTURED_QUESTIONS });
  const source = inlineRevision(original.decisionRequestRevisions[0]);
  const authored = { ...source.decision, state: { ticket: "{{ticket}}", plan: "{{plan}}" } };
  const template = createDecisionPromptTemplate({ ...original, evaluationSuites: [] }, { name: "Library triage", decision: authored,
    variableDefaults: { ...source.values, plan: "pro" }, idSuffix: "library", revisionIdSuffix: "library-one" });
  const created = createDecisionTemplateEvaluation(template, { templateId: "template_library", templateRevisionId: "template-revision_library-one" });
  const suite = created.project.evaluationSuites[0]!;
  // The usual suite editor owns cases, checks and target. Reuse the captured fixture's authored settings.
  let project = parseProjectFile({ ...created.project, evaluationSuites: [{ ...original.evaluationSuites[0]!, id: suite.id, name: suite.name, input: suite.input }] });
  project = appendDecisionPromptTemplateRevision(project, { templateId: "template_library", idSuffix: "library-two", decision: authored,
    variableDefaults: { ...source.values, plan: "enterprise" } });
  const firstDirectory = await writeHeadlessProjectFolder(project);
  let stdout = "";
  const code = await runCli(["run", firstDirectory, "--suite", suite.name, "--json"], { environment: { [KEY_VARIABLE]: KEY }, stdout: (line) => { stdout += line; }, stderr() {} });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).runKind, "decision");
  assert.deepEqual(provider.requests[0]!.body.state, { ticket: "I was charged twice.", plan: "pro" });
  const firstFiles = await list(firstDirectory, "experiments");
  const firstPlan = firstFiles.find(({ fileName }) => fileName.endsWith(".plan.json"))!.contents;
  const historical = parseExperimentPlanJson(firstPlan);
  const updated = retargetDecisionTemplateEvaluation(project, { suiteId: suite.id, templateId: "template_library", templateRevisionId: "template-revision_library-two" });
  const secondDirectory = await writeHeadlessProjectFolder(updated);
  const before = await readFile(path.join(secondDirectory, "project.json"), "utf8");
  const outcome = await run(secondDirectory, { [KEY_VARIABLE]: KEY }).done;
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(provider.requests[1]!.body.state, { ticket: "I was charged twice.", plan: "enterprise" });
  assert.deepEqual(updated.defaults, original.defaults);
  assert.equal(await readFile(path.join(secondDirectory, "project.json"), "utf8"), before);
  assert.deepEqual(parseExperimentPlanJson(firstPlan), historical);
  assert.equal((await list(firstDirectory, "experiments")).find(({ fileName }) => fileName.endsWith(".plan.json"))!.contents, firstPlan);
});
