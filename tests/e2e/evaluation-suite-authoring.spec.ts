import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  addEvaluationCase,
  addEvaluationInput,
  createEvaluationSuite,
  evaluationBindingCandidates,
  updateEvaluationCase,
} from "../../packages/core/src/evaluation-suite-authoring";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  serializeProjectFile,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";

const PROFILE_STORAGE_KEY = "inference-lens:inference-profiles:v1";
const STREAMING_STORAGE_KEY = "inference-lens:streaming-preference:v1";
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
  }
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
  await page.addInitScript(({ profileKey, streamingKey, endpoint }) => {
    localStorage.setItem(profileKey, JSON.stringify({
      profiles: [{
        id: "buffered",
        instanceId: "profile-instance-buffered",
        name: "Buffered fixture",
        provider: "openai-compatible",
        endpoint,
        model: "buffered-test-model",
        temperature: 0.7,
      }],
      activeProfileId: "buffered",
    }));
    localStorage.setItem(streamingKey, "buffered");
  }, {
    profileKey: PROFILE_STORAGE_KEY,
    streamingKey: STREAMING_STORAGE_KEY,
    endpoint: PROFILE_ENDPOINT,
  });

  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await expect(page.locator(".topbar")).toContainText("Buffered fixture");
  await importProject(page, project);
  await page.getByRole("tab", { name: /Evaluations/ }).click();
}

test("every offered check kind is addable in the running editor", async ({ page }) => {
  await openProject(page, baseProject(), 1440);
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toBeVisible();

  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await page.getByLabel("Template variable to bind").selectOption({ label: "Question · topic" });
  await page.getByRole("button", { name: "+ Bind input" }).click();
  await page.getByRole("button", { name: "+ Add case" }).click();
  await page.getByLabel("Untitled case topic").fill("database migrations");

  const failures: string[] = [];
  for (const label of [
    "Exact output",
    "Contains text",
    "Safe regex",
    "Valid JSON",
    "Maximum characters",
    "Maximum duration",
    "Maximum tokens",
  ]) {
    await page.getByLabel("New check kind").selectOption({ label });
    if (label === "Safe regex") {
      await page.getByRole("button", { name: "+ Add check" }).click();
      await expect(editor.locator(".evaluation-case-detail").getByRole("alert"))
        .toContainText("Safe regex patterns must not be empty");
      await page.getByLabel("New Safe regex pattern").fill("migration");
    }
    await page.getByRole("button", { name: "+ Add check" }).click();
    await page.waitForTimeout(120);
    const alert = editor.locator('[role="alert"]');
    if (await alert.count() > 0) failures.push(`${label}: ${await alert.innerText()}`);
  }
  expect(failures).toEqual([]);
  await expect(editor.getByRole("button", { name: /^7 · Edit$/ })).toBeVisible();
  await expect(editor).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

test("a saved suite opens with every case selected and preflight clean", async ({ page }) => {
  await openProject(page, projectWithSavedSuite(), 1440);
  const editor = page.locator(".evaluation-editor");

  await expect(editor).toContainText("3 cases × 1 = 3 planned runs");
  await expect(editor).toContainText("Ready to author");
  await expect(editor.locator(".evaluation-diagnostics")).toHaveCount(0);

  // Narrowing the selection is explicit, and preflight follows it.
  await page.getByLabel("Select indexes").uncheck();
  await expect(editor).toContainText("2 cases × 1 = 2 planned runs");
  await expect(editor).toContainText("Ready to author");

  // Explicit UI selection belongs to the open project, even when a replacement
  // happens to reuse the same suite and case identifiers.
  const replacement = projectWithSavedSuite();
  replacement.projectId = "project_replacement";
  await importProject(page, replacement);
  await expect(editor).toContainText("3 cases × 1 = 3 planned runs");
});

test("a rejected check edit stays local and restores the saved value", async ({ page }) => {
  await openProject(page, baseProject(), 1440);
  const editor = page.locator(".evaluation-editor");
  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await page.getByRole("button", { name: "+ Add case" }).click();
  await page.getByLabel("New check kind").selectOption({ label: "Safe regex" });
  await page.getByLabel("New Safe regex pattern").fill("migration");
  await page.getByRole("button", { name: "+ Add check" }).click();

  const regexCard = editor.locator(".evaluation-check-card").filter({ hasText: "Safe regex" });
  const flags = regexCard.getByLabel("Flags");
  await flags.fill("g");
  await flags.blur();

  await expect(regexCard.getByRole("alert")).toContainText("Safe regex flags must be a unique subset of ims");
  await expect(flags).toHaveValue("");
  await expect(editor.locator(".evaluation-suite-header + [role=alert]")).toHaveCount(0);
});

test("preflight reports an unfinished check and an empty value", async ({ page }) => {
  await openProject(page, projectWithSavedSuite(), 1440);
  const editor = page.locator(".evaluation-editor");

  await page.getByLabel("migrations topic").fill("   ");
  await page.getByRole("button", { name: /^0 · Edit$/ }).first().click();
  await page.getByLabel("New check kind").selectOption({ label: "Contains text" });
  await page.getByRole("button", { name: "+ Add check" }).click();

  const diagnostics = editor.locator(".evaluation-diagnostics");
  await expect(diagnostics).toContainText('Case "migrations" has no value for input "topic".');
  await expect(diagnostics).toContainText("has no expected text yet");
  await expect(editor).toContainText("2 setup issues");
});

test("keeps the evaluations tab within the viewport on a phone", async ({ page }) => {
  await openProject(page, projectWithSavedSuite(), 390);
  await expect(page.locator(".evaluation-editor")).toContainText("3 planned runs");

  const layout = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
});
