import { expect, test } from "@playwright/test";

import {
  appendPromptTemplateRevision,
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  seedProfile,
  waitForHydration,
} from "./support";

const PROJECT_NAME = "Prompt insertion handoff fixture";

function fixture() {
  let project = createPromptTemplate(
    createProjectFile({
      name: PROJECT_NAME,
      request: {
        provider: "openai-compatible",
        endpoint: BUFFERED_FIXTURE_ENDPOINT,
        model: "buffered-test-model",
        messages: [{ role: "system", content: "Keep this instruction first." }],
      },
      idSuffix: "prompt-insertion-handoff",
      createdAt: "2026-09-21T12:00:00.000Z",
    }),
    {
      name: "Incident triage",
      messages: [{ role: "user", content: "ORIGINAL REVISION: investigate {{incident}}." }],
      variableDefaults: {},
      idSuffix: "incident-triage",
      revisionIdSuffix: "incident-triage-1",
      createdAt: "2026-09-21T12:01:00.000Z",
    },
  );
  project = appendPromptTemplateRevision(project, {
    templateId: project.promptTemplates[0]!.id,
    messages: [{ role: "user", content: `CURRENT REVISION: diagnose {{incident}}.\n${"Preview detail.\n".repeat(120)}` }],
    variableDefaults: {},
    idSuffix: "incident-triage-2",
    createdAt: "2026-09-21T12:02:00.000Z",
  });
  return createPromptTemplate(project, {
    name: "Release notes",
    messages: [{ role: "user", content: "Summarize this release." }],
    idSuffix: "release-notes",
    revisionIdSuffix: "release-notes-1",
    createdAt: "2026-09-21T12:03:00.000Z",
  });
}

function emptyDraftFixture() {
  return createPromptTemplate(
    createProjectFile({
      name: "Empty prompt insertion fixture",
      request: {
        provider: "openai-compatible",
        endpoint: BUFFERED_FIXTURE_ENDPOINT,
        model: "buffered-test-model",
        messages: [{ role: "user", content: "" }],
      },
      idSuffix: "empty-prompt-insertion",
      createdAt: "2026-09-21T12:00:00.000Z",
    }),
    {
      name: "Fresh start",
      messages: [{ role: "user", content: "Start from the saved prompt." }],
      idSuffix: "fresh-start",
      revisionIdSuffix: "fresh-start-1",
      createdAt: "2026-09-21T12:01:00.000Z",
    },
  );
}

test.beforeEach(async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), PROJECT_NAME);
});

test("Messages inserts a searched exact prompt revision at the chosen position", async ({ page }) => {
  await expect(page.getByRole("button", { name: /^Run current conversation/ })).toBeVisible();

  await page.getByRole("button", { name: "Insert saved prompt…" }).click();
  const dialog = page.getByRole("dialog", { name: "Insert saved prompt" });

  await dialog.getByRole("searchbox", { name: "Search prompts" }).fill("incident");
  await expect(dialog.getByText("Incident triage", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Release notes", { exact: true })).toHaveCount(0);

  await dialog.getByLabel("Revision").selectOption("template-revision_incident-triage-1");
  await expect(dialog.getByText("ORIGINAL REVISION: investigate {{incident}}.", { exact: true }))
    .toBeVisible();
  await dialog.getByLabel("Position").selectOption("0");
  await dialog.getByRole("button", { name: "Insert prompt", exact: true }).click();

  const items = page.locator(".message-list > article");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveClass(/template-use-card/);
  await expect(items.first()).toContainText("Revision 1");
  await expect(items.first()).toContainText("ORIGINAL REVISION: investigate {{incident}}.");
  await expect(items.first().locator('textarea[data-template-variable="incident"]')).toBeFocused();
});

test("Messages keeps the saved-prompt control labels compact", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Insert saved prompt" });
  await page.getByRole("button", { name: "Insert saved prompt…" }).click();

  await dialog.getByLabel("Revision").selectOption("template-revision_incident-triage-2");
  await expect(dialog.getByLabel("Revision").locator(".."))
    .toHaveCSS("margin-bottom", "0px");
});

test("Messages keeps the insertion action visible with a long prompt preview", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  const dialog = page.getByRole("dialog", { name: "Insert saved prompt" });
  await page.getByRole("button", { name: "Insert saved prompt…" }).click();

  await expect(dialog.getByRole("button", { name: "Insert prompt", exact: true })).toBeInViewport();
});

test("Messages replaces an entirely empty draft with the saved prompt", async ({ page }) => {
  await importProject(page, emptyDraftFixture(), "Empty prompt insertion fixture");
  await page.getByRole("button", { name: "Insert saved prompt…" }).click();
  const dialog = page.getByRole("dialog", { name: "Insert saved prompt" });

  await expect(dialog.getByText("The empty draft will be replaced.")).toBeVisible();
  await dialog.getByRole("button", { name: "Insert prompt", exact: true }).click();

  const items = page.locator(".message-list > article");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveClass(/template-use-card/);
  await expect(items.first()).toContainText("Start from the saved prompt.");
});
