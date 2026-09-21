import { expect, test } from "@playwright/test";

import {
  appendPromptTemplateRevision,
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openMode,
  seedProfile,
  waitForHydration,
} from "./support";

function promptProject() {
  let project = createProjectFile({
    name: "Prompt draft retention",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Explain the result." }],
    },
    idSuffix: "prompt-draft-retention",
    createdAt: "2026-09-20T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "incident-triage",
    revisionIdSuffix: "incident-triage-1",
    createdAt: "2026-09-20T12:01:00.000Z",
  });
  return appendPromptTemplateRevision(project, {
    templateId: project.promptTemplates[0]!.id,
    messages: [{ role: "user", content: "Triage {{incident}} carefully." }],
    variableDefaults: { incident: "latency" },
    idSuffix: "incident-triage-2",
    createdAt: "2026-09-20T12:02:00.000Z",
  });
}

test.beforeEach(async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, promptProject(), "Prompt draft retention");
  await page.getByRole("tab", { name: /Prompts/ }).click();
});

test("keeps the exact prompt draft across request navigation", async ({ page }) => {
  const content = page.getByLabel("Prompt content", { exact: true });
  await content.fill("SESSION DRAFT: keep {{incident}} exactly");

  await expect(page.locator(".brand")).toContainText("Unsaved");
  await openMode(page, "Evaluations");
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await expect(content).toHaveValue("SESSION DRAFT: keep {{incident}} exactly");

  await page.getByRole("tab", { name: /Tools/ }).click();
  await page.getByRole("tab", { name: /Prompts/ }).click();

  await expect(content).toHaveValue("SESSION DRAFT: keep {{incident}} exactly");
  await expect(page.locator(".template-revision-field select")).toHaveValue("draft");
});

test("the Save shortcut in the prompt editor creates the visible revision", async ({ page }) => {
  const content = page.getByLabel("Prompt content", { exact: true });
  await content.fill("SAVED REVISION: preserve {{incident}}");
  await content.press("ControlOrMeta+s");

  await expect(page.locator(".template-revision-field select")).not.toHaveValue("draft");
  await expect(page.locator(".template-revision-field select option")).toHaveCount(3);
  await expect(content).toHaveValue("SAVED REVISION: preserve {{incident}}");
  await expect(page.getByText("Save project", { exact: true })).toHaveCount(0);
});
