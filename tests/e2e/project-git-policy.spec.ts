import { expect, test } from "@playwright/test";
import { createProjectFile, serializeProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
  seedProfile, stubProjectDirectory, waitForHydration,
} from "./support";
import { expectModalContract } from "./support/modal";

async function directoryFiles(page: import("@playwright/test").Page, path: string[] = []) {
  return page.evaluate(async (segments) => {
    let directory = await (window as unknown as {
      showDirectoryPicker(): Promise<import("../../app/project-directory.client").FileSystemDirectoryHandleLike>;
    }).showDirectoryPicker();
    for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
    const files: Record<string, string> = {};
    const read = async (dir: typeof directory, prefix: string) => {
      for await (const entry of dir.values()) {
        if (entry.kind === "directory") await read(entry, `${prefix}${entry.name}/`);
        else files[`${prefix}${entry.name}`] = await (await entry.getFile()).text();
      }
    };
    await read(directory, "");
    return files;
  }, path);
}

test("project creation explains the three Git presets and the manifest sharing boundary", async ({ page }) => {
  await seedProfile(page);
  await stubProjectDirectory(page, { name: "Projects", files: {} });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "New project folder…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create an Inference Lens project" });
  // Assert the missing behavior as text before attempting to use a new control.
  await expect(dialog).toContainText("Share definitions; keep run history local");
  await expect(dialog).toContainText("Manage Git rules myself");
  await expect(dialog.getByRole("radio", { name: "Keep this project out of Git", exact: true })).toBeChecked();
  await dialog.getByRole("radio", { name: "Share definitions; keep run history local", exact: true }).check();
  await expect(dialog).toContainText("Shares all content in project.json, including persisted drafts and saved values.");
  await expect(dialog).not.toContainText(/NaN|Infinity|undefined/);
  await dialog.getByLabel("Project name").fill("Shared definitions");
  await dialog.getByRole("button", { name: "Choose location…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Saved to Shared definitions.inference-lens");
  const files = await directoryFiles(page, ["Shared definitions.inference-lens"]);
  expect(files[".gitignore"]).toBe("*\n!/.gitignore\n!/project.json\n");
  expect(JSON.parse(files["project.json"]).name).toBe("Shared definitions");
});

for (const preset of [
  { name: "Keep this project out of Git", ignore: "*\n" },
  { name: "Manage Git rules myself", ignore: undefined },
]) {
  test(`creation preserves the ${preset.name} choice`, async ({ page }) => {
    await seedProfile(page);
    await stubProjectDirectory(page, { name: "Projects", files: {} });
    await page.goto("/");
    await waitForHydration(page);
    await page.getByLabel("Project menu").click();
    await page.getByRole("button", { name: "New project folder…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create an Inference Lens project" });
    await dialog.getByRole("radio", { name: preset.name, exact: true }).check();
    await dialog.getByLabel("Project name").fill("Preset project");
    await dialog.getByRole("button", { name: "Choose location…", exact: true }).click();
    await expect(page.locator(".brand")).toContainText("Saved to Preset project.inference-lens");
    const files = await directoryFiles(page, ["Preset project.inference-lens"]);
    expect(files[".gitignore"]).toBe(preset.ignore);
    expect(JSON.parse(files["project.json"]).name).toBe("Preset project");
  });
}

test("a definitions-only clone opens without evidence and running leaves its manifest byte-identical", async ({ page }) => {
  const project = createProjectFile({
    name: "Definitions clone",
    idSuffix: "definitions-clone",
    createdAt: "2026-10-25T12:00:00.000Z",
    request: {
      provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Run from shared definitions." }],
    },
  });
  const manifest = serializeProjectFile(project);
  await seedProfile(page, { instanceId: "definitions-clone-profile" });
  await page.addInitScript(({ key, projectId, requirementId }) => {
    localStorage.setItem(key, JSON.stringify({
      [projectId]: { [requirementId]: {
        profileId: "buffered", profileInstanceId: "definitions-clone-profile",
      } },
    }));
  }, {
    key: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
    projectId: project.projectId,
    requirementId: project.defaults.target.connectionRequirementId,
  });
  await stubProjectDirectory(page, {
    name: "Definitions clone.inference-lens",
    files: { ".gitignore": "*\n!/.gitignore\n!/project.json\n", "project.json": manifest },
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Saved to Definitions clone.inference-lens");
  expect(Object.keys(await directoryFiles(page)).sort()).toEqual([".gitignore", "project.json"]);
  await page.getByRole("button", { name: /run current conversation/i }).click();
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response: 2 + 2 = 4.");
  await expect.poll(async () => Object.keys(await directoryFiles(page)).filter((path) => path.startsWith("traces/"))).toHaveLength(1);
  const files = await directoryFiles(page);
  expect(files["project.json"]).toBe(manifest);
  expect(files[".gitignore"]).toBe("*\n!/.gitignore\n!/project.json\n");
  await expect(page.locator(".response-pane")).not.toContainText(/NaN|Infinity|undefined/);
});

test("project creation follows the modal contract", async ({ page }) => {
  await seedProfile(page);
  await stubProjectDirectory(page, { name: "Projects", files: {} });
  await page.goto("/");
  await waitForHydration(page);
  const menu = page.getByLabel("Project menu");
  await menu.click();
  await expectModalContract(page, {
    open: page.getByRole("button", { name: "New project folder…", exact: true }),
    dialog: page.getByRole("dialog", { name: "Create an Inference Lens project" }),
    restoreTo: menu,
  });
});
