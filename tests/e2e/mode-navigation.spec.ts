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
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openMode,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

/**
 * Modes are the application's top-level destinations, so the two properties
 * that matter are the ones a tab strip used to give away for free: every mode
 * is reachable at every supported width, and leaving one and coming back does
 * not quietly reset what was being worked on.
 *
 * The per-mode state checked here is deliberately spread across three different
 * owners — the request draft (a route hook), the focused case (the authoring
 * hook), and the past-executions disclosure (route state lifted out of the
 * editor for exactly this reason). A mode shell that unmounts its modes loses
 * whichever of those still lives inside a mode's own component tree, and the
 * disclosure is the one that actually did.
 */

const CASE_NAME = "migrations";

function projectWithSuite(): ProjectFile {
  let project = createProjectFile({
    name: "Mode navigation fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Authored composer message" }],
    },
    idSuffix: "mode-navigation",
    createdAt: "2026-08-04T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "question",
    createdAt: "2026-08-04T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });

  const candidates = evaluationBindingCandidates(
    project,
    project.defaults.conversationRevisionId,
  );
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  const input = addEvaluationInput(project, created.suiteId, candidates[0]!, () => "topic");
  project = input.project;
  const added = addEvaluationCase(project, created.suiteId, () => "case-0");
  project = updateEvaluationCase(added.project, created.suiteId, added.caseId, {
    name: CASE_NAME,
    values: { [input.inputId]: `database ${CASE_NAME}` },
  });
  return project;
}

async function open(page: Page, width = 1440): Promise<void> {
  await seedProfile(page, {
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    instanceId: "profile-instance-buffered",
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, projectWithSuite(), "Mode navigation fixture");
}

/**
 * The same fixture from a project folder. The past-executions disclosure only
 * renders when there is a folder to list, and that disclosure is the piece of
 * per-mode state that actually broke when the modes started unmounting.
 */
async function openFromFolder(page: Page): Promise<void> {
  await seedProfile(page, {
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    instanceId: "profile-instance-buffered",
  });
  await stubProjectDirectory(page, {
    name: "mode-navigation-fixture",
    files: { "project.json": serializeProjectFile(projectWithSuite()) },
    directories: ["traces", "experiments"],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.locator(".brand")).toContainText("Mode navigation fixture");
  await page.locator(".project-menu").evaluate((element) => element.removeAttribute("open"));
}

test("every mode is reachable, and each renders only its own surface", async ({ page }) => {
  await open(page);

  // Compose owns the request composer and the response pane, and nothing else.
  await expect(page.locator(".composer")).toBeVisible();
  await expect(page.locator(".result")).toBeVisible();
  await expect(page.locator(".evaluation-editor")).toHaveCount(0);

  await openMode(page, "Evaluations");
  await expect(page.locator(".evaluation-editor")).toBeVisible();
  await expect(page.locator(".composer")).toHaveCount(0);
  await expect(page.locator(".result")).toHaveCount(0);

  // Runs starts empty and says what fills it rather than rendering a blank.
  await openMode(page, "Runs");
  await expect(page.locator(".pane-empty-state")).toContainText("No results open");
  await expect(page.locator(".evaluation-editor")).toHaveCount(0);
  await expect(page.locator(".composer")).toHaveCount(0);

  // Its empty state routes to the mode that can produce something to read.
  await page.getByRole("button", { name: "Go to Evaluations" }).click();
  await expect(page.locator(".evaluation-editor")).toBeVisible();
});

test("leaving a mode and returning preserves what was being worked on", async ({ page }) => {
  await openFromFolder(page);

  // Compose: an edited draft message.
  const message = page.getByLabel("Message 1 content");
  await message.fill("A draft that must survive navigation");

  // Evaluations: a focused case and an opened past-executions disclosure.
  await openMode(page, "Evaluations");
  await page.locator(".evaluation-case-rail").getByRole("button", { name: CASE_NAME }).click();
  const history = page.locator(".evaluation-suite-history");
  await history.getByText("Past executions").click();
  await expect(history).toHaveAttribute("open", "");

  await openMode(page, "Runs");
  await openMode(page, "Compose");
  await expect(page.getByLabel("Message 1 content"))
    .toHaveValue("A draft that must survive navigation");

  await openMode(page, "Evaluations");
  await expect(page.getByRole("complementary", { name: "Provider input" })
    .locator(".evaluation-preview-case"))
    .toContainText(CASE_NAME);
  // The disclosure is the one that used to reset: its state lived inside the
  // mode's own component tree, which the mode switch unmounts.
  await expect(page.locator(".evaluation-suite-history")).toHaveAttribute("open", "");
});

// 760 is the workbench's mobile breakpoint and 880 is where the topbar wraps;
// the modes are the only way out of a mode, so none of these may truncate it.
for (const width of [320, 390, 760, 880, 1440]) {
  test(`the mode strip stays usable at ${width}px`, async ({ page }) => {
    await open(page, width);

    const strip = page.getByRole("navigation", { name: "Application mode" });
    await expect(strip).toBeVisible();
    for (const mode of ["Compose", "Evaluations", "Runs"]) {
      await expect(strip.getByRole("button", { name: mode })).toBeVisible();
    }

    // Reachability, not just visibility: a strip that is on screen but overlaid
    // or clipped would still pass a visibility check alone.
    await openMode(page, "Evaluations");
    await expect(page.locator(".evaluation-editor")).toBeVisible();
    await openMode(page, "Compose");
    await expect(page.locator(".composer")).toBeVisible();

    const layout = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  });
}
