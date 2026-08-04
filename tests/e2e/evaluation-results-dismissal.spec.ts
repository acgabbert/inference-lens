import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  addEvaluationCase,
  addEvaluationCheck,
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
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  importProject,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
  openMode,
} from "./support";

const PROJECT_NAME = "Evaluation dismissal fixture";
const PROFILE_INSTANCE_ID = "profile-instance-buffered";

/**
 * Two runnable cases whose checks both pass against the buffered fixture, so a
 * finished evaluation is reached without the run itself being the subject, and
 * "the pane re-targeted to the other case" is checkable against text only that
 * case could have produced.
 */
function runnableProject(): ProjectFile {
  let project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.4,
    },
    idSuffix: "dismissal",
    createdAt: "2026-08-03T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}} to {{audience}}." }],
    variableDefaults: { audience: "engineers" },
    idSuffix: "question",
    createdAt: "2026-08-03T12:00:01.000Z",
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
  for (const [index, value] of ["migrations", "replication"].entries()) {
    const added = addEvaluationCase(project, created.suiteId, () => `case-${index}`);
    project = updateEvaluationCase(added.project, created.suiteId, added.caseId, {
      name: value,
      values: { [input.inputId]: `database ${value}` },
    });
    project = addEvaluationCheck(
      project,
      created.suiteId,
      added.caseId,
      { kind: "contains" },
      () => `check-${index}`,
    );
    const check = project.evaluationSuites[0]!.cases[index]!.checks[0]!;
    project = updateEvaluationCheck(project, created.suiteId, added.caseId, {
      checkId: check.checkId,
      kind: "contains",
      label: "Answered by the fixture",
      value: "Buffered fixture",
    });
  }
  return project;
}

/** Maps the project's connection so the batch can start without the drawer. */
async function seedMappedProfile(page: Page, project: ProjectFile): Promise<void> {
  await seedProfile(page, {
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    instanceId: PROFILE_INSTANCE_ID,
  });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(
        mapKey,
        JSON.stringify({
          [projectId]: { profileId: "buffered", profileInstanceId: instanceId },
        }),
      );
    },
    {
      mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY,
      projectId: project.projectId,
      instanceId: PROFILE_INSTANCE_ID,
    },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
}

/**
 * Opens the suite from a project folder, so its evaluation is durable: the
 * artifacts are written to `experiments/` and reopen from run history, which is
 * what makes dismissing them navigation rather than a discard.
 */
async function openDurableProject(page: Page, project: ProjectFile): Promise<void> {
  await seedMappedProfile(page, project);
  await stubProjectDirectory(page, {
    name: "evaluation-dismissal-fixture",
    files: { "project.json": serializeProjectFile(project) },
    directories: ["traces", "experiments"],
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.locator(".brand")).toContainText(PROJECT_NAME);
  await page.locator(".project-menu").evaluate((element) => element.removeAttribute("open"));
  await openMode(page, "Evaluations");
}

/** Opens the same suite from an imported file, which has nowhere to save. */
async function openUnsavedProject(page: Page, project: ProjectFile): Promise<void> {
  await seedMappedProfile(page, project);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, PROJECT_NAME);
  await openMode(page, "Evaluations");
}

async function runEvaluation(page: Page): Promise<void> {
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("Ready to run");
  await editor.getByRole("button", { name: "Start evaluation…" }).click();
  await page.getByRole("dialog", { name: /Start “Topics”/ })
    .getByRole("button", { name: "Start 2 calls" })
    .click();
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("2 / 2 passed");
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
}

test("a finished evaluation hands the pane back to the preview, and reopens from history", async ({ page }) => {
  const project = runnableProject();
  await openDurableProject(page, project);
  await runEvaluation(page);

  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("Saved project evaluation");

  // Releasing the batch empties the Runs mode, so it also has to put the user
  // back where the batch was started rather than on a blank results surface.
  await results.getByRole("button", { name: "Back to editing" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Application mode" })
    .getByRole("button", { name: "Evaluations" }))
    .toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("complementary", { name: "Provider input" })
    .getByRole("heading", { name: "Provider input" }))
    .toBeVisible();
  await expect(page.locator(".evaluation-preview-scroll"))
    .toContainText("Explain database migrations to engineers.");

  // Dismissing a saved evaluation is navigation, not a discard: the same
  // results come back from grouped project history.
  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history…" }).click();
  await page.locator(".run-history-item.experiment")
    .filter({ hasText: "Evaluation · Topics" })
    .first()
    .click();
  await expect(page.locator(".evaluation-results-workspace")).toContainText("2 / 2 passed");
});

/**
 * The editor and the results no longer share a pane, so re-targeting the editor
 * has no layout reason to discard a finished batch — and discarding one would
 * destroy evidence on a path that never asked. This is the behaviour the mode
 * boundary replaced, so it is asserted in the negative.
 */
test("focusing another case leaves a finished evaluation intact in the Runs mode", async ({ page }) => {
  await openDurableProject(page, runnableProject());
  await runEvaluation(page);

  await openMode(page, "Evaluations");
  await page.locator(".evaluation-case-rail").getByRole("button", { name: "replication" }).click();
  await expect(page.getByRole("complementary", { name: "Provider input" })
    .locator(".evaluation-preview-case"))
    .toContainText("replication");
  await expect(page.locator(".evaluation-preview-scroll"))
    .toContainText("Explain database replication to engineers.");

  await openMode(page, "Runs");
  await expect(page.locator(".evaluation-results-workspace")).toContainText("2 / 2 passed");
});

test("dismissing an unsaved evaluation is confirmed before its runs are lost", async ({ page }) => {
  await openUnsavedProject(page, runnableProject());
  await runEvaluation(page);

  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("Unsaved session evaluation");
  await results.getByRole("button", { name: "Back to editing" }).click();

  // Nothing was written to a project folder, so clearing these is the last
  // copy: the pane is only released once the discard is confirmed.
  const confirmation = page.getByRole("dialog", { name: "Discard these evaluation results?" });
  await expect(confirmation).toContainText("cannot be reopened from run history");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(results).toContainText("2 / 2 passed");

  await results.getByRole("button", { name: "Back to editing" }).click();
  await page.getByRole("dialog", { name: "Discard these evaluation results?" })
    .getByRole("button", { name: "Discard results" })
    .click();
  await expect(page.getByRole("complementary", { name: "Provider input" })
    .getByRole("heading", { name: "Provider input" }))
    .toBeVisible();
});
