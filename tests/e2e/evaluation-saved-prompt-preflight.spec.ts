import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  seedProfile,
  waitForHydration,
} from "./support";

const PROJECT_NAME = "Saved prompt preflight fixture";

/**
 * A project whose saved prompt is not yet used by any conversation.
 *
 * That is the state the shortcut exists for: before PR10a an author had to
 * leave Evaluations, insert the template into the composer, save a revision,
 * and come back. The template keeps a default for `audience` so preflight has
 * two different value sources to distinguish, and both rendered values are
 * predictable from the fixture rather than merely plausible.
 */
function projectWithUnusedPrompt(): ProjectFile {
  const project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.4,
    },
    idSuffix: "saved-prompt",
    createdAt: "2026-08-01T12:00:00.000Z",
  });
  return createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}} to {{audience}}." }],
    variableDefaults: { audience: "engineers" },
    idSuffix: "question",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
}

/** A second saved prompt, so a revision can pin two distinct template uses. */
function projectWithTwoPrompts(): ProjectFile {
  return createPromptTemplate(projectWithUnusedPrompt(), {
    name: "Safety policy",
    messages: [{ role: "system", content: "Answer within {{policy}}." }],
    variableDefaults: { policy: "the default policy" },
    idSuffix: "safety",
    createdAt: "2026-08-01T12:00:02.000Z",
  });
}

async function openEvaluations(
  page: Page,
  project: ProjectFile,
  width = 1440,
): Promise<void> {
  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, PROJECT_NAME);
  await page.getByRole("tab", { name: /Evaluations/ }).click();
}

/** Creates a revision from the named saved prompt and waits for the notice. */
async function startFromSavedPrompt(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Start from saved prompt…" }).click();
  const dialog = page.getByRole("dialog", { name: "Start from saved prompt" });
  await dialog.getByRole("radio", { name }).check();
  await dialog.getByRole("button", { name: "Create revision & select" }).click();
  await expect(page.locator(".evaluation-authoring-notice")).toContainText(
    `Created a revision from “${name}”`,
  );
}

async function mapConnection(page: Page): Promise<void> {
  await page.getByLabel(/^Run target:/).click();
  await page.getByRole("button", { name: /manage connections/i }).click();
  await page
    .locator(".connection-mapping")
    .getByRole("button", { name: /use .* for this project/i })
    .click();
  await page.getByRole("button", { name: /close connections/i }).click();
}

