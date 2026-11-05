/**
 * Shared assets 2b step 8a (Z3): replacing a session counts
 * the personal work held only in memory, so a no-folder session or a
 * pre-v19 folder cannot lose its drafts to an import or open without a
 * dialog (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 8 decisions").
 */
import type { Page } from "./support/test";

import { expect, test } from "./support/test";
import { createProjectFile, createPromptTemplate, serializeProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { serializeLegacyProjectFile } from "../legacy-project-helpers";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  closeProjectMenu,
  importProject,
  openMode,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

function project(name: string, content: string): ProjectFile {
  const slug = name.toLowerCase().replaceAll(" ", "-");
  return createPromptTemplate(
    createProjectFile({
      name,
      request: {
        provider: "openai-compatible",
        endpoint: BUFFERED_FIXTURE_ENDPOINT,
        model: "buffered-test-model",
        messages: [{ role: "user", content: "Hello" }],
      },
      idSuffix: slug,
      createdAt: "2026-11-05T12:00:00.000Z",
    }),
    {
      name: `${name} prompt`,
      messages: [{ role: "user", content }],
      idSuffix: `${slug}-prompt`,
      revisionIdSuffix: `${slug}-revision`,
      createdAt: "2026-11-05T12:01:00.000Z",
    },
  );
}

async function importOver(page: Page, replacement: ProjectFile): Promise<void> {
  await page.getByLabel("Project menu").click();
  await page.setInputFiles('.project-popover:not(.run-data-popover) input[type="file"]', {
    name: "replacement.project.json",
    mimeType: "application/json",
    buffer: Buffer.from(serializeProjectFile(replacement)),
  });
  await closeProjectMenu(page);
}

/** Every file under the stubbed folder, by relative path. */
async function folderFiles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const root = await (window as unknown as {
      showDirectoryPicker(): Promise<import("../../app/project-directory.client").FileSystemDirectoryHandleLike>;
    }).showDirectoryPicker();
    const files: Record<string, string> = {};
    const read = async (dir: typeof root, prefix: string) => {
      for await (const entry of dir.values()) {
        if (entry.kind === "directory") await read(entry, `${prefix}${entry.name}/`);
        else files[`${prefix}${entry.name}`] = await (await entry.getFile()).text();
      }
    };
    await read(root, "");
    return files;
  });
}

const decision = (page: Page) => page.getByRole("dialog", { name: "Save changes before switching projects?" });

test("a session-only prompt draft stops an import, and Cancel keeps it", async ({ page }) => {
  const original = project("Session original", "Original saved prompt");
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, original, original.name);
  await openMode(page, "Prompts");
  const prompt = page.getByLabel("Prompt content", { exact: true });
  await prompt.fill("A draft held only in this session");

  await importOver(page, project("Session replacement", "Replacement saved prompt"));
  await expect(decision(page)).toContainText("1 unsaved draft is held only in this session");
  await decision(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Session original");
  await expect(prompt).toHaveValue("A draft held only in this session");

  await importOver(page, project("Session replacement", "Replacement saved prompt"));
  await decision(page).getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Session replacement");
  await openMode(page, "Prompts");
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue("Replacement saved prompt");
});

test("Discard and switch to the same project drops the session draft", async ({ page }) => {
  const original = project("Session same", "Original saved prompt");
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, original, original.name);
  await openMode(page, "Prompts");
  const prompt = page.getByLabel("Prompt content", { exact: true });
  await prompt.fill("A draft the user chose to discard");

  // The same file again: only a save into a folder carries session drafts (S2).
  await importOver(page, original);
  await expect(decision(page)).toContainText("1 unsaved draft is held only in this session");
  await decision(page).getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(decision(page)).toHaveCount(0);
  await openMode(page, "Prompts");
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue("Original saved prompt");
});

test("Save and switch writes a session draft into the new folder's workbench", async ({ page }) => {
  const original = project("Saved original", "Original saved prompt");
  await seedProfile(page);
  await stubProjectDirectory(page, { name: "Projects", files: {} });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, original, original.name);
  await openMode(page, "Prompts");
  await page.getByLabel("Prompt content", { exact: true }).fill("A draft that the save must keep");

  await importOver(page, project("Saved replacement", "Replacement saved prompt"));
  await decision(page).getByRole("button", { name: "Save and switch", exact: true }).click();
  await page.getByRole("dialog", { name: "Save the current project" })
    .getByRole("button", { name: "Save and switch…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Saved replacement");

  await expect.poll(async () => {
    const drafts = Object.entries(await folderFiles(page)).filter(([path]) => path.includes(".workbench/drafts/"));
    return drafts.map(([, contents]) => JSON.parse(contents).edited?.messages?.[0]?.content);
  }).toContain("A draft that the save must keep");
});

test("a pre-v19 folder's session draft stops an open, with no save that would lose it", async ({ page }) => {
  const original = project("Legacy original", "Original saved prompt");
  await seedProfile(page);
  await stubProjectDirectory(page, {
    name: "legacy-original.inference-lens",
    files: { "project.json": serializeLegacyProjectFile(original) },
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Legacy original");
  await openMode(page, "Prompts");
  await page.getByLabel("Prompt content", { exact: true }).fill("A draft the old folder cannot hold");

  await importOver(page, project("Legacy replacement", "Replacement saved prompt"));
  await expect(decision(page)).toContainText("1 unsaved draft is held only in this session");
  await expect(decision(page).getByRole("button", { name: "Save and switch", exact: true })).toHaveCount(0);
  await decision(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Legacy original");
});
