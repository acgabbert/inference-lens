import { expect, test } from "./support/test";
import type { Locator, Page } from "./support/test";

import { createProjectFile, createPromptTemplate } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openMode,
  seedProfile,
  waitForHydration,
} from "./support";

// Long prompts are the reason these dialogs exist at this size: each fixture is
// long enough that a single scrolling column pushes the variables and the
// confirming action out of view.
const LONG_CONTEXT = "Context line that keeps the prompt long.\n".repeat(80);
const N8N_SOURCE = [
  "=You are a support agent.",
  `${LONG_CONTEXT}Customer: {{ $json.customer.name }}`,
  "Issue: {{ $json.issue }}",
  "Ref: {{ $('Lookup').item.json.id + 1 }}",
  "Again {{ $json.customer.name }}",
].join("\n");

const WIDE = { width: 1600, height: 1000 };

function fixture(): ProjectFile {
  let project = createProjectFile({
    name: "Wide dialog fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "wide-dialogs",
    createdAt: "2026-10-28T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Paste target",
    messages: [{ role: "user", content: "Before: " }],
    variableDefaults: {},
    idSuffix: "paste-target",
    revisionIdSuffix: "paste-target-1",
    createdAt: "2026-10-28T12:01:00.000Z",
  });
  return createPromptTemplate(project, {
    name: "Incident triage",
    messages: [
      { role: "system", content: "Triage incidents for {{service}}." },
      { role: "user", content: `Investigate {{incident}}.\n${LONG_CONTEXT}` },
    ],
    variableDefaults: { service: "checkout" },
    idSuffix: "incident-triage",
    revisionIdSuffix: "incident-triage-1",
    createdAt: "2026-10-28T12:02:00.000Z",
  });
}

async function open(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.setViewportSize(viewport);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), "Wide dialog fixture");
}

async function pasteN8n(page: Page): Promise<Locator> {
  await openMode(page, "Prompts");
  const content = page.getByLabel("Prompt content");
  await content.evaluate((element, source) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const data = new DataTransfer();
    data.setData("text/plain", source);
    textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, N8N_SOURCE);
  const dialog = page.getByRole("dialog", { name: "Convert pasted n8n expressions?" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

/** `right` starts at or past the right edge of `left`, and the two share rows. */
async function expectSideBySide(left: Locator, right: Locator): Promise<void> {
  const a = await box(left);
  const b = await box(right);
  expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
  expect(b.y).toBeLessThan(a.y + a.height);
  expect(a.y).toBeLessThan(b.y + b.height);
}

test("n8n paste puts the converted prompt beside its variables in a wide window", async ({ page }) => {
  await open(page, WIDE);
  const dialog = await pasteN8n(page);

  expect((await box(dialog)).width).toBeGreaterThanOrEqual(1300);
  // A successful paste starts with its source tucked away behind a toggle.
  await expect(dialog.getByLabel("Copied n8n content")).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Source" })).toHaveAttribute("aria-expanded", "false");

  const preview = dialog.getByLabel("Converted text preview");
  const variables = dialog.getByRole("region", { name: "Variables" });
  await expectSideBySide(preview, variables);
  expect((await box(preview)).height).toBeGreaterThan(500);
  await expect(dialog.getByLabel("Variable name for mapping-3")).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Convert n8n expressions" })).toBeInViewport();

  // A variable and its placeholders point at each other.
  await dialog.getByLabel("Variable name for mapping-1").focus();
  const nameTokens = preview.getByRole("button", { name: "{{name}}" });
  await expect(nameTokens).toHaveCount(2);
  await expect(nameTokens.first()).toHaveClass(/\bactive\b/);
  await expect(nameTokens.last()).toHaveClass(/\bactive\b/);
  await expect(preview.getByRole("button", { name: "{{issue}}" })).not.toHaveClass(/\bactive\b/);
  await preview.getByRole("button", { name: "{{issue}}" }).click();
  await expect(dialog.getByLabel("Variable name for mapping-2")).toBeFocused();

  await dialog.getByLabel("Variable name for mapping-1").fill("customer");
  await expect(preview.getByRole("button", { name: "{{customer}}" })).toHaveCount(2);

  await dialog.getByRole("button", { name: "Source" }).click();
  await expect(dialog.getByLabel("Copied n8n content")).toBeVisible();

  await dialog.getByRole("button", { name: "Convert n8n expressions" }).click();
  await expect(page.getByLabel("Prompt content")).toHaveValue(/Customer: \{\{customer\}\}\nIssue: \{\{issue\}\}\nRef: \{\{id\}\}\nAgain \{\{customer\}\}$/);
});

test("n8n paste stacks in a narrow window and keeps its action reachable", async ({ page }) => {
  await open(page, { width: 760, height: 700 });
  const dialog = await pasteN8n(page);

  const preview = await box(dialog.getByLabel("Converted text preview"));
  const variables = await box(dialog.getByRole("region", { name: "Variables" }));
  expect(variables.y).toBeGreaterThanOrEqual(preview.y + preview.height - 1);
  await expect(dialog.getByRole("button", { name: "Convert n8n expressions" })).toBeInViewport();
});

test("Insert saved prompt lays out list, preview, and variable names side by side", async ({ page }) => {
  await open(page, WIDE);
  await page.getByRole("button", { name: "Insert saved prompt…" }).click();
  await page.getByRole("button", { name: "More options…" }).click();
  const dialog = page.getByRole("dialog", { name: "Insert saved prompt" });
  await dialog.getByRole("radio", { name: "Incident triage" }).check();

  expect((await box(dialog)).width).toBeGreaterThanOrEqual(1300);
  const list = dialog.getByRole("group", { name: "Active saved prompts" });
  const preview = dialog.getByRole("region", { name: "Prompt preview" });
  const variables = dialog.getByRole("region", { name: "Variables" });
  await expectSideBySide(list, preview);
  await expectSideBySide(preview, variables);
  expect((await box(preview)).height).toBeGreaterThan(500);
  await expect(variables).toContainText("incident");
  await expect(variables).toContainText("service");
  await expect(variables).toContainText("Default: checkout");
  await expect(dialog.getByRole("button", { name: "Insert prompt", exact: true })).toBeInViewport();
});

test("Start from prompt previews the prompt beside its details", async ({ page }) => {
  await open(page, WIDE);
  await openMode(page, "Evaluations");
  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await page.getByRole("button", { name: "Start from prompt…" }).click();
  const dialog = page.getByRole("dialog", { name: "Start from prompt" });
  await dialog.getByRole("radio", { name: "Incident triage" }).check();

  expect((await box(dialog)).width).toBeGreaterThanOrEqual(1300);
  const preview = dialog.getByRole("region", { name: "Prompt preview" });
  const details = dialog.getByRole("region", { name: "Prompt details" });
  await expect(preview).toContainText("Triage incidents for {{service}}.");
  await expect(preview).toContainText("Investigate {{incident}}.");
  await expectSideBySide(dialog.getByRole("group", { name: "Active prompts" }), preview);
  await expectSideBySide(preview, details);
  await expect(details).toContainText("service (has default), incident");
  await expect(dialog.getByRole("button", { name: "Start from prompt", exact: true })).toBeInViewport();
});
