import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { startHeadlessEvaluation } from "../../packages/cli/src/evaluation-run";
import { createInProcessTransport } from "../../packages/cli/src/transport";
import type { ToolDefinition } from "../../packages/core/src/run-kernel/types";
import {
  HEADLESS_CONNECTION_ID,
  headlessProject,
  headlessToolProject,
  writeHeadlessProjectFolder,
} from "../fixtures/headless/project";
import { toolCallingProvider } from "../fixtures/headless/tool-calling-provider";
import { BUFFERED_FIXTURE_ENDPOINT, stubProjectDirectory } from "./support";

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
