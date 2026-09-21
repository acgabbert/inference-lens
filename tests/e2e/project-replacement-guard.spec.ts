import { expect, test } from "@playwright/test";

import {
  createProjectFile,
  createPromptTemplate,
  serializeProjectFile,
} from "../../packages/core/src/project";
import {
  closeProjectMenu,
  importProject,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

function project(name: string, content: string) {
  return createPromptTemplate(
    createProjectFile({
      name,
      request: {
        provider: "openai-compatible",
        endpoint: "http://127.0.0.1:44014/v1",
        model: "buffered-test-model",
        messages: [{ role: "user", content: `${name} request` }],
      },
      idSuffix: name.toLowerCase().replaceAll(" ", "-"),
      createdAt: "2026-09-21T12:00:00.000Z",
    }),
    {
      name: `${name} prompt`,
      messages: [{ role: "user", content }],
      idSuffix: `${name.toLowerCase().replaceAll(" ", "-")}-prompt`,
      revisionIdSuffix: `${name.toLowerCase().replaceAll(" ", "-")}-revision`,
      createdAt: "2026-09-21T12:01:00.000Z",
    },
  );
}

test("import asks before replacing unsaved project work", async ({ page }) => {
  const original = project("Original project", "Original saved prompt");
  const replacement = project("Replacement project", "Replacement saved prompt");

  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, original, original.name);

  await page.getByRole("tab", { name: /Prompts/ }).click();
  const prompt = page.getByLabel("Prompt content", { exact: true });
  await prompt.fill("Unsaved prompt that must survive cancellation");
  await expect(page.locator(".brand")).toContainText("Unsaved");

  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "replacement.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(replacement)),
    },
  );

  const decision = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await expect(decision).toContainText("Original project");
  await expect(decision).toContainText("Replacement project");
  await decision.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(page.locator(".brand")).toContainText("Original project");
  await expect(prompt).toHaveValue("Unsaved prompt that must survive cancellation");

  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "replacement.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(replacement)),
    },
  );
  await decision.getByRole("button", { name: "Discard and switch", exact: true }).click();

  await expect(page.locator(".brand")).toContainText("Replacement project");
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue(
    "Replacement saved prompt",
  );
});

test("open and new use the same replacement guard", async ({ page }) => {
  const original = project("Original project", "Original saved prompt");
  const replacement = project("Folder replacement", "Folder saved prompt");

  await seedProfile(page);
  await stubProjectDirectory(page, {
    name: "folder-replacement.inference-lens",
    files: { "project.json": serializeProjectFile(replacement) },
  });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, original, original.name);
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await page.getByLabel("Prompt content", { exact: true }).fill("Unsaved open guard");

  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…", exact: true }).click();
  const decision = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await expect(decision).toContainText("the selected project folder");
  await decision.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Original project");

  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create an Inference Lens project" });
  await create.getByLabel("Project name").fill("Fresh project");
  await create.getByRole("button", { name: "Choose location…" }).click();
  await expect(decision).toContainText("Fresh project");
  await decision.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Original project");

  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…", exact: true }).click();
  await decision.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Folder replacement");
});

test("save and switch persists the draft before importing", async ({ page }) => {
  const original = project("Folder original", "Original saved prompt");
  const replacement = project("Imported replacement", "Replacement saved prompt");

  await seedProfile(page);
  await stubProjectDirectory(page, {
    name: "folder-original.inference-lens",
    files: { "project.json": serializeProjectFile(original) },
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Folder original");
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await page.getByLabel("Prompt content", { exact: true }).fill("Saved before switching");

  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "replacement.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeProjectFile(replacement)),
    },
  );
  await closeProjectMenu(page);
  const decision = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await decision.getByRole("button", { name: "Save and switch", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Imported replacement");

  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Folder original");
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue(
    "Saved before switching",
  );
});

test("an imported project chooses a save location before switching", async ({ page }) => {
  const original = project("Imported original", "Original saved prompt");
  const replacement = project("Next imported project", "Replacement saved prompt");

  await seedProfile(page);
  await stubProjectDirectory(page, { name: "Projects", files: {} });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, original, original.name);
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await page.getByLabel("Prompt content", { exact: true }).fill("Draft saved to a new folder");
  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "replacement.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeProjectFile(replacement)),
    },
  );

  const decision = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await decision.getByRole("button", { name: "Save and switch", exact: true }).click();
  const location = page.getByRole("dialog", { name: "Save the current project" });
  await expect(location).toContainText("switch projects only after the save succeeds");
  await location.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(decision).toBeVisible();

  await decision.getByRole("button", { name: "Save and switch", exact: true }).click();
  await location.getByRole("button", { name: "Save and switch…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Next imported project");
});

test("a failed save keeps the current project and replacement decision", async ({ page }) => {
  const original = project("Failing folder", "Original saved prompt");
  const replacement = project("Must not open", "Replacement saved prompt");

  await seedProfile(page);
  await stubProjectDirectory(page, {
    name: "failing-folder.inference-lens",
    files: { "project.json": serializeProjectFile(original) },
    writeError: "Fixture refused the write.",
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Failing folder");
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await page.getByLabel("Prompt content", { exact: true }).fill("Unsaved after failure");

  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "replacement.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeProjectFile(replacement)),
    },
  );
  const decision = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await decision.getByRole("button", { name: "Save and switch", exact: true }).click();
  await expect(decision.getByRole("alert")).toContainText("Fixture refused the write.");
  await expect(decision).toContainText("The current project is still open.");
  await expect(page.locator(".brand")).toContainText("Failing folder");
  await expect(page.locator(".brand")).toContainText("Unsaved");
});
