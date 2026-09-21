import { expect, test } from "@playwright/test";

import {
  appendPromptTemplateRevision,
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

const PROJECT_NAME = "Template update latest fixture";

function templateWithNewerRevision() {
  let project = createPromptTemplate(
    createProjectFile({
      name: PROJECT_NAME,
      request: {
        provider: "openai-compatible",
        endpoint: BUFFERED_FIXTURE_ENDPOINT,
        model: "buffered-test-model",
        messages: [{ role: "user", content: "Unused draft" }],
      },
      idSuffix: "template-update-latest",
      createdAt: "2026-08-11T12:00:00.000Z",
    }),
    {
      name: "Incident prompt",
      messages: [{ role: "user", content: "Investigate {{topic}} for {{audience}}." }],
      variableDefaults: {},
      idSuffix: "incident",
      revisionIdSuffix: "incident-1",
      createdAt: "2026-08-11T12:00:01.000Z",
    },
  );
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.conversationRevisions[0]!.id,
    templateId: "template_incident",
    values: {},
    idSuffix: "incident",
    outputMessageIdSuffixes: ["incident"],
  });
  return appendPromptTemplateRevision(project, {
    templateId: "template_incident",
    messages: [{ role: "user", content: "Carefully investigate {{topic}} for {{audience}}." }],
    variableDefaults: {},
    idSuffix: "incident-2",
    createdAt: "2026-08-11T12:00:02.000Z",
  });
}

test("updating a template use retains entered values for variables in the latest revision", async ({
  page,
}) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, templateWithNewerRevision(), PROJECT_NAME);

  const templateUse = page.locator(".template-use-card");
  await templateUse.locator('textarea[data-template-variable="topic"]').fill("database rollback");
  await templateUse.locator('textarea[data-template-variable="audience"]').fill("on-call team");
  await templateUse.getByRole("button", { name: "Review latest" }).click();

  const confirmation = page.getByRole("dialog", { name: 'Update "Incident prompt"?' });
  await confirmation.getByRole("button", { name: "Update to latest" }).click();

  await expect(templateUse.locator('textarea[data-template-variable="topic"]')).toHaveValue(
    "database rollback",
  );
  await expect(templateUse.locator('textarea[data-template-variable="audience"]')).toHaveValue(
    "on-call team",
  );
});
