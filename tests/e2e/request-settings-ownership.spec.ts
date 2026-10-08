import { expect, test } from "@playwright/test";

import { createProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openInferenceSettings,
  PROFILE_STORAGE_KEY,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  seedProfile,
  STREAMING_STORAGE_KEY,
  waitForHydration,
} from "./support";

/** The buffered fixture answers this model with the temperature it was sent. */
const ECHO_TEMPERATURE_MODEL = "echo-temperature-model";

function storedProfile(page: import("@playwright/test").Page) {
  return page.evaluate((key) => {
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as {
      profiles?: { id: string; model: string; temperature?: number }[];
    };
    return stored.profiles?.find(({ id }) => id === "buffered");
  }, PROFILE_STORAGE_KEY);
}

function echoProject(suffix: string) {
  return createProjectFile({
    name: "Request settings fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "project-model",
      temperature: 0.8,
      messages: [{ role: "user", content: "Report the temperature." }],
    },
    idSuffix: suffix,
    createdAt: "2026-10-08T12:00:00.000Z",
  });
}

test("without a project, editing the model and temperature edits the active profile", async ({
  page,
}) => {
  await seedProfile(page, { temperature: 0.3 });
  await page.goto("/");
  await waitForHydration(page);

  const panel = await openInferenceSettings(page);
  // The combobox names itself after its value once filled, so match the prefix.
  const model = panel.getByRole("combobox", { name: /^Model/ });
  await model.fill(ECHO_TEMPERATURE_MODEL);
  await model.press("Escape");
  await panel.getByRole("slider", { name: "Temperature" }).fill("1.2");
  await expect(panel.locator(".temperature-control output")).toHaveText("1.2");

  // No project means no session layer: the profile itself is what changed.
  await expect.poll(() => storedProfile(page)).toMatchObject({
    model: ECHO_TEMPERATURE_MODEL,
    temperature: 1.2,
  });

  await page.getByRole("button", { name: /run current conversation/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Provider received temperature 1.2.",
  );
});

test("in a project, editing settings marks it unsaved, leaves the profile alone, and a re-import restores them", async ({
  page,
}) => {
  const project = echoProject("request-settings-session");
  const instanceId = "profile-instance-request-settings";
  await seedProfile(page, { model: "profile-model", temperature: 0.3, instanceId });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(mapKey, JSON.stringify({
        [projectId]: { profileId: "buffered", profileInstanceId: instanceId },
      }));
    },
    { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId, instanceId },
  );
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Request settings fixture");

  const panel = await openInferenceSettings(page);
  // The combobox names itself after its value once filled, so match the prefix.
  const model = panel.getByRole("combobox", { name: /^Model/ });
  await expect(model).toHaveValue("project-model");
  await expect(panel.locator(".temperature-control output")).toHaveText("0.8");

  await model.fill(ECHO_TEMPERATURE_MODEL);
  await model.press("Escape");
  await panel.getByRole("slider", { name: "Temperature" }).fill("1.3");
  await expect(page.locator(".brand")).toContainText("Unsaved");

  await page.getByRole("button", { name: /run current conversation/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Provider received temperature 1.3.",
  );
  // The project's session values never reach the profile.
  expect(await storedProfile(page)).toMatchObject({
    model: "profile-model",
    temperature: 0.3,
  });

  // Applying a project draft replaces the session values with the project's.
  await importProject(page, project, "Request settings fixture", {
    replaceDirty: "discard",
  });
  await openInferenceSettings(page);
  await expect(model).toHaveValue("project-model");
  await expect(panel.locator(".temperature-control output")).toHaveText("0.8");
  await expect(page.locator(".brand")).not.toContainText("Unsaved");
});

test("the streaming choice is written to the preference key", async ({ page }) => {
  await seedProfile(page, { streaming: "stream" });
  await page.goto("/");
  await waitForHydration(page);

  const panel = await openInferenceSettings(page);
  const streaming = panel.getByLabel("Stream response");
  await expect(streaming).toBeChecked();
  // Reading "buffered" back is covered by every spec that seeds it; this is
  // the write, in the exact values that read expects.
  await streaming.uncheck();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STREAMING_STORAGE_KEY))
    .toBe("buffered");
  await streaming.check();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STREAMING_STORAGE_KEY))
    .toBe("streaming");
});
