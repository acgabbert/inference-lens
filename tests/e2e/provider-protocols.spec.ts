import { expect, test } from "@playwright/test";

import { createProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROFILE_STORAGE_KEY,
  PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
  importProject,
  openInferenceSettings,
  seedProfiles,
} from "./support";

/**
 * A project states the protocol its runs use; a profile states which ones its
 * endpoint speaks. These specs drive the join between the two through the UI.
 */
test("a project's protocol blocks a profile that lacks it until the profile enables it", async ({ page }) => {
  const project = createProjectFile({
    name: "Responses project",
    request: {
      provider: "openai-compatible",
      protocol: "openai-responses",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "responses-protocol",
    createdAt: "2026-10-08T12:00:00.000Z",
  });
  const requirementId = project.defaults.target.connectionRequirementId;
  await seedProfiles(page, [{
    id: "buffered",
    instanceId: "profile-instance-buffered",
    name: "Chat only fixture",
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
  }], "buffered");
  await page.addInitScript(({ mapKey, projectId, requirementId }) => {
    localStorage.setItem(mapKey, JSON.stringify({
      [projectId]: {
        [requirementId]: {
          profileId: "buffered",
          profileInstanceId: "profile-instance-buffered",
        },
      },
    }));
  }, {
    mapKey: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
    projectId: project.projectId,
    requirementId,
  });

  await page.goto("/");
  await expect(page.locator(".topbar")).toContainText("Chat only fixture");
  await importProject(page, project, "Responses project");

  const run = page.getByRole("button", { name: /run current conversation/i });
  await expect(run).toBeDisabled();
  await expect(page.getByText('"Chat only fixture" does not have Responses enabled').first()).toBeVisible();

  // The settings say the same thing in their own place: the project's choice
  // stays selected and marked rather than being silently replaced.
  const settings = await openInferenceSettings(page);
  const protocol = settings.getByLabel("Protocol");
  await expect(protocol).toHaveValue("openai-responses");
  await expect(protocol.locator("option:checked")).toHaveText("Responses (not enabled)");

  await page.getByRole("button", { name: "Enable Responses" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Connections" });
  const responsesSwitch = drawer.getByRole("checkbox", { name: /^Responses/ });
  await expect(responsesSwitch).toBeFocused();
  await responsesSwitch.check();
  await drawer.getByRole("button", { name: /close/i }).first().click();

  await expect(page.getByText('"Chat only fixture" does not have Responses enabled')).toHaveCount(0);
  await expect(protocol.locator("option:checked")).toHaveText("Responses");
  await expect(run).toBeEnabled();
});

test("without a project, the protocol picked in Run settings is the profile's own", async ({ page }) => {
  await seedProfiles(page, [{
    id: "buffered",
    instanceId: "profile-instance-buffered",
    name: "Two protocol fixture",
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    capabilityOverrides: { responsesApi: true },
  }], "buffered");
  await page.goto("/");
  await expect(page.locator(".topbar")).toContainText("Two protocol fixture");

  const settings = await openInferenceSettings(page);
  const protocol = settings.getByLabel("Protocol");
  await expect(protocol.locator("option")).toHaveText(["Chat Completions", "Responses"]);
  await protocol.selectOption("openai-responses");
  await expect(settings.locator(".inference-settings-fact").first()).toHaveText("Responses");

  // Stored on the profile, not in session state. A reload cannot show this
  // here: `seedProfiles` is an init script and would re-seed the profile.
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), PROFILE_STORAGE_KEY);
  expect(stored.profiles[0].protocol).toBe("openai-responses");
});
