import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { appendDecisionPromptTemplateRevision, createDecisionPromptTemplate } from "../../packages/core/src/decision-template";
import { createProjectFile, serializeProjectFile, setPromptTemplateRecommendedTarget } from "../../packages/core/src/project";
import { BUFFERED_FIXTURE_ENDPOINT, SYSTEM_ONE_FIXTURE_ORIGIN, importProject, openMode, seedProfile, seedProfiles, stubProjectDirectory, waitForHydration } from "./support";

const capture = JSON.parse(readFileSync(new URL("../fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8")).request;

// A pinned historical revision with an unavailable recommendation stacks the
// readiness chip, the pin and its actions above the editor: on a short window
// that chrome must not leave the questions and variables out of reach.
test("a short window still scrolls a pinned decision request to its last question and variables", async ({ page }) => {
  let project = createProjectFile({ name: "Scroll decisions", idSuffix: "scroll-decisions", request: {
    provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model",
    messages: [{ role: "user", content: "Hello" }],
  } });
  project = createDecisionPromptTemplate(project, { name: "Ticket decision", decision: { state: "{{ticket}}", questions: capture.questions }, variableDefaults: { ticket: "Default ticket" }, idSuffix: "ticket-decision" });
  const template = project.promptTemplates[0]!;
  project = appendDecisionPromptTemplateRevision(project, { templateId: template.id, decision: { state: "New {{ticket}}", questions: capture.questions }, variableDefaults: { ticket: "New default" } });
  project = setPromptTemplateRecommendedTarget(project, template.id, { connectionRequirementId: project.connectionRequirements[0]!.id, model: "recommended-model" });
  await page.setViewportSize({ width: 1280, height: 560 });
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Scroll decisions");
  await openMode(page, "Prompts");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await page.getByLabel("Revision", { exact: true }).selectOption(template.revisions[0]!.id);
  await page.getByRole("button", { name: "Use Revision 1", exact: true }).click();
  const pane = page.getByRole("region", { name: "Decision request", exact: true });
  await expect(pane.getByRole("region", { name: "Saved decision prompt" })).toBeVisible();

  const paneBox = (await pane.boundingBox())!;
  const lastQuestion = pane.locator(".decision-question").last();
  const variables = pane.getByRole("region", { name: "Variables", exact: true });
  for (const target of [lastQuestion.getByLabel("Question id"), variables.getByLabel("{{ticket}}")]) {
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    expect(box.y + box.height, `control bottom ${box.y + box.height} vs pane bottom ${paneBox.y + paneBox.height}`)
      .toBeLessThanOrEqual(paneBox.y + paneBox.height);
    expect(box.y).toBeGreaterThanOrEqual(paneBox.y);
  }
});

// A run switches the workbench to its response view, which only the narrow
// layout acts on. On a wide window the request pane stays on screen and must
// keep fitting under the request-kind bar, or its bottom edge — and the end of
// its scrollbar — is clipped until something switches the view back.
async function expectComposerFitsPane(page: Page, composer: Locator): Promise<void> {
  const pane = (await page.locator(".request-pane").boundingBox())!;
  const box = (await composer.boundingBox())!;
  expect(Math.round(box.y + box.height), "composer bottom against request pane bottom")
    .toBeLessThanOrEqual(Math.round(pane.y + pane.height));
}

test("after a decision run the wide request pane still fits its composer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await seedProfiles(page, [
    { id: "buffered", instanceId: "buffered", name: "Buffered fixture", endpoint: BUFFERED_FIXTURE_ENDPOINT },
    { id: "decisions", instanceId: "decisions", name: "Decision fixture", endpoint: `${SYSTEM_ONE_FIXTURE_ORIGIN}/llamacpp/v1`, systemOne: true },
  ], "buffered");
  let project = createProjectFile({ name: "Run decisions", idSuffix: "run-decisions", request: {
    provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model",
    messages: [{ role: "user", content: "Hello" }],
  } });
  project = createDecisionPromptTemplate(project, { name: "Ticket decision", decision: { state: "{{ticket}}", questions: capture.questions }, variableDefaults: { ticket: "Default ticket" }, idSuffix: "ticket-decision" });
  await stubProjectDirectory(page, { name: "run-decisions.inference-lens", files: { "project.json": serializeProjectFile(project) } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Run decisions");
  await openMode(page, "Prompts");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await page.getByRole("button", { name: "Use Current", exact: true }).click();
  const composer = page.getByRole("region", { name: "Decision request", exact: true });
  const model = composer.getByRole("combobox", { name: "Model", exact: true });
  await model.fill("all-types");
  await model.press("Escape");
  await expectComposerFitsPane(page, composer);
  await page.getByRole("button", { name: /^Run decision/ }).click();
  await expect(page.getByRole("article", { name: "Answer intent" })).toContainText("Choice billing");
  await expectComposerFitsPane(page, composer);
});

test("after a chat run the wide request pane still fits its composer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  const composer = page.locator(".request-pane > .composer");
  await page.getByLabel("Message 1 content").fill("Hello");
  await expectComposerFitsPane(page, composer);
  await page.getByRole("button", { name: "Run current conversation ⌘↵" }).click();
  await expect(page.locator(".response-pane")).toContainText(/\S/);
  await expect(page.getByRole("button", { name: "Run current conversation ⌘↵" })).toBeEnabled();
  await expectComposerFitsPane(page, composer);
});
