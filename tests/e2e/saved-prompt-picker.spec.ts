import { expect, test, type Page } from "@playwright/test";

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

const PROJECT_NAME = "Saved prompt picker fixture";

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
      idSuffix: "saved-prompt-picker",
      createdAt: "2026-10-27T12:00:00.000Z",
    }),
    {
      name: "Incident triage",
      messages: [{ role: "user", content: "ORIGINAL REVISION: investigate {{incident}}." }],
      variableDefaults: {},
      idSuffix: "incident-triage",
      revisionIdSuffix: "incident-triage-1",
      createdAt: "2026-10-27T12:01:00.000Z",
    },
  );
  project = appendPromptTemplateRevision(project, {
    templateId: project.promptTemplates[0]!.id,
    messages: [{ role: "user", content: "CURRENT REVISION: diagnose {{incident}} in {{service}}." }],
    variableDefaults: {},
    idSuffix: "incident-triage-2",
    createdAt: "2026-10-27T12:02:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Release notes",
    messages: [{ role: "user", content: "Summarize this release." }],
    idSuffix: "release-notes",
    revisionIdSuffix: "release-notes-1",
    createdAt: "2026-10-27T12:03:00.000Z",
  });
  // Names are not identities: a second "Release notes" is allowed, so each
  // row has to say enough to tell the two apart.
  return createPromptTemplate(project, {
    name: "Release notes",
    messages: [{ role: "user", content: "Summarize {{version}} for customers." }],
    idSuffix: "release-notes-customer",
    revisionIdSuffix: "release-notes-customer-1",
    createdAt: "2026-10-27T12:04:00.000Z",
  });
}

function emptyDraftFixture() {
  return createPromptTemplate(
    createProjectFile({
      name: "Empty draft picker fixture",
      request: {
        provider: "openai-compatible",
        endpoint: BUFFERED_FIXTURE_ENDPOINT,
        model: "buffered-test-model",
        messages: [{ role: "user", content: "" }],
      },
      idSuffix: "empty-draft-picker",
      createdAt: "2026-10-27T12:00:00.000Z",
    }),
    {
      name: "Fresh start",
      messages: [{ role: "user", content: "Start from the saved prompt." }],
      idSuffix: "fresh-start",
      revisionIdSuffix: "fresh-start-1",
      createdAt: "2026-10-27T12:01:00.000Z",
    },
  );
}

function emptyLibraryFixture() {
  return createProjectFile({
    name: "Empty library picker fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Nothing saved yet." }],
    },
    idSuffix: "empty-library-picker",
    createdAt: "2026-10-27T12:00:00.000Z",
  });
}

const trigger = (page: Page) => page.getByRole("button", { name: "Insert saved prompt…" });
const search = (page: Page) => page.getByRole("combobox", { name: "Search saved prompts" });
const items = (page: Page) => page.locator(".message-list > article");
// Scoped: the page's native <select>s expose their own options.
const options = (page: Page) => page.getByRole("listbox", { name: "Saved prompts" }).getByRole("option");

test.beforeEach(async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), PROJECT_NAME);
  await expect(page.getByRole("button", { name: /^Run current conversation/ })).toBeVisible();
});

test("typing a name and pressing Enter inserts its current revision at the end", async ({ page }) => {
  await trigger(page).click();
  await expect(search(page)).toBeFocused();
  await search(page).fill("incid");
  await expect(options(page)).toHaveCount(1);
  await search(page).press("Enter");

  await expect(page.getByRole("listbox", { name: "Saved prompts" })).toHaveCount(0);
  await expect(items(page)).toHaveCount(2);
  await expect(items(page).first()).toContainText("Keep this instruction first.");
  await expect(items(page).last()).toHaveClass(/template-use-card/);
  await expect(items(page).last()).toContainText("CURRENT REVISION: diagnose {{incident}} in {{service}}.");
  await expect(items(page).last().locator('textarea[data-template-variable="incident"]')).toBeFocused();
});

