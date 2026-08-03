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
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * Two cases whose bound values differ, so "the pane follows the focused case"
 * is checkable against text that could only have come from the right one.
 */
function projectWithTwoCases(): ProjectFile {
  let project = createProjectFile({
    name: "Preview pane fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.4,
    },
    idSuffix: "preview-pane",
    createdAt: "2026-08-01T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}} to {{audience}}." }],
    variableDefaults: { audience: "engineers" },
    idSuffix: "question",
    createdAt: "2026-08-01T12:00:01.000Z",
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
      label: "Mentions database",
      value: "database",
    });
  }
  return project;
}

async function openEvaluations(page: Page, width = 1440): Promise<void> {
  await seedProfile(page, {
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    instanceId: "profile-instance-buffered",
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, projectWithTwoCases(), "Preview pane fixture");
  await page.getByRole("tab", { name: /Evaluations/ }).click();
}

test("the response pane shows the focused case's provider input while authoring", async ({ page }) => {
  await openEvaluations(page);
  const result = page.locator(".result");
  const preview = page.locator(".evaluation-preview-scroll");

  // The pane belongs to the evaluation, not to a single run: "Live output" is
  // the wrong occupant while there is nothing running.
  await expect(result.getByRole("heading", { name: "Provider input" })).toBeVisible();
  await expect(result).not.toContainText("Live output");
  await expect(result.locator(".evaluation-preview-case")).toContainText("migrations");
  await expect(preview).toContainText("Explain database migrations to engineers.");

  // Provenance and execution settings are readable without opening anything.
  await expect(
    preview.getByRole("region", { name: /^Revision provenance for / })
      .locator(".evaluation-provenance-label"),
  ).toBeVisible();
  await expect(preview.getByRole("region", { name: /^Execution settings for / }))
    .toContainText("buffered-test-model");
  await expect(preview).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

test("editing a case input updates the resolved conversation in the pane", async ({ page }) => {
  await openEvaluations(page);
  const preview = page.locator(".evaluation-preview-scroll");
  const conversation = preview.getByRole("region", { name: /^Resolved conversation for / });
  await expect(conversation).toContainText("Explain database migrations to engineers.");

  // The edit is on the left; the consequence has to appear on the right. This
  // is the whole point of moving the preview out of the case editor.
  await page.getByLabel("migrations topic").fill("schema drift");
  await expect(conversation).toContainText("Explain schema drift to engineers.");
  await expect(preview.getByRole("region", { name: /^Resolved values for / }))
    .toContainText("schema drift");
  await expect(preview).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

test("focusing another case re-targets the pane", async ({ page }) => {
  await openEvaluations(page);
  const preview = page.locator(".evaluation-preview-scroll");
  await expect(preview).toContainText("Explain database migrations to engineers.");

  await page.locator(".evaluation-case-rail").getByRole("button", { name: "replication" }).click();
  await expect(page.locator(".result .evaluation-preview-case")).toContainText("replication");
  await expect(preview.getByRole("region", { name: "Provider input for replication" }))
    .toContainText("Explain database replication to engineers.");
  await expect(preview).not.toContainText("database migrations");
});

test("leaving the Evaluations tab returns the pane to the run output", async ({ page }) => {
  await openEvaluations(page);
  await expect(page.locator(".result").getByRole("heading", { name: "Provider input" }))
    .toBeVisible();

  await page.getByRole("tab", { name: /Messages/ }).click();
  await expect(page.locator(".result")).toContainText("Live output");
  await expect(page.locator(".evaluation-preview-scroll")).toHaveCount(0);

  await page.getByRole("tab", { name: /Evaluations/ }).click();
  await expect(page.locator(".result").getByRole("heading", { name: "Provider input" }))
    .toBeVisible();
});
