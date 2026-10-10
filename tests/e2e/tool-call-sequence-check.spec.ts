import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createProjectFile, parseProjectFile, serializeProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { createEntityId } from "../../packages/core/src/run-kernel";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  expandedPreflight,
  openMode,
  primaryAction,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

/**
 * An ordered tool-call check, authored in the suite editor and scored against
 * a real run.
 *
 * The fixture's `tool-sequence-model` calls `get_weather` alone, then
 * `get_alerts` and `get_weather` together, then answers. So "weather, then
 * alerts" holds, and "alerts, then weather" fails only because the second
 * weather call shares the alerts call's turn — the one thing that separates
 * turn order from emission order. Both checks are authored through the UI, so
 * a pass also proves the editor wrote the steps the engine read.
 */
const MODEL = "tool-sequence-model";
const PROFILE_INSTANCE_ID = "profile-instance-tool-sequence";
const WEATHER = createEntityId("tool", "sequence-weather");
const ALERTS = createEntityId("tool", "sequence-alerts");

function fixtureProject(): ProjectFile {
  const initial = createProjectFile({
    name: "Tool sequence fixture",
    idSuffix: "tool-sequence",
    createdAt: "2026-10-10T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: MODEL,
      messages: [{ role: "user", content: "Any weather alerts in Chicago?" }],
    },
  });
  const tool = (id: typeof WEATHER, name: string) => ({
    id,
    name,
    description: `Fixture ${name}.`,
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  });
  const mock = (toolId: typeof WEATHER, suffix: string) => ({
    id: createEntityId("tool-mock", suffix),
    toolId,
    name: suffix,
    enabled: true,
    match: { kind: "always" },
    result: { content: [{ type: "text", text: `${suffix} result` }] },
  });
  return parseProjectFile({
    ...initial,
    tools: [tool(WEATHER, "get_weather"), tool(ALERTS, "get_alerts")],
    toolMocks: [mock(WEATHER, "weather"), mock(ALERTS, "alerts")],
    evaluationSuites: [{
      id: "evaluation-suite_sequence",
      name: "Sequence",
      input: { kind: "conversation-revision", conversationRevisionId: initial.defaults.conversationRevisionId },
      execution: {
        target: { ...initial.defaults.target, model: MODEL },
        responseMode: "buffered",
        options: {},
        repetitions: 1,
        toolIds: [WEATHER, ALERTS],
      },
      inputBindings: [],
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
      cases: [{ id: "evaluation-case_chicago", name: "Chicago", values: {}, checks: [] }],
    }],
  });
}

async function openEvaluations(page: Page, project: ProjectFile): Promise<void> {
  await seedProfile(page, {
    model: MODEL,
    favoriteModels: [MODEL],
    capabilityOverrides: { tools: true },
    instanceId: PROFILE_INSTANCE_ID,
  });
  await page.addInitScript(({ mapKey, projectId, instanceId }) => {
    localStorage.setItem(mapKey, JSON.stringify({ [projectId]: { profileId: "buffered", profileInstanceId: instanceId } }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId, instanceId: PROFILE_INSTANCE_ID });
  await stubProjectDirectory(page, {
    name: "tool-sequence-fixture",
    files: { "project.json": serializeProjectFile(project) },
    directories: ["traces", "experiments"],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Tool sequence fixture");
  await page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>("details.project-menu").forEach((menu) => { menu.open = false; }));
  await openMode(page, "Evaluations");
}

/** Adds a sequence check and fills its steps, committing each field on blur. */
async function addSequence(
  page: Page,
  label: string,
  steps: ReadonlyArray<{ toolName: string; arguments?: string }>,
): Promise<void> {
  const editor = page.locator(".evaluation-editor");
  await page.getByLabel("New check kind").selectOption({ label: "Tool call sequence" });
  await page.getByRole("button", { name: "+ Add check" }).click();
  const card = editor.locator(".evaluation-check-card").last();
  await card.getByLabel("Label").fill(label);
  await card.getByLabel("Label").blur();
  // A new sequence starts with two empty steps; preflight holds the run until
  // every step names a tool.
  await expect(card.getByRole("group", { name: /^Step \d\b/ })).toHaveCount(2);
  // Each later step says what "after" means, in its accessible name too.
  await expect(card.getByRole("group", { name: "Step 2 in a later turn than step 1" })).toBeVisible();
  await expect(await expandedPreflight(page)).toContainText("needs a tool name for every step");
  for (const [index, step] of steps.entries()) {
    if (index >= 2) await card.getByRole("button", { name: "+ Add step" }).click();
    const group = card.getByRole("group", { name: new RegExp(`^Step ${index + 1}\\b`) });
    await group.getByLabel("Tool name").fill(step.toolName);
    await group.getByLabel("Tool name").blur();
    if (step.arguments !== undefined) {
      await group.getByLabel("Expected arguments (JSON subset, optional)").fill(step.arguments);
      await group.getByLabel("Expected arguments (JSON subset, optional)").blur();
    }
  }
}

test("a tool-call sequence is authored in the editor and scored by turn order", async ({ page }) => {
  await openEvaluations(page, fixtureProject());

  await addSequence(page, "Weather before alerts", [
    { toolName: "get_weather", arguments: '{"city": "Chicago"}' },
    { toolName: "get_alerts" },
  ]);
  await addSequence(page, "Alerts before weather", [
    { toolName: "get_alerts" },
    { toolName: "get_weather" },
  ]);
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("Ready to run");

  await primaryAction(page, "evaluations").click();
  await page.getByRole("dialog", { name: /Start “Sequence”/ })
    .getByRole("button", { name: "Start 1 repetition" }).click();

  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("0 / 1 passed", { timeout: 20_000 });
  const checks = results.locator(".evaluation-check-results li");
  await expect(checks.filter({ hasText: "Weather before alerts" })).toHaveClass(/passed/);
  const failed = checks.filter({ hasText: "Alerts before weather" });
  await expect(failed).toHaveClass(/failed/);
  await expect(failed).toContainText('Step 2 (tool "get_weather") was called, but not in a turn after step 1.');
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  // The steps the editor wrote are what the project saved. Autosave is
  // debounced, so wait for the write rather than reading once.
  const savedChecks = () => page.evaluate(async () => {
    const root = await (window as unknown as { showDirectoryPicker(): Promise<{ getFileHandle(name: string): Promise<{ getFile(): Promise<File> }> }> }).showDirectoryPicker();
    const saved = JSON.parse(await (await (await root.getFileHandle("project.json")).getFile()).text());
    return {
      schemaVersion: saved.schemaVersion,
      checks: saved.evaluationSuites[0].cases[0].checks.map(({ label, steps }: { label: string; steps: unknown }) => ({ label, steps })),
    };
  });
  await expect.poll(savedChecks, { timeout: 10_000 }).toEqual({
    schemaVersion: 12,
    checks: [
      { label: "Weather before alerts", steps: [{ toolName: "get_weather", argumentsSubset: { city: "Chicago" } }, { toolName: "get_alerts" }] },
      { label: "Alerts before weather", steps: [{ toolName: "get_alerts" }, { toolName: "get_weather" }] },
    ],
  });
});
