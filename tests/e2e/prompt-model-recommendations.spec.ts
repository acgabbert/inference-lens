import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createProjectFile, createPromptTemplate, parseProjectJson, setPromptTemplateRecommendedTarget } from "../../packages/core/src/project";
import { BUFFERED_FIXTURE_ENDPOINT, importProject, openMode, PROJECT_PROFILE_MAP_STORAGE_KEY, seedProfile, waitForHydration } from "./support";

const PROJECT_NAME = "Prompt model recommendations";
function fixture() {
  let project = createProjectFile({
    name: PROJECT_NAME,
    request: { provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model", messages: [{ role: "user", content: "Keep this draft." }] },
    idSuffix: "model-recommendations", createdAt: "2026-10-28T12:00:00.000Z",
  });
  project = createPromptTemplate(project, { name: "Triage", messages: [{ role: "user", content: "Triage this incident." }], idSuffix: "triage", revisionIdSuffix: "triage-1", createdAt: "2026-10-28T12:00:01.000Z" });
  return setPromptTemplateRecommendedTarget(project, project.promptTemplates[0]!.id, {
    connectionRequirementId: project.connectionRequirements[0]!.id, model: "triage-model",
  });
}
async function insert(page: Page) {
  await page.getByRole("button", { name: "Insert saved prompt…" }).click();
  await page.getByRole("option", { name: /Triage/ }).click();
  return page.locator("[data-template-use-id]").last();
}
const modelField = (page: Page) => page.locator('[data-readiness-control="model"]');

test.beforeEach(async ({ page }) => {
  // Mapped, so run readiness gets past its connection blocker and reaches the
  // template rules; otherwise an absent recommendation notice proves nothing.
  const instanceId = "profile-instance-model-recommendations";
  await seedProfile(page, { instanceId });
  await page.addInitScript(({ mapKey, projectId, instanceId }) => {
    localStorage.setItem(mapKey, JSON.stringify({ [projectId]: { profileId: "buffered", profileInstanceId: instanceId } }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: fixture().projectId, instanceId });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), PROJECT_NAME);
});

test("the library, quick picker and insertion preview show the recommended model", async ({ page }, testInfo) => {
  await openMode(page, "Prompts");
  const row = page.locator(".template-list").getByRole("button", { name: /Triage/ });
  await expect(row).toContainText("Recommended model: triage-model");
  await expect(page.getByRole("heading", { name: "Recommended model", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Recommended model", exact: true })).toHaveValue("triage-model");
  await page.screenshot({ path: testInfo.outputPath("recommended-model-editor.png"), fullPage: true });
  await openMode(page, "Compose");
  await page.getByRole("button", { name: "Insert saved prompt…" }).click();
  await expect(page.getByRole("option", { name: /Triage/ })).toContainText("Recommended model: triage-model");
  await page.getByRole("button", { name: "More options…" }).click();
  await expect(page.getByRole("dialog", { name: "Insert saved prompt" })).toContainText("Recommended model: triage-model");
});

test("each inserted prompt warns independently, dismisses across navigation, and resets on model changes", async ({ page }) => {
  const first = await insert(page);
  const firstId = await first.getAttribute("data-template-use-id");
  const firstCard = page.locator(`[data-template-use-id="${firstId}"]`);
  await expect(firstCard).toContainText("This prompt recommends triage-model. You’re using buffered-test-model.");
  await expect(modelField(page)).toHaveValue("buffered-test-model");
  await expect(page.locator(".run-readiness-slot")).toHaveCount(0);
  await firstCard.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(firstCard.getByRole("status")).toHaveCount(0);
  const second = await insert(page);
  await expect(second).toContainText("This prompt recommends triage-model.");
  await expect(firstCard.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
  await openMode(page, "Prompts");
  await openMode(page, "Compose");
  await expect(firstCard.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
  await modelField(page).fill("another-model");
  await modelField(page).blur();
  await expect(firstCard).toContainText("You’re using another-model.");
  await firstCard.getByRole("button", { name: "Choose model", exact: true }).click();
  await expect(modelField(page)).toBeFocused();
  await modelField(page).fill("triage-model");
  await modelField(page).blur();
  await expect(firstCard.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
  await modelField(page).fill("buffered-test-model");
  await modelField(page).blur();
  await expect(firstCard).toContainText("You’re using buffered-test-model.");
});

test("recommendation edits restore dismissed warnings without creating a content revision or selecting a model", async ({ page }) => {
  const card = await insert(page);
  await card.getByRole("button", { name: "Dismiss", exact: true }).click();
  await openMode(page, "Prompts");
  const recommendation = page.getByRole("combobox", { name: "Recommended model", exact: true });
  await recommendation.fill("revised-model");
  await recommendation.blur();
  await expect(page.getByLabel("Revision", { exact: true }).locator("option")).toHaveCount(1);
  await openMode(page, "Compose");
  await expect(card).toContainText("This prompt recommends revised-model. You’re using buffered-test-model.");
  await expect(modelField(page)).toHaveValue("buffered-test-model");
});

test("the recommendation picker discovers models, accepts custom IDs, and can clear a recommendation", async ({ page }) => {
  await openMode(page, "Prompts");
  const model = page.getByRole("combobox", { name: "Recommended model", exact: true });
  await model.click();
  await page.getByRole("option", { name: "buffered-test-model", exact: true }).click();
  await expect(model).toHaveValue("buffered-test-model");
  await model.fill("custom-unlisted-model");
  await model.blur();
  await openMode(page, "Compose");
  const card = await insert(page);
  await expect(card).toContainText("This prompt recommends custom-unlisted-model.");
  await openMode(page, "Prompts");
  await page.getByRole("button", { name: "Remove recommendation" }).click();
  await expect(model).toHaveValue("");
  await openMode(page, "Compose");
  await expect(card.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
});

test("connection-only differences are described separately from model mismatches", async ({ page }) => {
  const project = fixture();
  const other = { ...project.connectionRequirements[0]!, id: "connection_other" as typeof project.connectionRequirements[number]["id"], name: "Other connection", endpoint: "http://127.0.0.1:44015/v1" };
  project.connectionRequirements.push(other);
  const changed = setPromptTemplateRecommendedTarget(project, project.promptTemplates[0]!.id, { connectionRequirementId: other.id, model: "buffered-test-model" });
  await importProject(page, changed, PROJECT_NAME);
  const card = await insert(page);
  await expect(card).toContainText("Recommended connection: Other connection");
  await expect(card).not.toContainText("This prompt recommends");
  await expect(card.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
  await expect(page.locator(".run-readiness-slot")).toHaveCount(0);
});

test("a narrow composer keeps the model warning and its actions within the viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const card = await insert(page);
  const warning = card.getByRole("status");
  await expect(warning).toContainText("You’re using buffered-test-model.");
  await warning.scrollIntoViewIfNeeded();
  await expect(warning.getByRole("button", { name: "Dismiss", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("narrow-model-warning.png"), fullPage: true });
});

test("export keeps the recommendation and pin while dismissals reset in a new page session", async ({ page }) => {
  const card = await insert(page);
  await card.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByLabel("Project menu").click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON copy…" }).click();
  const download = await downloading;
  const exported = parseProjectJson(await readFile((await download.path())!, "utf8"));
  expect(exported.promptTemplates).toEqual(fixture().promptTemplates);
  expect(exported.defaults.target.model).toBe("buffered-test-model");
  expect(exported.conversationRevisions.find(({ id }) => id === exported.defaults.conversationRevisionId)!.items.some((item) => item.kind === "template-use")).toBe(true);
  await page.reload();
  await waitForHydration(page);
  await importProject(page, exported, PROJECT_NAME);
  await expect(page.locator("[data-template-use-id]")).toContainText("This prompt recommends triage-model. You’re using buffered-test-model.");
});

test("manual recommendation entry works when model discovery fails", async ({ page }) => {
  await page.route("**/api/models", (route) => route.abort());
  await openMode(page, "Prompts");
  const model = page.getByRole("combobox", { name: "Recommended model", exact: true });
  await model.click();
  await expect(page.locator(".model-options-error")).toBeVisible();
  await model.fill("manual-model");
  await model.blur();
  await openMode(page, "Compose");
  const card = await insert(page);
  await expect(card).toContainText("This prompt recommends manual-model.");
  await openMode(page, "Prompts");
  await model.fill("");
  await model.blur();
  await openMode(page, "Compose");
  await expect(card.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
});

test("the recommendation editor and its catalogue fit a narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMode(page, "Prompts");
  const model = page.getByRole("combobox", { name: "Recommended model", exact: true });
  await model.click();
  const option = page.getByRole("option", { name: "buffered-test-model", exact: true });
  await expect(option).toBeVisible();
  await option.scrollIntoViewIfNeeded();
  await expect(option).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("narrow-recommended-model-editor.png"), fullPage: true });
});
