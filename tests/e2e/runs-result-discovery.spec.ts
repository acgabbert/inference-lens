import { expect, test } from "@playwright/test";

import {
  createProjectFile,
  serializeProjectFile,
} from "../../packages/core/src/project";
import { RunCoordinator, createRunTrace } from "../../packages/core/src/run-kernel";
import { createResolvedRunInput } from "../../packages/core/src/run-kernel/run-execution";
import { serializeRunTrace } from "../../packages/core/src/run-trace";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openMode,
  PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

function project() {
  return createProjectFile({
    name: "Run discovery fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Make this result easy to find." }],
    },
    idSuffix: "run-discovery",
    createdAt: "2026-09-21T20:00:00.000Z",
  });
}

async function seedMappedProject(page: import("@playwright/test").Page) {
  const fixture = project();
  await seedProfile(page, { instanceId: "run-discovery-profile" });
  await page.addInitScript(
    ({ key, projectId, requirementId }) => {
      localStorage.setItem(key, JSON.stringify({
        [projectId]: {
          [requirementId]: {
            profileId: "buffered",
            profileInstanceId: "run-discovery-profile",
          },
        },
      }));
    },
    {
      key: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
      projectId: fixture.projectId,
      requirementId: fixture.defaults.target.connectionRequirementId,
    },
  );
  return fixture;
}

test("Runs links back to the current ordinary request result", async ({ page }) => {
  const fixture = await seedMappedProject(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture, "Run discovery fixture");

  await page.getByRole("button", { name: /run current conversation/i }).click();
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");

  await openMode(page, "Runs");
  await expect(
    page.getByRole("navigation", { name: "Application mode" })
      .getByRole("button", { name: "Runs" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Selected run evidence" }))
    .toContainText("Buffered fixture response");
});

test("Runs inspects saved evidence without replacing the Compose draft", async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 720 });
  const fixture = await seedMappedProject(page);
  const input = createResolvedRunInput({
    provider: "openai-compatible",
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    model: "saved-history-model",
    messages: [{ role: "user", content: "Saved evidence request" }],
  }, {
    conversationId: fixture.conversations[0]!.id,
    conversationRevisionId: fixture.defaults.conversationRevisionId,
  }, [], [], "saved-history", "2026-09-21T21:00:00.000Z");
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({
    type: "text_delta",
    text: "Saved evidence response",
    source: { exchangeId: execution.exchangeId, frameIndex: 0 },
  });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop" },
    source: { exchangeId: execution.exchangeId, frameIndex: 0 },
  });
  coordinator.finishTurnStream();
  const trace = createRunTrace(coordinator.state);
  await stubProjectDirectory(page, {
    name: "run-discovery.inference-lens",
    files: {
      "project.json": serializeProjectFile(fixture),
      [`traces/${trace.runId}.json`]: serializeRunTrace(trace),
    },
    directories: ["traces", "experiments"],
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Run discovery fixture");

  await openMode(page, "Runs");
  const list = page.getByRole("navigation", { name: "Run evidence" });
  await expect(list.getByRole("button", { name: /saved-history-model/i })).toBeVisible();
  await list.getByRole("button", { name: /saved-history-model/i }).click();
  await expect(page.getByRole("region", { name: "Selected run evidence" }))
    .toContainText("Saved evidence response");
  const listBox = await list.boundingBox();
  const detailBox = await page.getByRole("region", { name: "Selected run evidence" }).boundingBox();
  expect(listBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(detailBox!.x + 1);
  expect(detailBox!.width).toBeGreaterThan(400);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("region", { name: "Selected run evidence" })
    .getByRole("button", { name: "Edit from here" })).toHaveCount(0);

  await openMode(page, "Compose");
  await expect(page.getByLabel("Message 1 content")).toHaveValue("Make this result easy to find.");
  await expect(page.locator(".response-pane")).not.toContainText("Saved evidence response");

  await openMode(page, "Runs");
  await expect(page.getByRole("region", { name: "Selected run evidence" }))
    .toContainText("Saved evidence response");
  await page.getByRole("button", { name: "Branch from this run" }).click();
  await expect(
    page.getByRole("navigation", { name: "Application mode" })
      .getByRole("button", { name: "Compose" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Message 1 content")).toHaveValue("Saved evidence request");
  await expect(page.getByLabel("Message 2 content")).toHaveValue("Saved evidence response");
});