test("authoring from a saved prompt shows the exact resolved input it will run", async ({ page }) => {
  await openEvaluations(page, projectWithUnusedPrompt());
  const editor = page.locator(".evaluation-editor");

  await page.getByRole("button", { name: "Create evaluation suite" }).click();

  // The dialog describes the template's current immutable revision before it
  // creates anything, including which variables carry defaults.
  await page.getByRole("button", { name: "Start from saved prompt…" }).click();
  const dialog = page.getByRole("dialog", { name: "Start from saved prompt" });
  await expect(dialog).toContainText("1 · user");
  await expect(dialog).toContainText("topic, audience (has default)");
  // No suite bindings exist yet, so nothing is at risk of being orphaned.
  await expect(dialog).not.toContainText("This suite already has case inputs");
  await dialog.getByRole("button", { name: "Create revision & select" }).click();
  await expect(page.locator(".evaluation-authoring-notice")).toContainText(
    "Created a revision from “Question”",
  );

  await page.getByLabel("Template variable to bind").selectOption({ label: "Question · topic" });
  await page.getByRole("button", { name: "+ Add case input" }).click();
  await page.getByRole("button", { name: "+ Add case", exact: true }).click();
  await page.getByLabel("Untitled case topic").fill("database migrations");
  await page.getByLabel("New check kind").selectOption({ label: "Contains text" });
  await page.getByRole("button", { name: "+ Add check" }).click();
  const expected = editor.getByLabel("Expected text");
  await expected.fill("Buffered fixture");
  await expected.blur();

  // Region 1 — revision provenance: recognizable without reading an ID, with
  // the pinned template revision stated and the stable ID kept in details.
  const provenance = editor.getByRole("region", { name: /^Revision provenance for / });
  await expect(provenance).toContainText("Current · Question");
  await expect(provenance).toContainText("pinned to the template’s current revision");
  await expect(provenance).toContainText("1 message");
  await expect(provenance.getByText("Stable identity")).toBeVisible();

  // Region 2 — resolved values: one row per variable, each naming its source.
  const values = editor.getByRole("region", { name: /^Resolved values for / });
  const topicRow = values.locator("tbody tr").filter({ hasText: "topic" });
  await expect(topicRow).toContainText("database migrations");
  await expect(topicRow).toContainText("Case value · topic");
  const audienceRow = values.locator("tbody tr").filter({ hasText: "audience" });
  await expect(audienceRow).toContainText("engineers");
  await expect(audienceRow).toContainText("Template default");

  // Region 3 — the exact ordered message the plan will snapshot.
  const conversation = editor.getByRole("region", { name: /^Resolved conversation for / });
  await expect(conversation.locator(".request-preview-message")).toHaveCount(1);
  await expect(conversation).toContainText("Explain database migrations to engineers.");

  // Region 4 — the target and settings that go with it.
  const settings = editor.getByRole("region", { name: /^Execution settings for / });
  await expect(settings).toContainText("Buffered fixture");
  await expect(settings).toContainText(BUFFERED_FIXTURE_ENDPOINT);
  await expect(settings).toContainText("openai-compatible-chat-completions");
  await expect(settings).toContainText("buffered-test-model");
  await expect(settings).toContainText("Buffered");
  // The imported project's request temperature, which takes precedence over
  // the seeded profile's 0.7 — so this number is checkable against the fixture
  // rather than merely plausible.
  await expect(settings).toContainText("Temperature0.4");
  await expect(settings).toContainText("None");

  await expect(editor).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  // Confirmation names the same revision the same way, then the run itself
  // goes through the buffered fixture deterministically.
  await mapConnection(page);
  await expect(editor).toContainText("Ready to run");
  await editor.getByRole("button", { name: "Start evaluation…" }).click();
  const confirmation = page.getByRole("dialog", { name: /Start “Untitled evaluation”/ });
  await expect(confirmation).toContainText("Current · Question");
  await expect(confirmation).toContainText("1 planned");
  await expect(confirmation).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  await confirmation.getByRole("button", { name: "Start 1 call" }).click();
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("1 / 1 passed");
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

test("a second saved prompt warns about existing bindings and stays distinct in provenance", async ({ page }) => {
  await openEvaluations(page, projectWithTwoPrompts());
  const editor = page.locator(".evaluation-editor");

  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await startFromSavedPrompt(page, "Question");
  await page.getByLabel("Template variable to bind").selectOption({ label: "Question · topic" });
  await page.getByRole("button", { name: "+ Add case input" }).click();
  await page.getByRole("button", { name: "+ Add case", exact: true }).click();
  await page.getByLabel("Untitled case topic").fill("database migrations");

  // The suite now has a binding, so creating another revision is warned about
  // before it happens: the new use gets a new stable ID and is not rewritten.
  await page.getByRole("button", { name: "Start from saved prompt…" }).click();
  const dialog = page.getByRole("dialog", { name: "Start from saved prompt" });
  await dialog.getByRole("radio", { name: "Safety policy" }).check();
  await expect(dialog).toContainText("This suite already has case inputs");
  await dialog.getByRole("button", { name: "Create revision & select" }).click();

  // The prompt-only child replaces rather than appends, so the earlier
  // question use is not carried along and its binding no longer resolves.
  const provenance = editor.getByRole("region", { name: /^Revision provenance for / });
  await expect(provenance).toContainText("Current · Safety policy");
  await expect(provenance).not.toContainText("Question");

  const values = editor.getByRole("region", { name: /^Resolved values for / });
  await expect(values).toContainText("Case input “topic” has nowhere to go");
  await expect(values).toContainText("revision has no such template use");
  await expect(values).toContainText("Template default");
  await expect(editor).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  // The earlier revision is still reachable and still described meaningfully.
  await expect(
    editor.getByLabel("Base conversation revision").locator("option"),
  ).toContainText([/Question/, /Safety policy/]);
});

test("the resolved-input regions stay inside a phone viewport", async ({ page }) => {
  await openEvaluations(page, projectWithUnusedPrompt(), 390);

  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await startFromSavedPrompt(page, "Question");
  await page.getByLabel("Template variable to bind").selectOption({ label: "Question · topic" });
  await page.getByRole("button", { name: "+ Add case input" }).click();
  await page.getByRole("button", { name: "+ Add case", exact: true }).click();
  await page.getByLabel("Untitled case topic").fill("database migrations");

  const editor = page.locator(".evaluation-editor");
  await expect(editor.getByRole("region", { name: /^Resolved values for / })).toBeVisible();

  const layout = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
});
