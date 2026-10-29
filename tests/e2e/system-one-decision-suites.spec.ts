import type { DecisionInput } from "../../packages/core/src/decision";
import { inlineRevision } from "../project-kind-helpers";
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "./support/test";

import { updateDecisionRequestDraft } from "../../packages/core/src/decision-request";
import { decisionRunTrace } from "../../packages/core/src/decision-trace";
import { createDecisionEvaluationExperimentPlan } from "../../packages/core/src/evaluation-execution";
import {
  EXPERIMENT_RESULT_SCHEMA_VERSION,
  materializeParsedDecisionCellInput,
  noExperimentRetries,
  sequentialExperimentConcurrency,
  serializeExperimentPlan,
  serializeExperimentResult,
  type ExperimentResult,
} from "../../packages/core/src/experiment";
import { createProjectFile, parseProjectFile, serializeProjectFile } from "../../packages/core/src/project";
import type { EvaluationVariantId } from "../../packages/core/src/run-kernel";
import { serializeDecisionRunTrace } from "../../packages/core/src/run-trace";
import { decisionAnswers, decisionProject, decisionRuntimeTarget, finishedDecisionRun } from "../fixtures/decision-evaluation";
import type { ProjectFile } from "../../packages/core/src/project";
import { resolveProviderCapabilities } from "../../packages/core/src/types";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  SYSTEM_ONE_FIXTURE_ORIGIN,
  openMode,
  primaryAction,
  seedProfiles,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

/**
 * Decision suites (System One D44–D52) against the capture replay. The replay
 * answers the captured questions whatever the state says, so every repetition
 * routes `intent` to `billing`: a case asserting billing passes and one
 * asserting bug fails, which the scores can be checked against.
 */

const captured = JSON.parse(
  readFileSync(new URL("../fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8"),
).request as { state: { ticket: string; plan: string }; questions: DecisionInput["questions"] };

const DECISION_ENDPOINT = `${SYSTEM_ONE_FIXTURE_ORIGIN}/llamacpp/v1`;

function projectWithRequest(): string {
  const project = createProjectFile({
    name: "Decision suites",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "fixture-model",
      messages: [{ role: "user", content: "Hello" }],
      capabilities: resolveProviderCapabilities("openai-compatible"),
    },
    idSuffix: "decision-suites",
    createdAt: "2026-10-24T12:00:00.000Z",
  });
  return serializeProjectFile(updateDecisionRequestDraft(project, {
    decision: {
      state: { ticket: "{{ticket}}", plan: captured.state.plan },
      questions: captured.questions as never,
    },
    values: { ticket: captured.state.ticket },
    branch: false,
    idSuffix: "routing",
    createdAt: "2026-10-24T12:01:00.000Z",
  }));
}

async function openFolder(page: Page, manifest = projectWithRequest()): Promise<void> {
  await seedProfiles(page, [
    { id: "buffered", instanceId: "buffered-instance", name: "Buffered fixture", endpoint: BUFFERED_FIXTURE_ENDPOINT },
    {
      id: "decisions",
      instanceId: "decisions-instance",
      name: "Decision fixture",
      endpoint: DECISION_ENDPOINT,
      model: "unused-chat-model",
      systemOne: true,
    },
  ], "buffered");
  // As the chat evaluation specs do: at the default 720px the cases' 360px
  // floor squeezes the setup band to its toggle.
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubProjectDirectory(page, { name: "decision-suites.inference-lens", files: { "project.json": manifest } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Decision suites");
  await page.getByRole("radio", { name: "Decision" }).click();
  const model = page.getByRole("region", { name: "Decision request" }).getByRole("combobox", { name: "Model" });
  await model.fill("all-types");
  await model.press("Escape");
}

async function savedFile(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(async (segments) => {
    let directory = await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
    for (const segment of segments.slice(0, -1)) {
      try { directory = await directory.getDirectoryHandle(segment); } catch { return undefined; }
    }
    try { return await (await directory.getFileHandle(segments.at(-1)!)).getFile().then((file) => file.text()); } catch { return undefined; }
  }, path.split("/"));
}

async function savedProject(page: Page): Promise<ProjectFile> {
  return JSON.parse((await savedFile(page, "project.json"))!) as ProjectFile;
}

async function savedNames(page: Page, directoryName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    const root = await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
    let directory: FileSystemDirectoryHandle;
    try { directory = await root.getDirectoryHandle(name); } catch { return []; }
    const names: string[] = [];
    for await (const entry of (directory as unknown as { values(): AsyncIterable<{ name: string }> }).values()) names.push(entry.name);
    return names.sort();
  }, directoryName);
}