test("arrow keys move the highlight and a click inserts the row it lands on", async ({ page }) => {
  await trigger(page).click();
  await expect(options(page)).toHaveCount(3);
  await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await search(page).press("ArrowDown");
  await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await search(page).press("ArrowUp");
  await search(page).press("ArrowUp");
  await expect(options(page).nth(2)).toHaveAttribute("aria-selected", "true");

  await options(page).nth(2).click();
  await expect(items(page)).toHaveCount(2);
  await expect(items(page).last()).toContainText("Summarize {{version}} for customers.");
});

test("rows sharing a name are told apart by revision and value count", async ({ page }) => {
  await trigger(page).click();
  await search(page).fill("release");
  await expect(options(page)).toHaveCount(2);
  await expect(options(page).nth(0)).toContainText("Release notes");
  await expect(options(page).nth(0)).toContainText("Revision 1 · no values");
  await expect(options(page).nth(1)).toContainText("Release notes");
  await expect(options(page).nth(1)).toContainText("Revision 1 · 1 value");

  await search(page).fill("incident");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toContainText("Revision 2 · 2 values");
});

test("Escape closes without inserting and returns focus to the trigger", async ({ page }) => {
  await trigger(page).click();
  await search(page).fill("release");
  await search(page).press("Escape");

  await expect(search(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  await expect(items(page)).toHaveCount(1);
});

test("clicking elsewhere closes the picker without inserting", async ({ page }) => {
  await trigger(page).click();
  await expect(search(page)).toBeVisible();
  await page.locator(".message-list").click({ position: { x: 4, y: 4 } });

  await expect(search(page)).toHaveCount(0);
  await expect(items(page)).toHaveCount(1);
});

test("a query that matches nothing says so and Enter does nothing", async ({ page }) => {
  await trigger(page).click();
  await search(page).fill("zzz");
  await expect(options(page)).toHaveCount(0);
  await expect(page.getByText("No prompts match “zzz”.")).toBeVisible();
  await search(page).press("Enter");
  await expect(search(page)).toBeVisible();
  await expect(items(page)).toHaveCount(1);
});

test("More options opens the full dialog carrying the query and highlighted prompt", async ({ page }) => {
  await trigger(page).click();
  await search(page).fill("release");
  await search(page).press("ArrowDown");
  await page.getByRole("button", { name: "More options…" }).click();

  const dialog = page.getByRole("dialog", { name: "Insert saved prompt" });
  await expect(dialog.getByRole("searchbox", { name: "Search prompts" })).toHaveValue("release");
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await expect(dialog.getByRole("radio").nth(1)).toBeChecked();
  await expect(dialog.getByText("Summarize {{version}} for customers.", { exact: true })).toBeVisible();
});

test("Shift+Enter opens the full dialog on the highlighted prompt", async ({ page }) => {
  await trigger(page).click();
  await search(page).fill("incident");
  await search(page).press("Shift+Enter");

  const dialog = page.getByRole("dialog", { name: "Insert saved prompt" });
  await expect(dialog.getByRole("radio", { name: "Incident triage" })).toBeChecked();
  await dialog.getByLabel("Revision").selectOption("template-revision_incident-triage-1");
  await dialog.getByRole("button", { name: "Insert prompt", exact: true }).click();
  await expect(items(page).last()).toContainText("ORIGINAL REVISION: investigate {{incident}}.");
});

test("a quick insert replaces an entirely empty draft", async ({ page }) => {
  await importProject(page, emptyDraftFixture(), "Empty draft picker fixture");
  await trigger(page).click();
  await search(page).press("Enter");

  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toHaveClass(/template-use-card/);
  await expect(items(page).first()).toContainText("Start from the saved prompt.");
});

test("an empty library offers the way to Prompts instead of a search", async ({ page }) => {
  await importProject(page, emptyLibraryFixture(), "Empty library picker fixture");
  await trigger(page).click();

  await expect(search(page)).toHaveCount(0);
  await expect(page.getByText("This project has no active saved prompts.")).toBeVisible();
  await page.getByRole("button", { name: "Open Prompts" }).click();
  await expect(page.getByRole("button", { name: "Prompts", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});
