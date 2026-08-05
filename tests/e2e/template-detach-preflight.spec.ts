import { expect, test } from "@playwright/test";

import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
} from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  seedProfile,
  waitForHydration,
} from "./support";

const PROJECT_NAME = "Unresolved template detach fixture";

function unresolvedTemplateUseProject() {
  const project = createPromptTemplate(
    createProjectFile({
      name: PROJECT_NAME,
      request: {
        provider: "openai-compatible",
        endpoint: BUFFERED_FIXTURE_ENDPOINT,
        model: "buffered-test-model",
        messages: [{ role: "user", content: "Unused draft" }],
      },
      idSuffix: "unresolved-detach",
      createdAt: "2026-08-05T12:00:00.000Z",
    }),
    {
      name: "Topic prompt",
      messages: [{ role: "user", content: "Explain {{topic}}." }],
      variableDefaults: {},
      idSuffix: "topic",
      createdAt: "2026-08-05T12:00:01.000Z",
    },
  );
  return insertPromptTemplateUse(project, {
    conversationRevisionId: project.conversationRevisions[0]!.id,
    templateId: "template_topic",
    values: {},
    idSuffix: "topic",
    outputMessageIdSuffixes: ["topic"],
  });
}

test("refuses an unresolved template detach without an unhandled error", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, unresolvedTemplateUseProject(), PROJECT_NAME);

  const templateUse = page.locator(".template-use-card");
  await templateUse.getByRole("button", { name: "Detach" }).click();
  const confirmation = page.getByRole("dialog", { name: "Detach this template use?" });
  await confirmation.getByRole("button", { name: "Detach" }).click();

  const error = page.locator('[data-app-banner="project-error"]');
  await expect(error).toBeVisible();
  await expect(error).toContainText(
    'Resolve this template use before detaching it: Template variable "topic" has no value.',
  );
  await expect(templateUse).toBeVisible();
});