/** Adds a case that varies the ticket and asserts the routed intent. */
async function addCase(page: Page, name: string, ticket: string, option: string): Promise<void> {
  const editor = page.locator(".evaluation-editor");
  await editor.getByRole("button", { name: "+ Add case", exact: true }).first().click();
  await editor.getByRole("button", { name: "Edit case name" }).click();
  await editor.getByLabel("Case name", { exact: true }).fill(name);
  await editor.getByLabel("Case name", { exact: true }).press("Enter");
  await editor.getByLabel(`${name} ticket`).fill(ticket);
  await editor.getByLabel("New check kind").selectOption({ label: "Choice is" });
  await editor.getByRole("button", { name: "+ Add check" }).click();
  await editor.getByLabel("Decision question").selectOption("intent");
  await editor.getByLabel("Decision option").selectOption(option);
}

test("a suite made from Decision Compose runs its cases on the decision connection and scores the answers", async ({ page }) => {
  await openFolder(page);
  await page.getByRole("button", { name: "New suite from this request" }).click();

  // It lands in Evaluations as a decision suite with its own connection.
  await expect(page.getByRole("navigation", { name: "Evaluation suites" })).toContainText("Decision · 0 cases");
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("Decision suite");
  await expect(editor.getByLabel("Decision suite model")).toHaveValue("all-types");
  await expect(editor.getByLabel("Decision suite connection")).toHaveValue(/^connection_/);
  await expect(editor.getByLabel("Decision suite connection").locator("option:checked")).toHaveText("Decision connection");

  await editor.getByLabel("Request variable to vary").selectOption("ticket");
  await editor.getByRole("button", { name: "+ Add case input" }).click();
  await addCase(page, "Billing", "I was charged twice for October.", "billing");
  await addCase(page, "Crash", "The app crashes when I open invoices.", "bug");
  await expect(page.locator("#evaluation-preflight-summary")).toHaveText("Ready to run");

  await primaryAction(page, "evaluations").click();
  const confirmation = page.getByRole("dialog", { name: /Start “Decision request evaluation”/ });
  await confirmation.getByRole("button", { name: "Start 2 calls" }).click();

  const results = page.getByRole("region", { name: "Evaluation results" });
  await expect(results).toContainText("1 / 2 passed");
  await expect(results).toContainText("intent: billing");
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  // The plan, its result, and one decision trace per repetition are in the folder.
  await expect.poll(async () => (await savedNames(page, "experiments")).filter((name) => name.endsWith(".result.json")).length).toBe(1);
  const planName = (await savedNames(page, "experiments")).find((name) => name.endsWith(".plan.json"))!;
  const plan = JSON.parse((await savedFile(page, `experiments/${planName}`))!) as { kind: string; suite: { decisionRequestRevisionId: string }; cells: { runId: string }[] };
  expect(plan.kind).toBe("decision-evaluation");
  expect(plan.suite.decisionRequestRevisionId).toBe("decision-revision_routing");
  const traces = await savedNames(page, "traces");
  for (const { runId } of plan.cells) expect(traces).toContain(`${runId}.json`);

  // A repetition opens its trace in Decision Compose, as Runs does.
  const crash = results.locator("details.evaluation-case-result", { hasText: "Crash" });
  await crash.locator("summary").click();
  await expect(crash).toContainText("check failed");
  await crash.getByRole("button", { name: "Open Response & Inspect" }).click();
  await expect(page.getByRole("article", { name: "Answer intent" })).toContainText("Choice billing");
});

