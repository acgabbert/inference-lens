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

/** A folder-backed project holding one saved ordinary run. */
async function openFolderWithSavedRun(page: import("@playwright/test").Page) {
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

  return fixture;
}

test("Runs inspects saved evidence without replacing the Compose draft", async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 720 });
  await openFolderWithSavedRun(page);
  await openMode(page, "Runs");
  const list = page.getByRole("navigation", { name: "Run evidence" });
  // Recognised by what was asked, then by where it ran and how it ended.
  const row = list.getByRole("button", { name: /Saved evidence request/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("saved-history-model");
  await expect(row).toContainText("Chat Completions");
  await expect(row).toContainText("completed");
  await expect(row).toContainText("Saved to folder");
  await row.click();
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

test("an unsaved current run says the next run replaces it", async ({ page }) => {
  const fixture = await seedMappedProject(page);
  await page.goto("/");
  await waitForHydration(page);
  // An imported project has no folder, so nothing it runs is written anywhere.
  await importProject(page, fixture, "Run discovery fixture");
  await page.getByRole("button", { name: /run current conversation/i }).click();
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");

  await openMode(page, "Runs");
  const row = page.getByRole("navigation", { name: "Run evidence" })
    .getByRole("button", { name: /Make this result easy to find\./ });
  await expect(row).toContainText("buffered-test-model");
  await expect(row).toContainText("Chat Completions");
  await expect(row).toContainText("completed");
  await expect(row).toContainText("Not saved · replaced by the next run");
  await expect(row).not.toContainText("Saved to folder");
  await expect(page.getByRole("region", { name: "Selected run evidence" }))
    .toContainText("Buffered fixture response");
});

test("Run history opens the Runs workspace rather than a drawer", async ({ page }) => {
  await openFolderWithSavedRun(page);

  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Application mode" })
      .getByRole("button", { name: "Runs" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Run evidence" })
    .getByRole("button", { name: /Saved evidence request/ })).toBeVisible();
});

test("a batch started while saved evidence is selected takes over the main area", async ({ page }) => {
  await openFolderWithSavedRun(page);
  await openMode(page, "Runs");
  const list = page.getByRole("navigation", { name: "Run evidence" });
  await list.getByRole("button", { name: /Saved evidence request/ }).click();
  await expect(page.getByRole("region", { name: "Selected run evidence" }))
    .toContainText("Saved evidence response");

  await openMode(page, "Compose");
  await page.getByRole("button", { name: "Repeat…" }).click();
  const dialog = page.getByRole("dialog", { name: "Run this frozen request repeatedly" });
  await dialog.getByLabel("Repetitions").fill("2");
  await dialog.getByRole("button", { name: "Start 2 repetitions" }).click();

  const results = page.getByRole("region", { name: "Repeated experiment results" });
  await expect(results).toContainText("2 completed");
  await expect(page.getByRole("region", { name: "Selected run evidence" })).toHaveCount(0);
  await expect(list.locator("[aria-current=true]")).toContainText("Repeated experiment · buffered-test-model");
  // The saved run is still one click away, and choosing it is what replaces the batch.
  await list.getByRole("button", { name: /Saved evidence request/ }).click();
  await expect(page.getByRole("region", { name: "Selected run evidence" }))
    .toContainText("Saved evidence response");
});

test("a batch member reads beside a breadcrumb back to its batch", async ({ page }) => {
  await seedMappedProject(page);
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Message 1 content").fill("Repeat this request");
  await page.getByRole("button", { name: "Repeat…" }).click();
  const dialog = page.getByRole("dialog", { name: "Run this frozen request repeatedly" });
  await dialog.getByLabel("Repetitions").fill("2");
  await dialog.getByRole("button", { name: "Start 2 repetitions" }).click();
  const results = page.getByRole("region", { name: "Repeated experiment results" });
  await expect(results).toContainText("2 completed");

  await results.getByRole("button", { name: "Open Response & Inspect" }).nth(1).click();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs).toHaveText(/Runs\s*\/\s*Repeated experiment · buffered-test-model\s*\/\s*Repetition 2/);
  await expect(crumbs.getByText("Repetition 2")).toHaveAttribute("aria-current", "page");
  const member = page.getByRole("region", { name: "Selected run" });
  await expect(member).toContainText("Buffered fixture response");
  await expect(member.getByRole("button", { name: "Branch from this run" })).toBeVisible();

  await crumbs.getByRole("button", { name: "Repeated experiment · buffered-test-model" }).click();
  await expect(page.getByRole("region", { name: "Selected run" })).toHaveCount(0);
  await expect(results).toContainText("2 completed");
});
