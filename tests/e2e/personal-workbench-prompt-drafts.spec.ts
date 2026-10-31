/**
 * Shared assets 2b step 2, behind the gate (D2): prompt drafts live in the
 * folder's `.workbench/`, and only Save writes `project.json`
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 2 decisions").
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
import { serializeProjectManifest } from "../../app/workbench/project-manifest";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  openMode,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

test.use({ personalWorkbench: true });

function fixtureProject(): ProjectFile {
  const project = createProjectFile({
    name: "Personal drafts fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "personal-drafts",
    createdAt: "2026-10-31T12:00:00.000Z",
  });
  return createPromptTemplate(project, {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "triage",
    revisionIdSuffix: "triage-1",
    createdAt: "2026-10-31T12:00:01.000Z",
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
  await stubProjectDirectory(page, { name: "personal-drafts", files: { "project.json": manifest } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Personal drafts fixture");
}

const draftFiles = (files: Record<string, string>) =>
  Object.entries(files).filter(([path]) => path.startsWith(".workbench/drafts/"));

test("a prompt edit is a personal draft until Save publishes it to project.json", async ({ page }) => {
  const manifest = serializeProjectManifest(fixtureProject(), "personal");
  await openFolder(page, manifest);
  await openMode(page, "Prompts");
  const editor = page.locator(".template-editor");
  await editor.getByLabel("Prompt content").fill("Triage {{incident}} for the on-call engineer.");

  // The draft reaches .workbench/ after the debounce; project.json is untouched.
  await expect.poll(async () => draftFiles(await folderFiles(page)).length).toBe(1);
  let files = await folderFiles(page);
  const [, draftContents] = draftFiles(files)[0]!;
  const draft = JSON.parse(draftContents);
  expect(draft.asset).toEqual({ kind: "chat-prompt", id: "template_triage" });
  expect(draft.edited.messages[0].content).toBe("Triage {{incident}} for the on-call engineer.");
  expect(files[".workbench/.gitignore"]).toBe("*\n");
  expect(files["project.json"]).toBe(manifest);

  await editor.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect.poll(async () => draftFiles(await folderFiles(page)).length).toBe(0);
  files = await folderFiles(page);
  const saved = JSON.parse(files["project.json"]!);
  expect(saved.schemaVersion).toBe(19);
  const template = saved.promptTemplates[0];
  expect(template.draft).toBeUndefined();
  expect(template.revisions).toHaveLength(2);
  expect(template.currentRevisionId).toBe(template.revisions[1].id);
  expect(template.revisions[1].messages[0].content).toBe("Triage {{incident}} for the on-call engineer.");
  await expect(editor.getByRole("button", { name: "Create revision", exact: true })).toBeDisabled();
  await expect(page.locator(".brand")).toContainText("Saved to personal-drafts");
});

test("a legacy folder opens with its prompt draft, but nothing is written to it", async ({ page }) => {
  const project = updatePromptTemplateDraft(fixtureProject(), {
    templateId: "template_triage",
    sourceRevisionId: "template-revision_triage-1",
    messages: [{ role: "user", content: "Triage {{incident}} from the legacy draft." }],
    variableDefaults: { incident: "timeout" },
  });
  const manifest = serializeProjectFile(project);
  expect(JSON.parse(manifest).schemaVersion).toBe(18);
  await openFolder(page, manifest);
  await expect(page.locator(".brand")).toContainText("Not saved — shared saves need this older-format folder upgraded");

  await openMode(page, "Prompts");
  const editor = page.locator(".template-editor");
  await expect(editor.getByLabel("Prompt content")).toHaveValue("Triage {{incident}} from the legacy draft.");
  await editor.getByLabel("Prompt content").fill("Triage {{incident}} edited in a gated session.");
  // Session-only: no .workbench/, and project.json keeps its v18 bytes.
  await page.waitForTimeout(1_500);
  const files = await folderFiles(page);
  expect(Object.keys(files)).toEqual(["project.json"]);
  expect(files["project.json"]).toBe(manifest);
});
