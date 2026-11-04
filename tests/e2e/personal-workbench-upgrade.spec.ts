/**
 * Shared assets 2b step 6a, behind the gate (D2): a pre-v19 folder upgrades
 * through a preview, stages its source and drafts in `.workbench/migrations/`,
 * writes v19 and reopens as a shared session. Edits made to the lifted drafts
 * before the upgrade carry over (V2)
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 6 decisions").
 */
import type { Page } from "./support/test";

import { expect, test } from "./support/test";
import {
  createProjectFile,
  createPromptTemplate,
  serializeProjectFile,
  updatePromptTemplateDraft,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  openMode,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

test.use({ personalWorkbench: true });

function legacyProject(): ProjectFile {
  const project = createPromptTemplate(createProjectFile({
    name: "Upgrade fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "upgrade",
    createdAt: "2026-11-04T12:00:00.000Z",
  }), {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "triage",
    revisionIdSuffix: "triage-1",
    createdAt: "2026-11-04T12:00:01.000Z",
  });
  return updatePromptTemplateDraft(project, {
    templateId: "template_triage",
    sourceRevisionId: "template-revision_triage-1",
    messages: [{ role: "user", content: "Triage {{incident}} from the legacy draft." }],
    variableDefaults: { incident: "timeout" },
  });
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

async function openFolder(page: Page, manifest: string): Promise<void> {
  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await stubProjectDirectory(page, { name: "upgrade-fixture", files: { "project.json": manifest } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Upgrade fixture");
}

const activeDrafts = (files: Record<string, string>) =>
  Object.entries(files).filter(([path]) => path.startsWith(".workbench/drafts/"));

test("Upgrade writes v19, keeps the source, and carries a draft edited before it", async ({ page }) => {
  const manifest = serializeProjectFile(legacyProject());
  expect(JSON.parse(manifest).schemaVersion).toBe(18);
  await openFolder(page, manifest);
  await expect(page.locator(".brand")).toContainText("Not saved — shared saves need this older-format folder upgraded");

  await openMode(page, "Prompts");
  const editor = page.locator(".template-editor");
  await editor.getByLabel("Prompt content").fill("Triage {{incident}} edited before the upgrade.");

  const notice = page.getByRole("status").filter({ hasText: "older project format" });
  await notice.getByRole("button", { name: "Upgrade project…" }).click();
  const dialog = page.getByRole("dialog", { name: "Upgrade this project to the shared format?" });
  await expect(dialog).toContainText("Project format 18");
  await expect(dialog).toContainText("Incident triage");
  await expect(dialog).toContainText("older builds");
  // Opening and previewing write nothing.
  expect(Object.keys(await folderFiles(page))).toEqual(["project.json"]);

  await dialog.getByRole("button", { name: "Upgrade", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".brand")).toContainText("Saved to upgrade-fixture");

  await expect.poll(async () => JSON.parse((await folderFiles(page))["project.json"]!).schemaVersion).toBe(19);
  // The edit made before the upgrade replaced the migrated draft's content.
  await expect.poll(async () => {
    const drafts = activeDrafts(await folderFiles(page));
    return drafts.map(([, contents]) => JSON.parse(contents).edited.messages[0].content);
  }).toEqual(["Triage {{incident}} edited before the upgrade."]);

  const files = await folderFiles(page);
  const shared = JSON.parse(files["project.json"]!);
  expect(shared.promptTemplates[0].draft).toBeUndefined();
  const [draftPath] = activeDrafts(files)[0]!;
  expect(draftPath).toMatch(/^\.workbench\/drafts\/draft_migrated-[0-9a-f]+\.json$/);
  const sources = Object.entries(files).filter(([path]) => /^\.workbench\/migrations\/migration_[0-9a-f]+\/source\.project\.json$/.test(path));
  expect(sources).toHaveLength(1);
  expect(sources[0]![1]).toBe(manifest);
  // The staged candidate keeps the draft as the file held it.
  const candidate = Object.entries(files).find(([path]) => path.includes("/candidates/draft_migrated-"));
  expect(JSON.parse(candidate![1]).edited.messages[0].content).toBe("Triage {{incident}} from the legacy draft.");
  expect(files[".workbench/.gitignore"]).toBe("*\n");

  // Saves work again: Create revision publishes the carried draft.
  await expect(editor.getByLabel("Prompt content")).toHaveValue("Triage {{incident}} edited before the upgrade.");
  await editor.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect.poll(async () => activeDrafts(await folderFiles(page)).length).toBe(0);
  const published = JSON.parse((await folderFiles(page))["project.json"]!);
  expect(published.promptTemplates[0].revisions).toHaveLength(2);
  expect(published.promptTemplates[0].revisions[1].messages[0].content).toBe("Triage {{incident}} edited before the upgrade.");
});

test("Cancel leaves the folder untouched and shared saves still blocked", async ({ page }) => {
  const manifest = serializeProjectFile(legacyProject());
  await openFolder(page, manifest);
  await page.getByRole("status").filter({ hasText: "older project format" })
    .getByRole("button", { name: "Upgrade project…" }).click();
  const dialog = page.getByRole("dialog", { name: "Upgrade this project to the shared format?" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".brand")).toContainText("Not saved — shared saves need this older-format folder upgraded");
  expect(await folderFiles(page)).toEqual({ "project.json": manifest });
});
