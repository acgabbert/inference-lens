import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createProjectFile, setPromptTemplateRecommendedTarget } from "../../packages/core/src/project";
import { appendDecisionPromptTemplateRevision, createDecisionPromptTemplate } from "../../packages/core/src/decision-template";
import { BUFFERED_FIXTURE_ENDPOINT, importProject, openMode, seedProfile, waitForHydration } from "./support";

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
