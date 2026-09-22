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
  openMode,
  seedProfile,
  waitForHydration,
} from "./support";

const PROJECT_NAME = "Prompt workspace fixture";

function fixture() {
  let project = createPromptTemplate(
    createProjectFile({
      name: PROJECT_NAME,
      request: {
        provider: "openai-compatible",
        endpoint: BUFFERED_FIXTURE_ENDPOINT,
        model: "buffered-test-model",
        messages: [{ role: "system", content: "Keep this request draft." }],
      },
      idSuffix: "prompt-workspace",
      createdAt: "2026-09-21T12:00:00.000Z",
    }),
    {
      name: "Incident triage",
      messages: [{ role: "user", content: "ORIGINAL: investigate {{incident}}." }],
      variableDefaults: {},
      idSuffix: "incident-triage",
      revisionIdSuffix: "incident-triage-1",
      createdAt: "2026-09-21T12:01:00.000Z",
    },
  );
  project = appendPromptTemplateRevision(project, {
    templateId: project.promptTemplates[0]!.id,
    messages: [{ role: "user", content: "LATEST: diagnose {{incident}}." }],
    variableDefaults: {},
    idSuffix: "incident-triage-2",
    createdAt: "2026-09-21T12:02:00.000Z",
  });
  return insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: project.promptTemplates[0]!.id,
    templateRevisionId: project.promptTemplates[0]!.revisions[0]!.id,
    itemIndex: 1,
    idSuffix: "originating-use",
  });
}

test.beforeEach(async ({ page }) => {
  await seedProfile(page);
  await page.setViewportSize({ width: 880, height: 720 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), PROJECT_NAME);
});

test("Prompts is a full-width top-level authoring workspace", async ({ page }) => {
  await openMode(page, "Prompts");

  const workspace = page.locator(".templates-workspace");
  await expect(workspace).toBeVisible();
  await expect(page.locator(".composer")).toHaveCount(0);
  await expect(page.locator(".result")).toHaveCount(0);

  const layout = await workspace.evaluate((element) => {
    const main = element.closest("main");
    if (!main) throw new Error("Prompt workspace is not inside main");
    return {
      workspaceWidth: element.getBoundingClientRect().width,
      mainWidth: main.getBoundingClientRect().width,
    };
  });
  expect(layout.workspaceWidth).toBeGreaterThan(layout.mainWidth * 0.9);
});

test("the selected prompt workspace survives mode navigation", async ({ page }) => {
  await openMode(page, "Prompts");
  await page.getByRole("button", { name: "New prompt", exact: true }).click();
  await page.getByLabel("Prompt content").fill("PRESERVE THIS WORKSPACE");

  await openMode(page, "Runs");
  await openMode(page, "Prompts");

  await expect(page.getByLabel("Prompt name")).toHaveValue("Untitled prompt");
  await expect(page.getByLabel("Prompt content")).toHaveValue(
    "PRESERVE THIS WORKSPACE",
  );
  await expect(
    page.locator(".template-list").getByRole("button", { name: /Untitled prompt/ }),
  ).toHaveAttribute("aria-current", "true");
});

test("editing a pinned source returns to the exact request use", async ({ page }) => {
  const useCard = page.locator('[data-template-use-id="template-use_originating-use"]');
  await useCard.locator('textarea[data-template-variable="incident"]').fill("INC-42");

  await useCard.getByRole("button", { name: "Edit source" }).click();

  await expect(page.getByRole("button", { name: "Prompts" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByLabel("Prompt name")).toHaveValue("Incident triage");
  await expect(page.locator(".template-revision-field select")).toHaveValue(
    "template-revision_incident-triage-1",
  );
  await expect(page.getByLabel("Prompt content")).toHaveValue(
    "ORIGINAL: investigate {{incident}}.",
  );

  await page.getByRole("button", { name: "Back to request" }).click();

  await expect(page.getByRole("button", { name: "Compose", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(useCard).toBeFocused();
  await expect(useCard.locator('textarea[data-template-variable="incident"]')).toHaveValue(
    "INC-42",
  );
  await expect(useCard).toContainText("Revision 1");
});
