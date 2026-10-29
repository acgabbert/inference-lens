import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "./support/test";

import { startHeadlessEvaluation } from "../../packages/cli/src/evaluation-run";
import { startHeadlessRepeat } from "../../packages/cli/src/repeated-run";
import { createInProcessTransport } from "../../packages/cli/src/transport";
import { parseRunTraceJson, runStateFromTrace } from "../../packages/core/src/run-trace";
import { finalAssistantOutput } from "../../packages/core/src/run-output";
import type { CheckDefinition } from "../../packages/core/src/checks";
import type { ToolDefinition } from "../../packages/core/src/run-kernel/types";
import { CAPTURED_QUESTIONS } from "../fixtures/headless/decision-provider";
import {
  HEADLESS_CONNECTION_ID,
  headlessDecisionProject,
  headlessProject,
  headlessToolProject,
  writeHeadlessProjectFolder,
} from "../fixtures/headless/project";
import { toolCallingProvider } from "../fixtures/headless/tool-calling-provider";
import { BUFFERED_FIXTURE_ENDPOINT, SYSTEM_ONE_FIXTURE_ORIGIN, seedProfile, stubProjectDirectory, waitForHydration } from "./support";

async function readProjectFolder(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const subdirectory of ["", "experiments", "traces"]) {
    for (const entry of await readdir(path.join(directory, subdirectory), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relative = subdirectory ? `${subdirectory}/${entry.name}` : entry.name;
      files[relative] = await readFile(path.join(directory, relative), "utf8");
    }
  }
  return files;
}

/**
 * The headless runner's promise is that the app opens what it wrote "as if it
 * had been started there". Well-formed files are not that promise: this runs
 * the real CLI path against the suite's buffered fixture, hands the folder it
 * produced to the real app unmodified, and reads the run back from the screen.
 */
test("the app opens an evaluation the headless CLI wrote", async ({ page }) => {
  const directory = await writeHeadlessProjectFolder(headlessProject({
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    cases: [
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
    ],
  }));
  const outcome = await startHeadlessEvaluation({
    projectDirectory: directory,
    environment: {},
    noAuth: new Set([HEADLESS_CONNECTION_ID]),
    transport: createInProcessTransport({ containerized: false }),
  }).done;
  // The precondition the browser half depends on: one pass, one strict fail.
  expect(outcome.error).toBeUndefined();
  expect(outcome.exitCode).toBe(1);

  const files = await readProjectFolder(directory);
  expect(Object.keys(files).filter((name) => name.startsWith("traces/"))).toHaveLength(2);
  await stubProjectDirectory(page, { name: "fixture.inference-lens", files });

  await page.goto("/");
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.getByText(/Inspect every model run · Headless fixture/)).toBeVisible();

  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  const grouped = page.locator(".runs-evidence-item.experiment").filter({ hasText: "Evaluation · Arithmetic" });
  await expect(grouped).toHaveCount(1);
  await expect(grouped).toContainText("1/2 cases passed");
  await expect(grouped).toContainText("completed");
  await grouped.click();

  const workspace = page.getByRole("region", { name: "Evaluation results" });
  await expect(workspace).toContainText("Arithmetic");
  await expect(workspace).toContainText("As run · 2 cases · 1 repetition");
  await expect(workspace).toContainText("1 / 2 passed");
  await expect(workspace).toContainText("States the sum");
  await expect(workspace).toContainText("Mentions rollback");
  // Every trace the CLI wrote was found and read back as evidence.
  await expect(workspace).not.toContainText("Trace absent");
  await expect(workspace).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

/**
 * 5c: the CLI runs a decision suite against the capture replay, which routes
 * every ticket to billing, and the app reads the folder back as a decision
 * evaluation whose repetitions open in Decision Compose.
 */
test("the app opens a decision evaluation the headless CLI wrote", async ({ page }) => {
  const directory = await writeHeadlessProjectFolder(headlessDecisionProject({
    endpoint: `${SYSTEM_ONE_FIXTURE_ORIGIN}/llamacpp/v1`,
    model: "all-types",
    questions: CAPTURED_QUESTIONS,
    expectBug: true,
  }));
  const outcome = await startHeadlessEvaluation({
    projectDirectory: directory,
    environment: {},
    noAuth: new Set([HEADLESS_CONNECTION_ID]),
    transport: createInProcessTransport({ containerized: false }),
  }).done;
  // The precondition the browser half depends on: billing passes, bug fails.
  expect(outcome.error).toBeUndefined();
  expect(outcome.exitCode).toBe(1);
  expect(outcome.summary?.runKind).toBe("decision");

  const files = await readProjectFolder(directory);
  expect(Object.keys(files).filter((name) => name.startsWith("traces/"))).toHaveLength(2);
  await stubProjectDirectory(page, { name: "fixture.inference-lens", files });

  await page.goto("/");
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.getByText(/Inspect every model run · Headless decisions/)).toBeVisible();

  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  const grouped = page.locator(".runs-evidence-item.experiment").filter({ hasText: "Triage" });
  await expect(grouped).toHaveCount(1);
  await expect(grouped).toContainText("1/2 cases passed");
  await expect(grouped).toContainText("completed");
  await grouped.click();

  const workspace = page.getByRole("region", { name: "Evaluation results" });
  await expect(workspace).toContainText("Triage");
  await expect(workspace).toContainText("1 / 2 passed");
  await expect(workspace).toContainText("intent: billing");
  await expect(workspace).not.toContainText("Trace absent");
  await expect(workspace).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  const crash = workspace.locator("details.evaluation-case-result", { hasText: "Routes a crash" });
  await crash.locator("summary").click();
  await expect(crash).toContainText("check failed");
  await crash.getByRole("button", { name: "Open Response & Inspect" }).click();
  await expect(page.getByRole("article", { name: "Answer intent" })).toContainText("Choice billing");
});

