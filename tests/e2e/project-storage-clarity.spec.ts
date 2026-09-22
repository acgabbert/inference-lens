import { expect, test } from "@playwright/test";

import {
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import {
  importProject,
  openMode,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

function project() {
  return createPromptTemplate(
    createProjectFile({
      name: "Storage clarity",
      request: {
        provider: "openai-compatible",
        endpoint: "http://127.0.0.1:44014/v1",
        model: "buffered-test-model",
        messages: [{ role: "user", content: "Inspect the save state." }],
      },
      idSuffix: "storage-clarity",
      createdAt: "2026-09-21T18:00:00.000Z",
    }),
    {
      name: "Storage prompt",
      messages: [{ role: "user", content: "Keep this draft." }],
      idSuffix: "storage-prompt",
      revisionIdSuffix: "storage-prompt-revision",
      createdAt: "2026-09-21T18:01:00.000Z",
    },
  );
}

test("an imported JSON project stays visibly session-only until saved to a folder", async ({ page }) => {
  await seedProfile(page);
  await stubProjectDirectory(page, { name: "Projects", files: {} });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project(), "Storage clarity");

  const brand = page.locator(".brand");
  await expect(brand).toContainText("Session only — save to a folder to keep changes");

  await openMode(page, "Prompts");
  await expect(page.locator(".template-editor")).toContainText(
    "Draft kept in this session. Save the project to keep it after closing.",
  );

  await page.getByLabel("Project menu").click();
  await expect(page.getByRole("button", { name: "Open project folder…", exact: true })).toBeVisible();
  await expect(page.getByText("Import project JSON…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export JSON copy…", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Save project to folder…/ }).click();

  const dialog = page.getByRole("dialog", { name: "Save this project" });
  await expect(dialog).toContainText(
    "Choose a folder for this project. Its current prompts and settings will be saved there.",
  );
  await dialog.getByRole("button", { name: "Save to folder…", exact: true }).click();

  await expect(brand).toContainText("Saved to Storage clarity.inference-lens");
  await expect(page.locator(".template-editor")).toContainText("Draft autosaved.");
});

test("folder-backed edits expose saving and save-failure states", async ({ page }) => {
  await seedProfile(page);
  await stubProjectDirectory(page, {
    name: "storage-clarity.inference-lens",
    files: { "project.json": JSON.stringify(project()) },
    writeError: "Fixture refused the write.",
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…", exact: true }).click();

  const brand = page.locator(".brand");
  await expect(brand).toContainText("Saved to storage-clarity.inference-lens");
  await openMode(page, "Prompts");
  await page.getByLabel("Prompt content", { exact: true }).fill("This write will fail.");
  await expect(brand).toContainText("Saving to storage-clarity.inference-lens…");
  await expect(brand).toContainText("Save failed — retry from Project", { timeout: 5_000 });
});
