import { expect, test } from "@playwright/test";

import {
  createProjectFile,
  serializeProjectFile,
} from "../../packages/core/src/project";
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
  await expect(page.getByRole("heading", { name: "Current request result" })).toBeVisible();
  await page.getByRole("button", { name: "View current response", exact: true }).click();

  await expect(
    page.getByRole("navigation", { name: "Application mode" })
      .getByRole("button", { name: "Compose" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");
});

test("Runs opens the saved history of a folder-backed project", async ({ page }) => {
  const fixture = await seedMappedProject(page);
  await stubProjectDirectory(page, {
    name: "run-discovery.inference-lens",
    files: { "project.json": serializeProjectFile(fixture) },
    directories: ["traces", "experiments"],
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Run discovery fixture");

  await openMode(page, "Runs");
  await page.getByRole("button", { name: "Open saved run history", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
  await expect(page.getByText("No saved evidence yet", { exact: true })).toBeVisible();
});
