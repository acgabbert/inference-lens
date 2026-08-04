import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createProjectFile,
  serializeProjectFile,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { createEntityId } from "../../packages/core/src/run-kernel";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

/**
 * A batch that answers its own tool calls.
 *
 * The fixture's tool-calling model echoes the tool message into its final
 * answer, so the mock's text appearing in a repetition's output preview proves
 * the executor ran inside the batch and its value reached the second provider
 * call — not merely that a run finished.
 */
const mockText = "72°F and clear";
const PROFILE_INSTANCE_ID = "profile-instance-batch-tools";

function toolFixtureProject(model: string, idSuffix: string): ProjectFile {
  const project = createProjectFile({
    name: "Batch tool fixture",
    idSuffix,
    createdAt: "2026-08-04T11:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model,
      messages: [{ role: "user", content: "What is the weather in Chicago?" }],
    },
  });
  const toolId = createEntityId("tool", `${idSuffix}-weather`);
  return {
    ...project,
    tools: [
      {
        id: toolId,
        name: "get_weather",
        description: "Look up current weather.",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    toolMocks: [
      {
        id: createEntityId("tool-mock", `${idSuffix}-sunny`),
        toolId,
        name: "sunny default",
        enabled: true,
        match: { kind: "always" },
        result: { content: [{ type: "text", text: mockText }] },
      },
    ],
    defaults: { ...project.defaults, enabledToolIds: [toolId] },
  };
}

/** Opens the fixture with its connection mapped and tool calling allowed. */
async function openFixtureProject(
  page: Page,
  model: string,
  idSuffix: string,
): Promise<void> {
  const project = toolFixtureProject(model, idSuffix);
  await seedProfile(page, {
    model,
    favoriteModels: [model],
    capabilityOverrides: { tools: true },
    instanceId: PROFILE_INSTANCE_ID,
  });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(
        mapKey,
        JSON.stringify({
          [projectId]: { profileId: "buffered", profileInstanceId: instanceId },
        }),
      );
    },
    {
      mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY,
      projectId: project.projectId,
      instanceId: PROFILE_INSTANCE_ID,
    },
  );
  await stubProjectDirectory(page, {
    name: `${idSuffix}-fixture`,
    files: { "project.json": serializeProjectFile(project) },
    directories: ["traces", "experiments"],
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.locator(".brand")).toContainText("Batch tool fixture");
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>("details.project-menu")
      .forEach((menu) => {
        menu.open = false;
      });
  });
}

test("a batch serves its own tool calls, and says what will run before it starts", async ({
  page,
}) => {
  await openFixtureProject(page, "tool-calling-model", "batch-tools");

  await page.getByRole("button", { name: "Repeat…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Run this frozen request repeatedly",
  });

  // The listing is the standing grant made visible at the moment cost is
  // confirmed. Nothing else in the batch flow asks again.
  await expect(dialog).toContainText("Tools served automatically");
  await expect(dialog).toContainText("get_weather");
  await expect(dialog).toContainText('mock "sunny default"');
  // Two repetitions, ceiling 5: the old copy would have claimed 2 calls exactly.
  await dialog.getByLabel("Repetitions").fill("2");
  await expect(dialog).toContainText("Provider calls: 2–10");

  await dialog.getByRole("button", { name: "Start 2 repetitions" }).click();

  const workspace = page.getByRole("region", {
    name: "Repeated experiment results",
  });
  await expect(page.getByRole("progressbar", { name: "Experiment progress" }))
    .toHaveCount(0, { timeout: 20_000 });
  await expect(workspace).toContainText("2 completed");

  // The mock's text came back through the provider's second turn, which can
  // only happen if the batch executed the tool and continued the run itself.
  const rows = workspace.locator(".repeated-experiment-row");
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row).toContainText(`Chicago report: ${mockText}`);
    await expect(row).toContainText("2 turns");
    await expect(row).toContainText("1 tool call");
  }

  const summary = await workspace
    .getByLabel("Repeated experiment summary")
    .innerText();
  expect(summary).not.toMatch(/NaN|Infinity|undefined/);
});

test("a repetition that keeps calling tools stops at the turn ceiling", async ({
  page,
}) => {
  await openFixtureProject(page, "looping-tool-model", "batch-ceiling");

  await page.getByRole("button", { name: "Repeat…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Run this frozen request repeatedly",
  });
  await dialog.getByLabel("Repetitions").fill("2");
  await dialog.getByLabel("Max turns per repetition").fill("2");
  await expect(dialog).toContainText("Provider calls: 2–4");
  await dialog.getByRole("button", { name: "Start 2 repetitions" }).click();

  const workspace = page.getByRole("region", {
    name: "Repeated experiment results",
  });
  await expect(page.getByRole("progressbar", { name: "Experiment progress" }))
    .toHaveCount(0, { timeout: 20_000 });

  // The model would call forever; the ceiling is the only thing that stopped
  // it, and it stopped both repetitions rather than the batch.
  await expect(workspace).toContainText("2 failed");
  const rows = workspace.locator(".repeated-experiment-row");
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row).toContainText("2 turns");
    await expect(row).toContainText("2 tool calls");
  }

  const summary = await workspace
    .getByLabel("Repeated experiment summary")
    .innerText();
  expect(summary).not.toMatch(/NaN|Infinity|undefined/);
});