test("editing the request after a suite pins it makes a new revision and leaves the suite's alone", async ({ page }) => {
  await openFolder(page);
  await page.getByRole("button", { name: "New suite from this request" }).click();
  await expect(page.locator(".evaluation-editor")).toContainText("Decision suite");

  await openMode(page, "Compose");
  const variables = page.getByRole("region", { name: "Decision request" }).getByRole("region", { name: "Variables" });
  await variables.getByLabel("{{ticket}}").fill("A different ticket");
  await expect.poll(async () => (await savedProject(page)).decisionRequestRevisions.length).toBe(2);
  const saved = await savedProject(page);
  const pinned = inlineRevision(saved.decisionRequestRevisions.find(({ id }) => id === "decision-revision_routing"));
  expect(pinned.values.ticket).toBe(captured.state.ticket);
  const suite = saved.evaluationSuites[0]!;
  expect(suite.input).toEqual({ kind: "decision-request-revision", decisionRequestRevisionId: "decision-revision_routing" });
  expect(saved.defaults.decisionRequestRevisionId).not.toBe("decision-revision_routing");
});

test("the rail makes a decision suite from Compose's request, and offers decision checks only", async ({ page }) => {
  await openFolder(page);
  await openMode(page, "Evaluations");
  await page.getByRole("button", { name: "+ New decision suite" }).click();
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("Decision suite");
  await editor.getByRole("button", { name: "+ Add case", exact: true }).first().click();
  const kinds = await editor.getByLabel("New check kind").locator("option").allTextContents();
  expect(kinds).toEqual(["Maximum duration", "Maximum tokens", "Choice is", "Option probability", "Score range", "Noul probability", "Confidence"]);
});