/**
 * `repeat` writes a repeated-request plan the app has always written itself;
 * this checks the CLI's copy is grouped and read back the same way, with
 * every trace found.
 */
test("the app opens a repeated run the headless CLI wrote", async ({ page }) => {
  const directory = await writeHeadlessProjectFolder(headlessProject({ endpoint: BUFFERED_FIXTURE_ENDPOINT }));
  const outcome = await startHeadlessRepeat({
    projectDirectory: directory,
    environment: {},
    noAuth: new Set([HEADLESS_CONNECTION_ID]),
    transport: createInProcessTransport({ containerized: false }),
    repetitions: 3,
  }).done;
  expect(outcome.error).toBeUndefined();
  expect(outcome.exitCode).toBe(0);

  const files = await readProjectFolder(directory);
  expect(Object.keys(files).filter((name) => name.startsWith("traces/"))).toHaveLength(3);
  await stubProjectDirectory(page, { name: "fixture.inference-lens", files });

  await page.goto("/");
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.getByText(/Inspect every model run · Headless fixture/)).toBeVisible();

  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  const grouped = page.locator(".runs-evidence-item.experiment").filter({ hasText: "Repeated experiment · buffered-test-model" });
  await expect(grouped).toHaveCount(1);
  await expect(grouped).toContainText("3 repetitions · 3 completed");
  await grouped.click();

  const workspace = page.getByRole("region", { name: "Repeated experiment results" });
  await expect(workspace).toContainText("3 completed");
  await expect(workspace).not.toContainText(/missing trace/i);
  await expect(workspace).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

/**
 * A trace in which the CLI ran a granted command is the one kind of evidence
 * the app could not have written the same way before slice 3. The case passes
 * only if the command's text came back through the provider's second turn,
 * and the transcript is read from the screen, not from the file.
 */
test("the app opens an evaluation in which the headless CLI ran a granted command tool", async ({ page }) => {
  const provider = await toolCallingProvider({ name: "get_weather", arguments: { city: "Lisbon" } });
  try {
    const tool: ToolDefinition = {
      id: "tool_weather" as ToolDefinition["id"],
      name: "get_weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    };
    const directory = await writeHeadlessProjectFolder(
      headlessToolProject(provider.endpoint, tool, "61F and drizzle in Lisbon"),
    );
    const outcome = await startHeadlessEvaluation({
      projectDirectory: directory,
      environment: {
        PATH: process.env.PATH ?? "",
        INFERENCE_LENS_COMMAND_TOOLS: path.resolve("tests/fixtures/command-tools/catalog.json"),
      },
      noAuth: new Set([HEADLESS_CONNECTION_ID]),
      toolGrants: [{ toolName: "get_weather", target: { kind: "command", commandId: "weather" } }],
      transport: createInProcessTransport({ containerized: false }),
    }).done;
    expect(outcome.error).toBeUndefined();
    expect(outcome.exitCode).toBe(0);
    expect(provider.requests).toHaveLength(2);

    await stubProjectDirectory(page, { name: "fixture.inference-lens", files: await readProjectFolder(directory) });
    await page.goto("/");
    await page.getByLabel("Project menu").click();
    await page.getByRole("button", { name: "Open project folder…" }).click();
    await expect(page.getByText(/Inspect every model run · Headless fixture/)).toBeVisible();

    await page.getByLabel("Run data menu").click();
    await page.getByRole("button", { name: "Run history", exact: true }).click();
    const grouped = page.locator(".runs-evidence-item.experiment").filter({ hasText: "Evaluation · Arithmetic" });
    await expect(grouped).toContainText("1/1 case passed");
    await grouped.click();

    const workspace = page.getByRole("region", { name: "Evaluation results" });
    await expect(workspace).toContainText("1 / 1 passed");
    await expect(workspace).not.toContainText("Trace absent");
    await workspace.getByRole("button", { name: "Open Response & Inspect" }).first().click();
    const transcript = page.getByLabel("Run transcript");
    await expect(transcript).toContainText("61F and drizzle in Lisbon, measured by get_weather");
    await expect(transcript).toContainText(/Returned by command tool “Local weather script” in \d+ ms\./);
    await expect(transcript).not.toContainText(/Supplied from a project mock|NaN|undefined|\[object Object\]/);
  } finally {
    await provider.close();
  }
});

// Expected values are authored independently of the production parser/evaluator.
// The fixture selects an answer by model ID, so every case must reach the wire.
const structuredCases = JSON.parse(await readFile(
  new URL("../fixtures/structured-output/provider-cases.json", import.meta.url), "utf8",
)) as Array<{ id: string; answer: string; json: boolean[]; schema: boolean[] }>;

for (const scenario of structuredCases) {
  test(`structured CLI evidence agrees with browser results: ${scenario.id}`, async ({ page }) => {
    const policies = ["strict", "surrounding-fence", "first-json-fence"] as const;
    const checks: CheckDefinition[] = policies.flatMap<CheckDefinition>((inputPolicy, index) => [
      { checkId: `check_json_${index}`, label: `JSON ${inputPolicy}`, kind: "valid-json" as const, inputPolicy },
      {
        checkId: `check_schema_${index}`, label: `Schema ${inputPolicy}`,
        kind: "json-schema" as const, dialect: "draft-07" as const, inputPolicy,
        schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } }, additionalProperties: false },
      },
    ]);
    const expected = policies.flatMap((_, index) => [scenario.json[index], scenario.schema[index]]);
    const directory = await writeHeadlessProjectFolder(headlessProject({
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: `structured-policy-${scenario.id}`,
      cases: [{ id: "evaluation-case_policy", name: "Policy matrix", topic: scenario.id, checks }],
    }));
    const outcome = await startHeadlessEvaluation({
      projectDirectory: directory, environment: {}, noAuth: new Set([HEADLESS_CONNECTION_ID]),
      transport: createInProcessTransport({ containerized: false }),
    }).done;
    expect(outcome.error).toBeUndefined();
    const passed = expected.filter(Boolean).length;
    expect(outcome.exitCode).toBe(passed === checks.length ? 0 : 1);
    expect(outcome.summary?.configurations[0].cases[0].checks).toEqual({
      total: 6, passed, failed: 6 - passed, notEvaluated: 0,
    });
    const files = await readProjectFolder(directory);
    const traces = Object.entries(files).filter(([name]) => name.startsWith("traces/"));
    expect(traces).toHaveLength(1);
    // A successful transport carrying the wrong fixture answer must fail too.
    expect(finalAssistantOutput(runStateFromTrace(parseRunTraceJson(traces[0][1])))).toBe(scenario.answer);
    await stubProjectDirectory(page, { name: "structured.inference-lens", files });
    await seedProfile(page);
    await page.goto("/");
    await waitForHydration(page);
    await page.getByLabel("Project menu").click();
    await page.getByRole("button", { name: "Open project folder…" }).click();
    await expect(page.getByText(/Inspect every model run · Headless fixture/)).toBeVisible();
    await page.getByLabel("Run data menu").click();
    await page.getByRole("button", { name: "Run history", exact: true }).click();
    await page.locator(".runs-evidence-item.experiment").filter({ hasText: "Evaluation · Arithmetic" }).click();
    const workspace = page.getByRole("region", { name: "Evaluation results" });
    const rows = workspace.locator(".evaluation-check-results > li");
    await expect(rows).toHaveCount(checks.length);
    for (let index = 0; index < checks.length; index += 1) {
      await expect(rows.nth(index).locator("strong")).toHaveText(checks[index].label!);
      await expect(rows.nth(index)).toHaveClass(expected[index] ? "passed" : "failed");
      const verdict = rows.nth(index).locator(":scope > div > span");
      if (expected[index]) {
        await expect(verdict).toHaveText("Passed");
      } else if (checks[index].kind === "valid-json") {
        await expect(verdict).toHaveText("Final assistant output is not valid JSON.");
      } else if (!scenario.json[Math.floor(index / 2)]) {
        await expect(verdict).toHaveText(`Final assistant output is not valid JSON under the ${policies[Math.floor(index / 2)]} input policy.`);
      } else {
        await expect(verdict).toHaveText(/^Schema mismatch at .+\.$/);
      }
    }
    if (scenario.id === "schema-mismatch") {
      const schemaRow = rows.nth(1);
      await expect(schemaRow.locator(":scope > div > span"))
        .toHaveText('Schema mismatch at ["answer"]: expected number.');
      const diagnostics = schemaRow.getByRole("group", { name: "Structured check diagnostics" });
      await diagnostics.getByText("Structured check diagnostics", { exact: true }).click();
      await expect(diagnostics.getByText("Diagnostic code: schema-mismatch", { exact: true })).toBeVisible();
      await expect(diagnostics.getByText("Issues listed: 1", { exact: true })).toBeVisible();
      await expect(diagnostics.getByRole("listitem"))
        .toHaveText('Schema mismatch at ["answer"]: expected number.');
      await expect(diagnostics.getByRole("listitem")).toBeVisible();
    }
    await expect(workspace).not.toContainText("Trace absent");
    await expect(workspace).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
  });
}
