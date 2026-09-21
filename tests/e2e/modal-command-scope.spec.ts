import { expect, test } from "@playwright/test";

import { createProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openMode,
  PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
  seedProfile,
  waitForHydration,
} from "./support";

test("the global run shortcut is suppressed while an authoring modal is open", async ({ page }) => {
  const project = createProjectFile({
    name: "Modal command scope fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "2 + 2" }],
    },
    idSuffix: "modal-command-scope",
    createdAt: "2026-08-06T12:00:00.000Z",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.addInitScript(
    ({ key, projectId, requirementId }) => {
      localStorage.setItem(key, JSON.stringify({
        [projectId]: {
          [requirementId]: {
            profileId: "buffered",
            profileInstanceId: "profile-instance-buffered",
          },
        },
      }));
    },
    {
      key: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
      projectId: project.projectId,
      requirementId: project.defaults.target.connectionRequirementId,
    },
  );
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Modal command scope fixture");
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Tools/ }).click();
  await page.getByRole("button", { name: "Browse local library" }).click();

  const dialog = page.getByRole("dialog", { name: "Local tool library" });
  await dialog.getByRole("button", { name: "+ New library tool" }).click();
  const functionName = dialog.getByLabel("Function name", { exact: true });
  await functionName.fill("editing_a_library_definition");
  let inferenceRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/inference") inferenceRequests += 1;
  });
  await functionName.press("ControlOrMeta+Enter");

  await expect(dialog).toBeVisible();
  await page.waitForTimeout(750);
  expect(inferenceRequests).toBe(0);
});