/** Two saved executions of the fixture's decision suite, differing only in model. */
function decisionHistoryFolder(): Record<string, string> {
  const source = decisionProject();
  // The shared fixture reuses a check id across cases; the project file must not.
  const project = parseProjectFile({
    ...source,
    evaluationSuites: source.evaluationSuites.map((suite) => ({
      ...suite,
      variants: suite.variants.slice(0, 1),
      cases: suite.cases.map((item) => ({
        ...item,
        checks: item.checks.map((check, index) => ({ ...check, checkId: `check_${item.id.slice("evaluation-case_".length)}-${index}` })),
      })),
    })),
  } as ProjectFile);
  const execution = (model: string, createdAt: string, prefix: string, refundChoice: string) => {
    let counter = 0;
    const withModel = parseProjectFile({
      ...project,
      evaluationSuites: project.evaluationSuites.map((suite) => ({ ...suite, execution: { ...suite.execution, target: { ...suite.execution.target, model } } })),
    } as ProjectFile);
    const plan = createDecisionEvaluationExperimentPlan({
      project: withModel,
      suiteId: "evaluation-suite_routing",
      selectedCaseIds: ["evaluation-case_refund", "evaluation-case_crash"],
      runtimeTargets: { ["evaluation-variant_base" as EvaluationVariantId]: decisionRuntimeTarget("local") },
      createdAt,
      createSuffix: () => `${prefix}${++counter}`,
    });
    const files: Record<string, string> = {};
    for (const cell of plan.cells) {
      const choice = cell.caseId === "evaluation-case_refund" ? refundChoice : "bug";
      const run = finishedDecisionRun(materializeParsedDecisionCellInput(plan, cell), {
        last: { kind: "completed", answers: decisionAnswers(choice, 1.5) },
        durationMs: 800,
      });
      files[`traces/${run.runId}.json`] = serializeDecisionRunTrace(decisionRunTrace(run));
    }
    const result: ExperimentResult = {
      schemaVersion: EXPERIMENT_RESULT_SCHEMA_VERSION,
      experimentId: plan.experimentId,
      status: "completed",
      endedAt: createdAt.replace(":00:00.000Z", ":05:00.000Z"),
      concurrency: sequentialExperimentConcurrency(plan),
      retryPolicy: noExperimentRetries(),
      cells: plan.cells.map((cell, index) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed", startOrder: index + 1 })),
    };
    files[`experiments/${plan.experimentId}.plan.json`] = serializeExperimentPlan(plan);
    files[`experiments/${plan.experimentId}.result.json`] = serializeExperimentResult(result, plan);
    return files;
  };
  return {
    "project.json": serializeProjectFile(project),
    ...execution("local-decision", "2026-10-24T13:00:00.000Z", "base", "refund"),
    ...execution("other-decision", "2026-10-24T14:00:00.000Z", "cand", "billing"),
  };
}

test("a pinned decision baseline compares by case and names the model as decision drift", async ({ page }) => {
  await seedProfiles(page, [
    { id: "buffered", instanceId: "buffered-instance", name: "Buffered fixture", endpoint: BUFFERED_FIXTURE_ENDPOINT },
  ], "buffered");
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubProjectDirectory(page, { name: "decision-history.inference-lens", files: decisionHistoryFolder(), directories: [] });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await openMode(page, "Evaluations");
  await page.locator(".evaluation-suite-history").getByText("Past executions").click();
  const entries = page.locator(".evaluation-suite-history-entry");
  await expect(entries).toHaveCount(2);

  const baseline = entries.filter({ hasText: "local-decision" });
  await baseline.getByRole("button", { name: "Pin as baseline…" }).click();
  await page.getByLabel("Baseline name").fill("Local model");
  await baseline.getByRole("button", { name: "Save baseline" }).click();
  await expect(baseline).toContainText("Baseline · Local model");

  const candidate = entries.filter({ hasText: "other-decision" });
  await candidate.getByLabel("Compare against baseline").selectOption({ label: "Local model · Default" });
  await candidate.getByRole("button", { name: "Compare" }).click();

  const comparison = page.getByRole("region", { name: "Evaluation comparison" });
  const rows = comparison.locator(".evaluation-comparison-table tbody tr");
  await expect(rows.filter({ hasText: "Refund" })).toContainText("regressed");
  await expect(rows.filter({ hasText: "Crash" })).toContainText("unchanged");
  const drift = comparison.getByLabel("Execution differences");
  await expect(drift).toContainText("Model");
  await expect(drift).toContainText("local-decision");
  await expect(drift).toContainText("other-decision");
  // Chat-only settings are not decision drift.
  await expect(drift).not.toContainText("Response mode");
  await expect(drift).not.toContainText("Inference options");
  await expect(comparison).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  // A decision repetition opens in Decision Compose.
  await rows.filter({ hasText: "Refund" }).getByRole("button", { name: "Refund" }).click();
  await comparison.locator(".evaluation-comparison-detail").getByRole("button", { name: "Open candidate trace" }).click();
  await expect(page.getByRole("article", { name: "Answer intent" })).toContainText("Choice billing");
});

test("a v15 template-backed suite resolves its pin on screen and sends an explicit empty case value", async ({ page }) => {
  const { createDecisionPromptTemplate } = await import("../../packages/core/src/decision-template");
  const { useDecisionPromptTemplateRevision } = await import("../../packages/core/src/decision-request");
  const { createPromptTemplate } = await import("../../packages/core/src/project");
  const { headlessDecisionProject } = await import("../fixtures/headless/project");
  const { parseSavedRunTraceJson } = await import("../../packages/core/src/run-trace");
  let project = headlessDecisionProject({ endpoint: DECISION_ENDPOINT, questions: captured.questions, model: "all-types" });
  project = createDecisionPromptTemplate(project, { name: "Saved decision source", idSuffix: "source", revisionIdSuffix: "source",
    decision: { state: { ticket: "{{ticket}}", plan: "{{plan}}" }, questions: {
      ...captured.questions,
      intent: { ...captured.questions.intent!, instructions: "{{instruction}}" },
    } }, variableDefaults: { ticket: "Template fallback", plan: "pro", instruction: captured.questions.intent!.instructions as string } });
  project = createPromptTemplate(project, { name: "Chat sentinel", messages: [{ role: "user", content: "Chat text" }] });
  project = useDecisionPromptTemplateRevision(project, { templateId: "template_source", overrides: { ticket: "Request fallback" }, idSuffix: "pin", activate: false });
  project = parseProjectFile({ ...project, name: "Decision suites", evaluationSuites: project.evaluationSuites.map((suite) => ({ ...suite,
    input: { kind: "decision-request-revision", decisionRequestRevisionId: "decision-revision_pin" },
    cases: suite.cases.map((evaluationCase) => ({ ...evaluationCase, values: { "evaluation-input_ticket": "" } })),
  })) });
  await openFolder(page, serializeProjectFile(project));
  await page.locator(".target-menu summary").click();
  await page.getByRole("button", { name: /manage connections/i }).click();
  await page.getByRole("combobox", { name: "Profile for Default connection" }).selectOption("decisions");
  await page.keyboard.press("Escape");
  await openMode(page, "Prompts");
  await expect(page.getByText("Chat sentinel", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved decision source", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByText("Saved decision source", { exact: true })).toHaveCount(0);
  await openMode(page, "Evaluations");
  await page.getByRole("navigation", { name: "Evaluation suites" }).getByRole("button", { name: /Triage/ }).click();
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("Decision suite");
  // The check editor obtains options from the pinned source through the shared resolver.
  await expect(editor.getByLabel("Decision question").first()).toHaveValue("intent");
  await expect(editor.getByLabel("Decision option")).toHaveValue("billing");
  await expect(page.locator("#evaluation-preflight-summary")).toHaveText("Ready to run");
  await primaryAction(page, "evaluations").click();
  const confirmation = page.getByRole("dialog", { name: /Start “Triage”/ });
  await confirmation.getByRole("button", { name: "Start 1 calls", exact: true }).click();
  const results = page.getByRole("region", { name: "Evaluation results" });
  await expect(results).toContainText("1 / 1 passed");
  await expect(results).toContainText("intent: billing");
  await expect.poll(async () => (await savedNames(page, "traces")).length).toBe(1);
  const traceName = (await savedNames(page, "traces"))[0]!;
  const saved = parseSavedRunTraceJson((await savedFile(page, `traces/${traceName}`))!);
  expect(saved.kind).toBe("decision");
  if (saved.kind !== "decision") throw new Error("Expected a decision trace");
  expect(saved.trace.input.decision.state).toEqual({ ticket: "", plan: "pro" });
  // The captured replay refuses questions that differ, so the successful answer
  // also proves the default instruction was rendered before provider execution.
  expect(saved.trace.input.decision.questions).toEqual(captured.questions);
  const exchange = Object.values(saved.trace.exchanges)[0]!;
  expect(JSON.parse(exchange.request!.body!)).toMatchObject({ state: { ticket: "", plan: "pro" }, questions: captured.questions });
  const reopened = await savedProject(page);
  expect(reopened.promptTemplates.find(({ id }) => id === "template_source")?.kind).toBe("decision");
  expect(reopened.defaults.decisionRequestRevisionId).toBe(project.defaults.decisionRequestRevisionId);
});

test("clearing a decision case value leaves it unfilled and blocks the run instead of sending an empty value", async ({ page }) => {
  await openFolder(page);
  await page.getByRole("button", { name: "New suite from this request" }).click();
  const editor = page.locator(".evaluation-editor");
  await editor.getByLabel("Request variable to vary").selectOption("ticket");
  await editor.getByRole("button", { name: "+ Add case input" }).click();
  await addCase(page, "Billing", "I was charged twice for October.", "billing");
  await expect(page.locator("#evaluation-preflight-summary")).toHaveText("Ready to run");

  await editor.getByLabel("Billing ticket").fill("");
  await expect(page.locator("#evaluation-preflight-summary")).not.toHaveText("Ready to run");
  await expect(page.getByRole("region", { name: "Evaluation preflight" })).toContainText('Case "Billing" has no value for input "ticket".');
  await expect.poll(async () => (await savedProject(page)).evaluationSuites[0]?.cases[0]?.values).toEqual({});
});
