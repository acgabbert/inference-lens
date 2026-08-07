import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  appendPromptTemplateRevision,
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import type { EvaluationSuiteId, PromptTemplateId } from "../../packages/core/src/run-kernel";
import {
  createEvaluationSuite,
  createRevisionFromSavedPrompt,
  updateEvaluationSuiteInput,
} from "../../packages/core/src/evaluation-suite-authoring";
import { BUFFERED_FIXTURE_ENDPOINT, importProject, openMode, seedProfile, waitForHydration } from "./support";

const PROJECT_NAME = "Evaluate in a suite fixture";

function baseProject(): ProjectFile {
  return createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "evaluate-in-suite",
    createdAt: "2026-08-06T12:00:00.000Z",
  });
}

/** A template with two revisions and a suite pinning the older one. */
function withOutdatedSuite(
  project: ProjectFile,
  { templateName, suiteName, templateSuffix, suiteSuffix }: { templateName: string; suiteName: string; templateSuffix: string; suiteSuffix: string },
): { project: ProjectFile; templateId: PromptTemplateId; suiteId: EvaluationSuiteId } {
  let next = createPromptTemplate(project, {
    name: templateName,
    messages: [{ role: "user", content: `Reply to {{ticket}} about ${templateName}.` }],
    variableDefaults: { ticket: "billing" },
    idSuffix: templateSuffix,
    createdAt: "2026-08-06T12:00:01.000Z",
  });
  const template = next.promptTemplates.find(({ name }) => name === templateName)!;
  const firstRevisionId = template.currentRevisionId;
  next = appendPromptTemplateRevision(next, {
    templateId: template.id,
    messages: [{ role: "user", content: `Reply kindly to {{ticket}} about ${templateName}.` }],
    variableDefaults: { ticket: "billing" },
    idSuffix: `${templateSuffix}-2`,
    createdAt: "2026-08-06T12:00:02.000Z",
  });

  const created = createEvaluationSuite(next, suiteName, () => suiteSuffix);
  next = created.project;
  const pinned = createRevisionFromSavedPrompt(next, {
    parentRevisionId: next.defaults.conversationRevisionId,
    templateId: template.id,
    templateRevisionId: firstRevisionId,
    revisionIdSuffix: `${suiteSuffix}-input`,
    templateUseIdSuffix: `${suiteSuffix}-use`,
  });
  next = updateEvaluationSuiteInput(pinned.project, created.suiteId, pinned.conversationRevisionId);

  return { project: next, templateId: template.id, suiteId: created.suiteId };
}

async function openPromptsTab(page: Page): Promise<void> {
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Prompts/ }).click();
}

test("evaluate-in-a-suite dialog states the pinned revision, and arrival confirms the pin", async ({ page }) => {
  const built = withOutdatedSuite(baseProject(), {
    templateName: "Support reply",
    suiteName: "Support QA",
    templateSuffix: "support-reply",
    suiteSuffix: "support-qa",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, built.project, PROJECT_NAME);
  await openPromptsTab(page);

  const editor = page.locator(".template-editor");
  await page.locator(".template-list").getByRole("button", { name: /Support reply/ }).click();
  await editor.getByRole("button", { name: "Evaluate in a suite…" }).click();

  const dialog = page.getByRole("dialog", { name: "Evaluate in a suite" });
  await expect(dialog.getByText("Nothing runs until you start the evaluation.")).toBeVisible();
  await expect(dialog.getByText("Support QA — currently Revision 1 → will pin Current")).toBeVisible();
  await dialog.getByRole("button", { name: "Use Support QA" }).click();

  const evaluationsButton = page.getByRole("navigation", { name: "Application mode" }).getByRole("button", { name: "Evaluations" });
  await expect(evaluationsButton).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".evaluation-resolution-action", { hasText: "Input pinned to Support reply · Current" })).toBeVisible();
  await expect(page.locator("h2", { hasText: "Support QA" })).toBeVisible();

  // The suite now pins the current revision: reopening the dialog on the same
  // revision must offer Open (a plain navigation), not another retarget.
  await openPromptsTab(page);
  await page.locator(".template-list").getByRole("button", { name: /Support reply/ }).click();
  await editor.getByRole("button", { name: "Evaluate in a suite…" }).click();
  await expect(dialog.getByText("Support QA — already pinned to this revision")).toBeVisible();
  await dialog.getByRole("button", { name: "Open" }).click();
  await expect(evaluationsButton).toHaveAttribute("aria-current", "page");
  await expect(page.locator("h2", { hasText: "Support QA" })).toBeVisible();
});

test("creating a new suite from the dialog names it after the prompt", async ({ page }) => {
  const project = createPromptTemplate(baseProject(), {
    name: "Escalation note",
    messages: [{ role: "user", content: "Escalate {{issue}}." }],
    variableDefaults: { issue: "outage" },
    idSuffix: "escalation-note",
    createdAt: "2026-08-06T12:00:01.000Z",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, PROJECT_NAME);
  await openPromptsTab(page);

  const editor = page.locator(".template-editor");
  await page.locator(".template-list").getByRole("button", { name: /Escalation note/ }).click();
  await editor.getByRole("button", { name: "Evaluate in a suite…" }).click();

  const dialog = page.getByRole("dialog", { name: "Evaluate in a suite" });
  await expect(dialog.getByRole("button", { name: /^Use / })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create new suite" }).click();

  const evaluationsButton = page.getByRole("navigation", { name: "Application mode" }).getByRole("button", { name: "Evaluations" });
  await expect(evaluationsButton).toHaveAttribute("aria-current", "page");
  await expect(page.locator("h2", { hasText: "Escalation note evaluation" })).toBeVisible();
});

test("the dialog renders as a real modal overlay, not an unstyled inline block", async ({ page }) => {
  const built = withOutdatedSuite(baseProject(), {
    templateName: "Support reply",
    suiteName: "Support QA",
    templateSuffix: "support-reply",
    suiteSuffix: "support-qa",
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, built.project, PROJECT_NAME);
  await openPromptsTab(page);

  const editor = page.locator(".template-editor");
  await page.locator(".template-list").getByRole("button", { name: /Support reply/ }).click();
  await editor.getByRole("button", { name: "Evaluate in a suite…" }).click();

  const dialog = page.getByRole("dialog", { name: "Evaluate in a suite" });
  await expect(dialog).toBeVisible();

  // The backdrop must actually cover the viewport as a fixed overlay — an
  // unstyled backdrop class renders inline in normal document flow, where it
  // is easy to miss entirely and never blocks the page behind it.
  const backdrop = page.locator(".confirmation-backdrop");
  await expect(backdrop).toHaveCSS("position", "fixed");
  const box = await backdrop.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(1279);
  expect(box?.height).toBeGreaterThanOrEqual(899);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
