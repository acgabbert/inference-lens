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

test("a project can use the provider default despite a mapped profile override", async ({
  page,
}) => {
  const profileInstanceId = "profile-instance-provider-default";
  const project = createProjectFile({
    name: "Provider-default project",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "provider-default-temperature-model",
      messages: [{ role: "user", content: "Use the provider default." }],
    },
    idSuffix: "provider-default",
    createdAt: "2026-08-01T12:00:00.000Z",
  });
  await seedProfile(page, {
    model: "provider-default-temperature-model",
    name: "Provider-default fixture",
    instanceId: profileInstanceId,
    temperature: 0.7,
  });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(
        mapKey,
        JSON.stringify({
          [projectId]: {
            profileId: "buffered",
            profileInstanceId: instanceId,
          },
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
  await waitForHydration(page, "Provider-default fixture");
  await importProject(page, project, "Provider-default project");

  // Collapsed, the project-owned panel reports its model and temperature. The
  // session-owned delivery preference remains visible in the same card.
  await expect(page.locator(".inference-settings-fact")).toHaveText([
    "provider-default-temperature-model",
    "Provider default temp",
    "1 override",
  ]);
  await expect(
    page.getByRole("region", { name: "Delivery preference" }),
  ).toContainText("Buffered");
  // In its one-line state, the toggle must not retain the height intended for
  // its unavailable explanatory message; that would leave the label visibly
  // top-aligned in the delivery row.
  await expect(
    page
      .getByRole("region", { name: "Delivery preference" })
      .locator(".streaming-control"),
  ).toHaveCSS("min-height", "auto");

  const settings = await openInferenceSettings(page);
  await expect(settings.getByLabel("Model", { exact: true })).toHaveValue(
    "provider-default-temperature-model",
  );
  const override = page.getByRole("checkbox", {
    name: "Override temperature",
  });
  const slider = page.getByRole("slider", { name: "Temperature" });
  await expect(override).not.toBeChecked();
  await expect(slider).toBeDisabled();
  await expect(page.locator(".temperature-control")).toContainText(
    "Provider default",
  );

  await override.check();
  await expect(slider).toBeEnabled();
  // The profile's explicit value remains the last remembered override even
  // though the project itself correctly starts in provider-default mode.
  await expect(page.locator(".temperature-control output")).toHaveText("0.7");

  await slider.fill("1.1");
  await expect(page.locator(".temperature-control")).toContainText(
    "Experimental above 1.0",
  );

  await override.uncheck();
  await expect(slider).toBeDisabled();

  // Collapsing hides the controls, not the decision they encode: the summary
  // reports the cleared override, and the run still honours it.
  await page.locator('[aria-label="Run settings"] .inference-settings-toggle').click();
  await expect(page.locator(".temperature-control")).toHaveCount(0);
  await expect(page.locator(".inference-settings-facts")).toContainText(
    "Provider default temp",
  );

  await page.getByRole("button", { name: /run request/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Provider received no temperature override.",
  );
});
