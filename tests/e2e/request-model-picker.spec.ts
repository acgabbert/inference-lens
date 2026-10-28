import { expect, test } from "@playwright/test";

import { createProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openInferenceSettings,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  seedProfile,
  waitForHydration,
} from "./support";

/** The buffered fixture answers this model with the temperature it was sent. */
const ECHO_TEMPERATURE_MODEL = "echo-temperature-model";

test("the model changes from the composer without opening run settings", async ({
  page,
}) => {
  await seedProfile(page, { temperature: 0.3 });
  await page.goto("/");
  await waitForHydration(page);

  const composer = page.getByRole("region", { name: "Request composer" });
  const toggle = composer.locator(".inference-settings-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // The combobox names itself after its value once filled, so match the prefix.
  const model = composer.getByRole("combobox", { name: /^Model/ });
  await expect(model).toHaveCount(1);
  await model.fill(ECHO_TEMPERATURE_MODEL);
  await model.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // The unchanged temperature is what proves only the model moved.
  await page.getByRole("button", { name: /run current conversation/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Provider received temperature 0.3.",
  );

  // Opening settings afterwards offers no second model field.
  await openInferenceSettings(page);
  await expect(composer.getByRole("combobox", { name: /^Model/ })).toHaveCount(1);
  await expect(composer.getByRole("combobox", { name: /^Model/ })).toHaveValue(
    ECHO_TEMPERATURE_MODEL,
  );
});

test("the closed summary keeps protocol and shows only values that differ from the parent", async ({
  page,
}) => {
  const profileInstanceId = "profile-instance-model-picker";
  const project = createProjectFile({
    name: "Model picker project",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "provider-default-temperature-model",
      messages: [{ role: "user", content: "Summarise the settings." }],
    },
    idSuffix: "model-picker",
    createdAt: "2026-10-28T12:00:00.000Z",
  });
  await seedProfile(page, {
    model: "provider-default-temperature-model",
    name: "Model picker fixture",
    instanceId: profileInstanceId,
    temperature: 0.7,
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
      instanceId: profileInstanceId,
    },
  );
  await page.goto("/");
  await waitForHydration(page, "Model picker fixture");
  await importProject(page, project, "Model picker project");

  // The model field carries the model, so the summary does not repeat it. The
  // project clears the profile's 0.7 temperature, the one difference from its
  // parent; delivery matches the profile and stays out.
  await expect(page.locator(".inference-settings-fact")).toHaveText([
    "Chat Completions",
    "Provider default temp",
    "1 override",
  ]);
});
