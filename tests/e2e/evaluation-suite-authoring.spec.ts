import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  addEvaluationCheck,
  addEvaluationCase,
  addEvaluationInput,
  createEvaluationSuite,
  evaluationBindingCandidates,
  updateEvaluationCase,
  updateEvaluationCheck,
} from "../../packages/core/src/evaluation-suite-authoring";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  serializeProjectFile,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { seedProfile, openMode } from "./support";

const PROFILE_ENDPOINT = "http://127.0.0.1:44014/v1";

function baseProject() {
  let project = createProjectFile({
    name: "Evaluation authoring fixture",
    request: {
      provider: "openai-compatible",
      endpoint: PROFILE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.4,
    },
    idSuffix: "authoring",
    createdAt: "2026-08-01T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}} to {{audience}}." }],
    variableDefaults: { audience: "engineers" },
    idSuffix: "question",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
  return insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });
}

/** A saved project that already contains three authored, complete cases. */
function projectWithSavedSuite() {
  let project = baseProject();
  const candidates = evaluationBindingCandidates(
    project,
    project.defaults.conversationRevisionId,
  );
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  const input = addEvaluationInput(project, created.suiteId, candidates[0]!, () => "topic");
  project = input.project;
  for (const [index, value] of ["migrations", "indexes", "replication"].entries()) {
    const added = addEvaluationCase(project, created.suiteId, () => `case-${index}`);
    project = updateEvaluationCase(added.project, created.suiteId, added.caseId, {
      name: value,
      values: { [input.inputId]: `database ${value}` },
    });
    project = addEvaluationCheck(project, created.suiteId, added.caseId, { kind: "contains" }, () => `saved-${index}`);
    const check = project.evaluationSuites[0]!.cases[index]!.checks[0]!;
    project = updateEvaluationCheck(project, created.suiteId, added.caseId, {
      checkId: check.checkId,
      kind: "contains",
      label: "Mentions database",
      value: "database",
    });
  }
  return project;
}

function projectWithRunnableSuite() {
  let project = projectWithSavedSuite();
  const suite = project.evaluationSuites[0]!;
  const expected = ["Buffered fixture", "not present", "2 + 2 = 4"];
  suite.cases.forEach((evaluationCase, index) => {
    const check = project.evaluationSuites[0]!.cases[index]!.checks[0]!;
    project = updateEvaluationCheck(project, suite.id, evaluationCase.id, {
      checkId: check.checkId,
      kind: "contains",
      label: `Expected result ${index + 1}`,
      value: expected[index]!,
    });
  });
  return project;
}

async function importProject(page: Page, project: ProjectFile) {
  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "authoring.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeProjectFile(project)),
    },
  );
  await expect(page.locator(".brand")).toContainText("Evaluation authoring fixture");
  await page.locator(".project-menu").evaluate((element) => element.removeAttribute("open"));
}

async function openProject(page: Page, project: ProjectFile, width: number) {
  await seedProfile(page, {
    endpoint: PROFILE_ENDPOINT,
    instanceId: "profile-instance-buffered",
  });

  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await expect(page.locator(".topbar")).toContainText("Buffered fixture");
  await importProject(page, project);
  await openMode(page, "Evaluations");
}

