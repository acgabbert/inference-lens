import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createProjectFile, createPromptTemplate, parseProjectJson, serializeProjectFile } from "../../packages/core/src/project";
import { BUFFERED_FIXTURE_ENDPOINT, PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY, closeProjectMenu, importProject, openMode, seedProfile, stubProjectDirectory, waitForHydration } from "./support";

// Review evidence, not desired-behavior regressions: assertions intentionally
// characterize current friction. Replace them when the corresponding UX changes.
const OUT = "/tmp/inference-lens-ux-review-2026-09-21";
test.beforeEach(async () => { await mkdir(OUT, { recursive: true }); });
async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, animations: "disabled" });
  await writeFile(`${OUT}/${name}.txt`, await page.locator("body").innerText());
}
function fixture(name = "Daily triage") {
  return createPromptTemplate(createProjectFile({
    name,
    request: { provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model", messages: [{ role: "user", content: "COMPOSER REQUEST: summarize yesterday." }] },
    idSuffix: name.replaceAll(" ", "-"), createdAt: "2026-09-21T00:00:00Z",
  }), {
    name: "Incident triage", messages: [{ role: "user", content: "SAVED PROMPT: investigate {{incident}}." }], variableDefaults: { incident: "timeout" },
    idSuffix: "daily-triage", revisionIdSuffix: "daily-triage-1", createdAt: "2026-09-21T00:01:00Z",
  });
}
async function setup(page: Page, folder = false) {
  const project = fixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedProfile(page, { instanceId: "daily-profile" });
  await page.addInitScript(({ key, id, requirement }) => localStorage.setItem(key, JSON.stringify({ [id]: { [requirement]: { profileId: "buffered", profileInstanceId: "daily-profile" } } })), { key: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY, id: project.projectId, requirement: project.defaults.target.connectionRequirementId });
  if (folder) await stubProjectDirectory(page, { name: "daily-triage.inference-lens", files: { "project.json": serializeProjectFile(project) }, directories: ["traces", "experiments"] });
  await page.goto("/"); await waitForHydration(page);
  if (folder) {
    await page.getByLabel("Project menu").click();
    await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
    await expect(page.locator(".brand")).toContainText(project.name);
  } else await importProject(page, project, project.name);
  return project;
}

test("review: leaving prompt authoring to run sends the current conversation", async ({ page }) => {
  await setup(page);
  await capture(page, "01-imported-compose");
  await openMode(page, "Prompts");
  await page.getByLabel("Prompt content", { exact: true }).fill("VISIBLE DRAFT: diagnose the current incident.");
  await capture(page, "02-prompt-edit-before-run");
  await openMode(page, "Compose");
  await page.getByRole("button", { name: /^Run current conversation/ }).click();
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");
  await page.getByRole("button", { name: "Run details", exact: true }).click();
  await page.getByRole("tab", { name: /^Events/ }).click();
  const evidence = page.locator(".request-evidence").first();
  await expect(evidence).toContainText("COMPOSER REQUEST: summarize yesterday.");
  await expect(evidence).not.toContainText("VISIBLE DRAFT");
  await capture(page, "03-prompt-run-sent-conversation");
});

test("review: direct prompt reuse reaches a real request and remains discoverable in Runs", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Insert saved prompt…" }).click();
  const picker = page.getByRole("dialog", { name: "Insert saved prompt" });
  await expect(picker.getByText("Incident triage", { exact: true })).toBeVisible();
  await capture(page, "04-insertion-below-metadata");
  await picker.getByRole("button", { name: "Insert prompt", exact: true }).click();
  const use = page.locator(".template-use-card");
  await expect(use).toContainText("SAVED PROMPT");
  await use.locator(".template-use-variable summary").click();
  await use.locator('textarea[data-template-variable="incident"]').fill("database outage");
  await capture(page, "05-inserted-prompt-values");
  await page.getByRole("button", { name: /^Run current conversation/ }).click();
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");
  await page.getByRole("button", { name: "Run details", exact: true }).click();
  await page.getByRole("tab", { name: /^Events/ }).click();
  await expect(page.locator(".request-evidence").first()).toContainText("SAVED PROMPT: investigate database outage.");
  await capture(page, "06-reused-prompt-result");
  await openMode(page, "Runs");
  await expect(page.getByRole("button", { name: "View current response", exact: true })).toBeVisible();
  await expect(page.getByText("Save this project to a folder to build a browsable run history.", { exact: true })).toBeVisible();
  await capture(page, "07-imported-project-runs-history-disabled");
});

