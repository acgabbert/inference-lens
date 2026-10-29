import { expect, test } from "./support/test";

import {
  appendPromptTemplateRevision,
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import { BUFFERED_FIXTURE_ENDPOINT, importProject, seedProfile, waitForHydration, openMode } from "./support";

test("a historical prompt revision can be edited into a new revision with an exact diff", async ({ page }) => {
  let project = createProjectFile({
    name: "Saved prompt revision fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "saved-prompt-revision",
    createdAt: "2026-08-06T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "triage",
    createdAt: "2026-08-06T12:00:01.000Z",
  });
  const firstRevisionId = project.promptTemplates[0]!.currentRevisionId;
  project = appendPromptTemplateRevision(project, {
    templateId: project.promptTemplates[0]!.id,
    messages: [{ role: "user", content: "Triage {{incident}} carefully." }],
    variableDefaults: { incident: "latency" },
    createdAt: "2026-08-06T12:00:02.000Z",
    idSuffix: "triage-2",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Saved prompt revision fixture");
  await openMode(page, "Prompts");

  const editor = page.locator(".template-editor");
  const diff = editor.getByRole("region", { name: "Revision diff" });
  const diffToggle = diff.getByRole("button", { name: /Revision diff/ });

  await expect(editor.getByRole("button", { name: "Edit as new revision" })).toHaveCount(0);
  // Editing the current draft: the diff starts collapsed, not competing with the editor.
  await expect(diffToggle).toHaveAttribute("aria-expanded", "false");

  await editor.locator(".template-revision-field select").selectOption(firstRevisionId);
  await expect(editor).toContainText("Read-only revision");
  await expect(editor).toContainText(
    "Copies this revision into an editable draft. Nothing changes until you save.",
  );
  // Browsing a historical revision is history-inspection intent: opens by default.
  await expect(diffToggle).toHaveAttribute("aria-expanded", "true");

  await editor.getByRole("button", { name: "Edit as new revision" }).click();
  await expect(editor.getByRole("button", { name: "Edit as new revision" })).toHaveCount(0);
  await expect(editor).not.toContainText(
    "Copies this revision into an editable draft. Nothing changes until you save.",
  );
  // Editing state collapses it again.
  await expect(diffToggle).toHaveAttribute("aria-expanded", "false");

  await editor.getByLabel("Prompt content").fill("Triage {{incident}} for the on-call engineer.");
  await editor.getByLabel("{{incident}}").fill("database outage");
  await editor.getByRole("button", { name: "Create revision", exact: true }).click();

  // A save forces the diff open once, to confirm what just changed.
  await expect(diffToggle).toHaveAttribute("aria-expanded", "true");
  await expect(diffToggle).toContainText("vs Revision 1");
  await expect(diff).toContainText("Triage {{incident}}.");
  await expect(diff).toContainText("Triage {{incident}} for the on-call engineer.");
  await expect(diff).toContainText("timeout → database outage");

  await editor.locator(".template-revision-field select").selectOption(firstRevisionId);
  await expect(editor.getByLabel("Prompt content")).toHaveValue("Triage {{incident}}.");
  await expect(editor.getByLabel("{{incident}}")).toHaveValue("timeout");
});

test("using a historical prompt pins the revision being viewed", async ({ page }) => {
  let project = createProjectFile({
    name: "Historical prompt use fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "historical-prompt-use",
    createdAt: "2026-08-06T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Incident triage",
    messages: [{ role: "user", content: "OLD REVISION: Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "triage-use",
    createdAt: "2026-08-06T12:00:01.000Z",
  });
  const firstRevisionId = project.promptTemplates[0]!.currentRevisionId;
  project = appendPromptTemplateRevision(project, {
    templateId: project.promptTemplates[0]!.id,
    messages: [{ role: "user", content: "LATEST REVISION: Triage {{incident}} carefully." }],
    variableDefaults: { incident: "latency" },
    createdAt: "2026-08-06T12:00:02.000Z",
    idSuffix: "triage-use-2",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Historical prompt use fixture");
  await openMode(page, "Prompts");

  const editor = page.locator(".template-editor");
  await editor.locator(".template-revision-field select").selectOption(firstRevisionId);
  await expect(editor.getByLabel("Prompt content")).toHaveValue(
    "OLD REVISION: Triage {{incident}}.",
  );
  await editor.getByRole("button", { name: "Use Revision 1" }).click();

  const use = page.locator(".template-use-card");
  await expect(use).toContainText("Revision 1");
  await expect(use).toContainText("OLD REVISION: Triage");
  await expect(use).not.toContainText("LATEST REVISION: Triage");
});

test("prompt drafts and checkpoint names survive library navigation", async ({ page }) => {
  let project = createProjectFile({
    name: "Saved prompt autosave fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "saved-prompt-autosave",
    createdAt: "2026-08-11T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "autosave-triage",
    revisionIdSuffix: "autosave-triage-1",
    createdAt: "2026-08-11T12:00:01.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Summary",
    messages: [{ role: "user", content: "Summarize this." }],
    idSuffix: "autosave-summary",
    revisionIdSuffix: "autosave-summary-1",
    createdAt: "2026-08-11T12:00:02.000Z",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Saved prompt autosave fixture");
  await openMode(page, "Prompts");

  const editor = page.locator(".template-editor");
  await editor.getByLabel("Prompt content").fill("Triage {{incident}} without jargon.");
  await editor.getByLabel("{{incident}}").fill("database outage");
  await editor.getByLabel("Revision name").fill("Make triage concise");
  await expect(editor).toContainText("Draft kept in this session");

  await page.locator(".template-list-item", { hasText: "Summary" }).click();
  await page.locator(".template-list-item", { hasText: "Incident triage" }).click();

  await expect(editor.locator(".template-revision-field select")).toHaveValue("draft");
  await expect(editor.getByLabel("Prompt content")).toHaveValue("Triage {{incident}} without jargon.");
  await expect(editor.getByLabel("{{incident}}")).toHaveValue("database outage");
  await expect(editor.getByLabel("Revision name")).toHaveValue("Make triage concise");

  await editor.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect(editor.locator(".template-revision-field select option").first()).toContainText(
    "Make triage concise",
  );
  await expect(editor.locator(".template-revision-field select")).not.toHaveValue("draft");
});

test("adding an autosaved prompt draft creates and pins that draft", async ({ page }) => {
  let project = createProjectFile({
    name: "Saved prompt insertion fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Existing conversation message" }],
    },
    idSuffix: "saved-prompt-insertion",
    createdAt: "2026-08-24T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Draft insertion",
    messages: [{ role: "user", content: "Example prompt content" }],
    idSuffix: "draft-insertion",
    revisionIdSuffix: "draft-insertion-1",
    createdAt: "2026-08-24T12:00:01.000Z",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Saved prompt insertion fixture");
  await openMode(page, "Prompts");

  const editor = page.locator(".template-editor");
  await editor.getByLabel("Prompt content").fill("The autosaved draft content");
  await editor.getByRole("button", { name: "Create revision and add" }).click();

  await expect(page.getByRole("tab", { name: /Messages/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".template-use-card")).toContainText(
    "The autosaved draft content",
  );
  await expect(page.locator(".template-use-card")).not.toContainText(
    "Example prompt content",
  );
});

test("the prompt header keeps its metadata controls usable beside revision actions", async ({ page }) => {
  let project = createProjectFile({
    name: "Saved prompt header fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "saved-prompt-header",
    createdAt: "2026-08-06T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "triage",
    createdAt: "2026-08-06T12:00:01.000Z",
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Saved prompt header fixture");
  await openMode(page, "Prompts");

  const editor = page.locator(".template-editor");
  const header = editor.locator(".template-editor-header");
  const promptName = editor.getByLabel("Prompt name");
  const revision = editor.locator(".template-revision-field select");
  const actions = editor.locator(".template-editor-actions");

  await expect(promptName).toBeInViewport();
  await expect(revision).toBeInViewport();

  const layout = await Promise.all([
    header.boundingBox(),
    promptName.boundingBox(),
    revision.boundingBox(),
    actions.boundingBox(),
  ]);
  const [headerBox, promptNameBox, revisionBox, actionsBox] = layout;
  expect(headerBox).not.toBeNull();
  expect(promptNameBox?.width).toBeGreaterThanOrEqual(160);
  expect(revisionBox?.width).toBeGreaterThanOrEqual(160);
  expect(actionsBox?.x).toBeGreaterThanOrEqual(headerBox!.x);
  expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(
    headerBox!.x + headerBox!.width,
  );
});

// A long system prompt edited in two places, so the diff has long unchanged
// stretches between and around the changes.
function longPromptProject(idSuffix: string) {
  const rules = Array.from({ length: 30 }, (_, index) => `Rule ${index + 1}: check item ${index + 1}.`);
  let project = createProjectFile({
    name: "Long prompt revision fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix,
    createdAt: "2026-08-06T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Incident triage",
    messages: [
      { role: "system", content: rules.join("\n") },
      { role: "user", content: "Triage {{incident}}." },
    ],
    variableDefaults: { incident: "timeout" },
    idSuffix: `${idSuffix}-triage`,
    createdAt: "2026-08-06T12:00:01.000Z",
  });
  const firstRevisionId = project.promptTemplates[0]!.currentRevisionId;
  const edited = [...rules];
  edited[4] = "Rule 5: CHECK ITEM FIVE.";
  edited[19] = "Rule 20: check item twenty.";
  project = appendPromptTemplateRevision(project, {
    templateId: project.promptTemplates[0]!.id,
    messages: [
      { role: "system", content: edited.join("\n") },
      { role: "user", content: "Triage {{incident}} carefully." },
    ],
    variableDefaults: { incident: "latency" },
    createdAt: "2026-08-06T12:00:02.000Z",
    idSuffix: `${idSuffix}-triage-2`,
  });
  return { project, firstRevisionId, secondRevisionId: project.promptTemplates[0]!.currentRevisionId };
}

async function openLongPrompt(page: import("@playwright/test").Page, idSuffix: string) {
  const fixture = longPromptProject(idSuffix);
  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture.project, "Long prompt revision fixture");
  await openMode(page, "Prompts");
  return fixture;
}

test("the first revision compares with the next one instead of reporting nothing to compare", async ({ page }) => {
  const { firstRevisionId } = await openLongPrompt(page, "first-revision-compare");
  const editor = page.locator(".template-editor");
  const diff = editor.getByRole("region", { name: "Revision diff" });

  await editor.locator(".template-revision-field select").selectOption(firstRevisionId);
  await expect(diff.getByRole("button", { name: /Revision diff/ })).toContainText("vs Revision 2 (current)");
  await expect(diff.getByLabel("Compare this revision with")).toHaveValue(/template-revision_/);
  await expect(diff).toContainText("Triage {{incident}} carefully.");
});

test("long unchanged stretches fold around the changes and expand on demand", async ({ page }) => {
  await openLongPrompt(page, "diff-folding");
  const diff = page.locator(".template-editor").getByRole("region", { name: "Revision diff" });
  await diff.getByRole("button", { name: /Revision diff/ }).click();

  const message = diff.locator(".template-diff-message").first();
  // Three lines of context either side of each change stay visible.
  await expect(message).toContainText("Rule 8: check item 8.");
  await expect(message).toContainText("Rule 17: check item 17.");
  await expect(message).not.toContainText("Rule 12: check item 12.");

  const fold = message.getByRole("button", { name: "Show 8 unchanged lines" });
  await fold.click();
  await expect(message).toContainText("Rule 12: check item 12.");
  await expect(fold).toHaveCount(0);
});

test("an open diff in focus mode leaves the editor visible and can be hidden by name", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLongPrompt(page, "focus-mode-diff");
  const editor = page.locator(".template-editor");
  await editor.getByRole("button", { name: "Open prompt editor in focus mode" }).click();
  const dialog = page.getByRole("dialog", { name: "Prompt editor focus mode" });
  const diff = dialog.getByRole("region", { name: "Revision diff" });
  await diff.getByRole("button", { name: /Revision diff/ }).click();

  // The whole message editor stays on screen above the diff; before, the
  // diff took the dialog's height and squeezed the editor into a sliver.
  await expect(dialog.getByRole("button", { name: "+ Add message" })).toBeInViewport();

  const hide = diff.getByRole("button", { name: "Hide diff" }).last();
  await hide.scrollIntoViewIfNeeded();
  await hide.click();
  await expect(diff.getByRole("button", { name: /Revision diff/ })).toHaveAttribute("aria-expanded", "false");
  await expect(diff.getByRole("button", { name: /Show diff/ })).toBeVisible();
});

test("a saved revision can be renamed and cleared back to its position label", async ({ page }) => {
  const { firstRevisionId, secondRevisionId } = await openLongPrompt(page, "revision-rename");
  const editor = page.locator(".template-editor");
  const revision = editor.locator(".template-revision-field select");

  await editor.getByRole("button", { name: "Rename revision" }).click();
  await editor.getByLabel("New revision name").fill("Careful wording");
  await editor.getByLabel("New revision name").press("Enter");
  await expect(revision.locator("option:checked")).toContainText("Careful wording (current)");

  // Escape abandons an edit without touching the saved name.
  await editor.getByRole("button", { name: "Rename revision" }).click();
  await editor.getByLabel("New revision name").fill("Discarded");
  await editor.getByLabel("New revision name").press("Escape");
  await expect(revision.locator("option:checked")).toContainText("Careful wording (current)");

  // Other surfaces read the new name, here the diff against an older revision.
  await revision.selectOption(firstRevisionId);
  await expect(editor.getByRole("region", { name: "Revision diff" })).toContainText("vs Careful wording (current)");

  await revision.selectOption(secondRevisionId);
  await editor.getByRole("button", { name: "Rename revision" }).click();
  await editor.getByLabel("New revision name").fill("");
  await editor.getByRole("button", { name: "Save name" }).click();
  await expect(revision.locator("option:checked")).toContainText("Revision 2 (current)");
});

test("focus mode keeps its close button on screen while the diff is scrolled into view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLongPrompt(page, "focus-mode-close");
  const editor = page.locator(".template-editor");
  await editor.getByRole("button", { name: "Open prompt editor in focus mode" }).click();
  const dialog = page.getByRole("dialog", { name: "Prompt editor focus mode" });
  const diff = dialog.getByRole("region", { name: "Revision diff" });
  await diff.getByRole("button", { name: /Revision diff/ }).click();
  await diff.getByRole("button", { name: "Hide diff" }).last().scrollIntoViewIfNeeded();

  const close = dialog.getByRole("button", { name: "Exit prompt editor focus mode" });
  await expect(close).toBeInViewport();
  await close.click();
  await expect(dialog).toHaveCount(0);
});
