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
  openMode,
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
  await openMode(page, "Evaluations");
}

test("the evaluation mode shows the focused case's provider input while authoring", async ({ page }) => {
  await openEvaluations(page);
  const previewPane = page.getByRole("complementary", { name: "Provider input" });
  const preview = page.locator(".evaluation-preview-scroll");

  // The preview has its own region beside the editor now. It no longer evicts
  // the response pane to be seen, so the run output is not merely hidden behind
  // it — Compose still owns it, and this mode does not render it at all.
  await expect(previewPane.getByRole("heading", { name: "Provider input" })).toBeVisible();
  await expect(page.locator(".result")).toHaveCount(0);
  await expect(previewPane.locator(".evaluation-preview-case")).toContainText("migrations");
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
  await expect(
    page.getByRole("complementary", { name: "Provider input" })
      .locator(".evaluation-preview-case"),
  ).toContainText("replication");
  await expect(preview.getByRole("region", { name: "Provider input for replication" }))
    .toContainText("Explain database replication to engineers.");
  await expect(preview).not.toContainText("database migrations");
});

/**
 * The mode switch has to be lossless in both directions: Compose gets its
 * response pane back untouched, and returning to Evaluations finds the same
 * case still focused rather than a reset editor.
 */
test("leaving the Evaluations mode returns to the run output, and coming back keeps the case", async ({ page }) => {
  await openEvaluations(page);
  await page.locator(".evaluation-case-rail").getByRole("button", { name: "replication" }).click();
  const previewPane = page.getByRole("complementary", { name: "Provider input" });
  await expect(previewPane.locator(".evaluation-preview-case")).toContainText("replication");

  await openMode(page, "Compose");
  await expect(page.locator(".result")).toContainText("Live output");
  await expect(page.locator(".evaluation-preview-scroll")).toHaveCount(0);

  await openMode(page, "Evaluations");
  await expect(previewPane.getByRole("heading", { name: "Provider input" })).toBeVisible();
  await expect(previewPane.locator(".evaluation-preview-case")).toContainText("replication");
});