test("review: project Save explains its destination and export preserves a draft", async ({ page }) => {
  await setup(page);
  await openMode(page, "Prompts");
  await page.getByLabel("Prompt content", { exact: true }).fill("PORTABLE DRAFT: keep this text.");
  await page.getByLabel("Project menu").click();
  await capture(page, "08-project-menu");
  await page.getByRole("button", { name: /^Save/ }).click();
  const dialog = page.getByRole("dialog", { name: "Save this project" });
  await expect(dialog).toContainText("current prompts and settings will be saved there");
  await capture(page, "09-save-opens-create-dialog");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Project menu").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON copy…", exact: true }).click();
  await (await download).saveAs(`${OUT}/exported-project.json`);
  await expect(page.locator(".brand")).toContainText("Unsaved");
  const exported = parseProjectJson(await readFile(`${OUT}/exported-project.json`, "utf8"));
  expect(exported.promptTemplates[0]!.draft!.messages[0]!.content).toBe("PORTABLE DRAFT: keep this text.");
  // Export leaves its menu open. Close it before the shared import driver.
  await page.getByLabel("Project menu").click();
  await importProject(page, exported, exported.name, { replaceDirty: "discard" });
  await openMode(page, "Prompts");
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue("PORTABLE DRAFT: keep this text.");
  await expect(page.locator(".brand")).not.toContainText("Unsaved");
  await expect(page.locator(".template-editor")).toContainText(
    "Draft kept in this session. Save the project to keep it after closing.",
  );
  await capture(page, "10-export-import-retained-draft");
});

test("review: importing another project asks before replacing an unsaved prompt", async ({ page }) => {
  const original = await setup(page);
  await openMode(page, "Prompts");
  await page.getByLabel("Prompt content", { exact: true }).fill("UNSAVED WORK: do not discard silently.");
  await expect(page.locator(".brand")).toContainText("Unsaved");
  await page.getByLabel("Project menu").click();
  await page.setInputFiles('.project-popover:not(.run-data-popover) input[type="file"]', {
    name: "other-project.json",
    mimeType: "application/json",
    buffer: Buffer.from(serializeProjectFile(fixture("Other project"))),
  });
  const decision = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await expect(decision).toContainText(original.name);
  await expect(decision).toContainText("Other project");
  await decision.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue("UNSAVED WORK: do not discard silently.");
  await page.setInputFiles('.project-popover:not(.run-data-popover) input[type="file"]', {
    name: "other-project.json",
    mimeType: "application/json",
    buffer: Buffer.from(serializeProjectFile(fixture("Other project"))),
  });
  await decision.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Other project");
  await closeProjectMenu(page);
  await importProject(page, original, original.name);
  await openMode(page, "Prompts");
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue("SAVED PROMPT: investigate {{incident}}.");
  await capture(page, "11-unsaved-draft-replaced");
});

test("review: folder autosave survives reopen and ordinary runs are in the history menu", async ({ page }) => {
  await setup(page, true);
  await openMode(page, "Prompts");
  await page.getByLabel("Prompt content", { exact: true }).fill("FOLDER DRAFT: retained after reopen.");
  await expect(page.locator(".template-editor")).toContainText("Draft autosaved.");
  await expect(page.locator(".brand")).not.toContainText("Unsaved");
  // Adopt a different document first so the same mounted editor cannot satisfy
  // the reopen assertion before the asynchronous folder read completes.
  await importProject(page, fixture("Temporary other project"), "Temporary other project");
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Daily triage");
  await openMode(page, "Prompts");
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue("FOLDER DRAFT: retained after reopen.");
  await page.getByRole("button", { name: "Create revision and add", exact: true }).click();
  await page.getByRole("button", { name: /^Run current conversation/ }).click();
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");
  await openMode(page, "Runs");
  await page.getByRole("button", { name: "Open saved run history", exact: true }).click();
  await expect(page.locator(".run-history-item")).toHaveCount(1);
  await capture(page, "12-folder-run-history");
  await page.locator(".run-history-item").click();
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");
  await capture(page, "13-reopened-ordinary-run");
});