test("every offered check kind is addable in the running editor", async ({ page }) => {
  await openProject(page, baseProject(), 1440);
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toBeVisible();

  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await page.getByLabel("Template variable to bind").selectOption({ label: "Question · topic" });
  await page.getByRole("button", { name: "+ Add case input" }).click();
  await page.getByRole("button", { name: "+ Add case", exact: true }).click();
  await page.getByLabel("Untitled case topic").fill("database migrations");

  const failures: string[] = [];
  for (const label of [
    "Exact output",
    "Contains text",
    "Regex",
    "Valid JSON",
    "Maximum characters",
    "Maximum duration",
    "Maximum tokens",
    "Called tool",
    "Did not call tool",
    "Tool call count",
    "Tool call arguments",
  ]) {
    await page.getByLabel("New check kind").selectOption({ label });
    await page.getByRole("button", { name: "+ Add check" }).click();
    await page.waitForTimeout(120);
    const alert = editor.locator('[role="alert"]');
    if (await alert.count() > 0) failures.push(`${label}: ${await alert.innerText()}`);
    if (label === "Regex") {
      // An empty pattern is an accepted authoring draft: the card exists, and
      // preflight — not the add action — is what blocks the run until it is
      // filled in.
      await expect(editor.locator(".evaluation-diagnostics"))
        .toContainText("needs a pattern");
      const pattern = editor.locator(".evaluation-check-card")
        .filter({ hasText: "RE2 syntax" })
        .getByLabel("Pattern");
      await pattern.fill("migration");
      await pattern.blur();
      await expect(editor.locator(".evaluation-diagnostics"))
        .not.toContainText("needs a pattern");
    }
    if (label === "Called tool") {
      // An empty tool name is the same kind of accepted-but-incomplete draft
      // as an empty regex pattern: the card exists, and preflight — not the
      // add action — reports it until a tool name is filled in.
      await expect(editor.locator(".evaluation-diagnostics"))
        .toContainText("needs a tool name");
      const toolName = editor.locator(".evaluation-check-card")
        .filter({ hasText: "Called tool" })
        .getByLabel("Tool name");
      await toolName.fill("lookup");
      await toolName.blur();
      await expect(editor.locator(".evaluation-diagnostics"))
        .not.toContainText("needs a tool name");
    }
  }
  expect(failures).toEqual([]);
  await expect(editor.locator(".evaluation-case-check-count")).toHaveText("11");
  await expect(editor).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

test("the editor blocks an unbound template variable before evaluation starts", async ({ page }) => {
  await openProject(page, baseProject(), 1440);
  const editor = page.locator(".evaluation-editor");
  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await page.getByRole("button", { name: "+ Add case", exact: true }).click();
  await page.getByLabel("New check kind").selectOption({ label: "Contains text" });
  await page.getByRole("button", { name: "+ Add check" }).click();
  const expected = editor.getByLabel("Expected text");
  await expected.fill("topic");
  await expected.blur();

  // No focus mode to open: the Evaluations mode is already the whole surface,
  // and the blocker is stated where the blocked action is.
  await expect(page.getByLabel("Open evaluation editor in focus mode")).toHaveCount(0);
  await expect(editor).toContainText('Case "Untitled case" cannot resolve template variable "topic"');
  await expect(editor).toContainText("1 setup issue");
  await expect(editor.getByRole("button", { name: "Start evaluation…" })).toBeDisabled();
});

test("a saved suite opens with every case selected and preflight clean", async ({ page }) => {
  await openProject(page, projectWithSavedSuite(), 1440);
  const editor = page.locator(".evaluation-editor");

  await expect(editor).toContainText("3 selected × 1 rep → 3 runs");
  await expect(editor).toContainText("Ready to run");
  await expect(editor.locator(".evaluation-diagnostics")).toHaveCount(0);
  await expect(page.locator(".evaluation-preview-scroll")
    .getByRole("region", { name: "Provider input for migrations" }))
    .toContainText("Explain database migrations to engineers.");
  const layout = await editor.locator(".evaluation-preflight").evaluate((preflight) => {
    const startArea = preflight.querySelector<HTMLElement>(".evaluation-start-area");
    const note = startArea?.querySelector<HTMLElement>("small");
    return {
      preflightFits: preflight.scrollWidth <= preflight.clientWidth,
      startAreaFits: Boolean(startArea && startArea.scrollWidth <= startArea.clientWidth),
      noteFits: Boolean(note && note.scrollWidth <= note.clientWidth),
    };
  });
  expect(layout).toEqual({ preflightFits: true, startAreaFits: true, noteFits: true });

  // Narrowing the selection is explicit, and preflight follows it.
  await page.getByLabel("Select indexes").uncheck();
  await expect(editor).toContainText("2 selected × 1 rep → 2 runs");
  await expect(editor).toContainText("Ready to run");

  // Explicit UI selection belongs to the open project, even when a replacement
  // happens to reuse the same suite and case identifiers.
  const replacement = projectWithSavedSuite();
  replacement.projectId = "project_replacement";
  await importProject(page, replacement);
  await expect(editor).toContainText("3 selected × 1 rep → 3 runs");
});

test("selecting a historical revision with no bound template use stays in the editor", async ({ page }) => {
  const project = projectWithSavedSuite();
  project.conversationRevisions.unshift({
    id: "revision_historical-before-template",
    conversationId: project.conversations[0]!.id,
    createdAt: "2026-07-31T12:00:00.000Z",
    items: [],
  });
  await openProject(page, project, 1440);
  const editor = page.locator(".evaluation-editor");

  // The picker is flat now: at full width choosing a historical revision costs
  // no disclosure, so it is selected directly.
  await editor.getByLabel("Existing project revision").selectOption(
    "revision_historical-before-template",
  );

  await expect(editor).toBeVisible();
  await expect(editor.locator(".evaluation-diagnostics")).toContainText(
    "Selected revision does not contain template use",
  );
  // The preview no longer collapses to one generic refusal: the binding that
  // cannot be satisfied is its own row, and the rest of the input still
  // resolves and renders around it.
  const preview = page.locator(".evaluation-preview-scroll")
    .getByRole("region", { name: "Provider input for migrations" });
  await expect(preview).toContainText("Case input “topic” has nowhere to go");
  await expect(preview).toContainText("revision has no such template use");
  await expect(preview).toContainText("This revision resolves to no messages");
  await expect(editor).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
  await expect(preview).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

test("a rejected check edit stays local and restores the saved value", async ({ page }) => {
  await openProject(page, baseProject(), 1440);
  const editor = page.locator(".evaluation-editor");
  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await page.getByRole("button", { name: "+ Add case", exact: true }).click();
  await page.getByLabel("New check kind").selectOption({ label: "Regex" });
  await page.getByRole("button", { name: "+ Add check" }).click();

  const regexCard = editor.locator(".evaluation-check-card").filter({ hasText: "RE2 syntax" });
  const pattern = regexCard.getByLabel("Pattern");
  await pattern.fill("migration");
  await pattern.blur();
  await expect(regexCard).toContainText("RE2 syntax");
  await regexCard.getByLabel("About RE2 syntax").click();
  await expect(regexCard.getByText("Lookarounds and backreferences aren’t supported.")).toBeVisible();
  const flags = regexCard.getByLabel("Flags");
  await flags.fill("g");
  await flags.blur();

  await expect(regexCard.getByRole("alert")).toContainText("Safe regex flags must be a unique subset of ims");
  await expect(flags).toHaveValue("");
  await expect(editor.locator(".evaluation-suite-rename + [role=alert]")).toHaveCount(0);
});

test("rejected suite and case names restore saved values with local errors", async ({ page }) => {
  await openProject(page, baseProject(), 1440);
  const editor = page.locator(".evaluation-editor");
  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await page.getByLabel("Template variable to bind").selectOption({ label: "Question · topic" });
  await page.getByRole("button", { name: "+ Add case input" }).click();
  await page.getByRole("button", { name: "+ Add case", exact: true }).click();
  await page.getByLabel("Untitled case topic").fill("database migrations");

  await page.getByRole("button", { name: "Rename" }).click();
  const suiteName = page.getByLabel("Suite name");
  await suiteName.fill("   ");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(suiteName).toHaveValue("Untitled evaluation");
  await expect(editor.locator(".evaluation-suite-rename + .evaluation-field-error"))
    .toContainText("expected string to have >=1 characters");

  const caseName = page.getByLabel("Case name Untitled case");
  await caseName.fill("   ");
  await caseName.blur();
  await expect(caseName).toHaveValue("Untitled case");
  await expect(editor.locator(".evaluation-case-detail > .evaluation-field-error"))
    .toContainText("expected string to have >=1 characters");

  await expect(editor.locator(".template-diagnostic[role=alert]")).toHaveCount(0);
});

test("preflight reports an unfinished check and an empty value", async ({ page }) => {
  await openProject(page, projectWithSavedSuite(), 1440);
  const editor = page.locator(".evaluation-editor");

  await page.getByLabel("migrations topic").fill("   ");
  await editor.locator(".evaluation-case-list-item").filter({ hasText: "migrations" }).getByRole("button").click();
  await page.getByLabel("Expected text").fill("");
  await page.getByLabel("Expected text").blur();

  const diagnostics = editor.locator(".evaluation-diagnostics");
  await expect(diagnostics).toContainText('Case "migrations" has no value for input "topic".');
  await expect(diagnostics).toContainText("has no expected text yet");
  await expect(editor).toContainText("2 setup issues");
});

test("keeps the evaluations tab within the viewport on a phone", async ({ page }) => {
  await openProject(page, projectWithSavedSuite(), 390);
  await expect(page.locator(".evaluation-editor")).toContainText("3 runs");

  const layout = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
});

test("starts contextually, confirms the frozen batch, and renders strict live evidence", async ({ page }) => {
  await openProject(page, projectWithRunnableSuite(), 1440);
  await page.getByLabel(/^Run target:/).click();
  await page.getByRole("button", { name: /manage connections/i }).click();
  await page.locator(".connection-mapping").getByRole("button", { name: /use .* for this project/i }).click();
  await page.getByRole("button", { name: /close connections/i }).click();
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("Ready to run");
  const start = editor.getByRole("button", { name: "Start evaluation…" });
  await expect(start).toBeEnabled();
  await expect(page.locator(".topbar")).not.toContainText("Run request");
  await expect(page.locator(".topbar")).not.toContainText("Repeat…");

  await start.focus();
  await page.keyboard.press("Control+Enter");
  const dialog = page.getByRole("dialog", { name: /Start “Topics”/ });
  await expect(dialog).toContainText("3 · migrations, indexes, replication");
  await expect(dialog).toContainText("1 per case");
  await expect(dialog).toContainText("3 planned");
  await expect(dialog).toContainText("Session only");
  await expect(dialog).toContainText("buffered-test-model");

  await dialog.getByRole("button", { name: "Start 3 calls" }).click();
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("As run · 3 cases · 1 repetition");
  await expect(results).toContainText("2 / 3 passed");
  await expect(results).toContainText("2 passed · 1 failed · 0 not evaluated");
  await expect(results).toContainText("33 tokens · 3/3 runs reported");
  await expect(results).toContainText("This evaluation is not saved and will be lost when this session closes.");
  await expect(results.getByText("check failed")).toHaveCount(1);
  await expect(results.locator("button", { hasText: "Open Response & Inspect" })).toHaveCount(3);
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  await results.locator(".evaluation-case-result").first().locator("summary").click();
  await results.getByRole("button", { name: "Open Response & Inspect" }).first().click();
  await expect(page.getByLabel("Run transcript")).toContainText("Buffered fixture response: 2 + 2 = 4.");
});
